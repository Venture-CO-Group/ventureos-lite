/**
 * The nightly fill (spec §4.43.10, playbook-v6 F6/1–2).
 *
 * The goal is a queue held AT target, never stacked: each product is topped
 * up by the difference between its quota and the drafts still waiting from
 * earlier nights, and the whole workspace never holds more than its daily cap
 * in the queue. So twelve unreviewed drafts against a target of fifteen
 * produce exactly three, and a Monday morning does not open on eighty.
 *
 * Allocation is by product priority. A profile whose pool is empty gets
 * nothing tonight (its harvest is scheduled instead), and what it would have
 * had goes to the next product that still has need.
 */
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { parseOutboundConfig, workspaceDailyCap, type OutboundConfig } from "./config";
import { localClock } from "./send-rules";
import { toProfileView } from "./catalog";
import { eligiblePool } from "./run-engine";
import { createRun } from "./run-store";
import { enqueueRunPass } from "./run-jobs";

export interface PlanProfile {
  id: string;
  quota: number;
  weight: number;
  active: boolean;
  /** Pool rows a run could draw from tonight. */
  eligible: number;
}

export interface PlanProduct {
  id: string;
  priority: number;
  profiles: PlanProfile[];
}

export interface NightPlan {
  allocations: Array<{ productId: string; profileId: string; requested: number }>;
  /** Profiles that would have had work but whose pool is empty. */
  exhausted: string[];
  /** Per product: target, waiting, need, given. */
  products: Array<{ productId: string; target: number; pending: number; need: number; given: number }>;
  cap: number;
  pendingTotal: number;
}

/** Split `n` across profiles by weight, largest remainder, never above a profile's quota. */
function split(n: number, profiles: PlanProfile[]): Map<string, number> {
  const out = new Map<string, number>();
  let left = n;
  let open = profiles.filter((p) => p.quota > 0);
  while (left > 0 && open.length > 0) {
    const w = open.reduce((s, p) => s + p.weight, 0);
    const shares = open.map((p) => ({ p, exact: (left * p.weight) / w }));
    let handed = 0;
    for (const s of shares) {
      const room = s.p.quota - (out.get(s.p.id) ?? 0);
      const give = Math.min(room, Math.floor(s.exact));
      out.set(s.p.id, (out.get(s.p.id) ?? 0) + give);
      handed += give;
    }
    // Hand out the remainder one by one, biggest fractional part first.
    const byFraction = [...shares].sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)));
    for (const s of byFraction) {
      if (handed >= left) break;
      if ((out.get(s.p.id) ?? 0) < s.p.quota) {
        out.set(s.p.id, (out.get(s.p.id) ?? 0) + 1);
        handed++;
      }
    }
    if (handed === 0) break;
    left -= handed;
    open = open.filter((p) => (out.get(p.id) ?? 0) < p.quota);
  }
  return out;
}

export function planNight(input: {
  products: PlanProduct[];
  pendingByProduct: ReadonlyMap<string, number>;
  cap: number;
}): NightPlan {
  const pendingTotal = [...input.pendingByProduct.values()].reduce((s, n) => s + n, 0);
  let room = Math.max(0, input.cap - pendingTotal);
  const allocations: NightPlan["allocations"] = [];
  const exhausted: string[] = [];
  const summary: NightPlan["products"] = [];

  const ordered = [...input.products].sort((a, b) => b.priority - a.priority);
  const unmet: Array<{ product: PlanProduct; need: number }> = [];

  const giveTo = (product: PlanProduct, want: number): number => {
    const usable = product.profiles.filter((p) => p.active && p.quota > 0 && p.eligible > 0);
    for (const p of product.profiles) if (p.active && p.quota > 0 && p.eligible === 0 && !exhausted.includes(p.id)) exhausted.push(p.id);
    const give = Math.min(want, room, usable.reduce((s, p) => s + Math.min(p.quota, p.eligible), 0));
    if (give <= 0) return 0;
    const shares = split(
      give,
      usable.map((p) => ({ ...p, quota: Math.min(p.quota, p.eligible) })),
    );
    let given = 0;
    for (const [profileId, n] of shares) {
      if (n <= 0) continue;
      const existing = allocations.find((a) => a.profileId === profileId);
      if (existing) existing.requested += n;
      else allocations.push({ productId: product.id, profileId, requested: n });
      given += n;
    }
    room -= given;
    return given;
  };

  for (const product of ordered) {
    const target = product.profiles.filter((p) => p.active).reduce((s, p) => s + p.quota, 0);
    const pending = input.pendingByProduct.get(product.id) ?? 0;
    const need = Math.max(0, target - pending);
    const given = giveTo(product, need);
    summary.push({ productId: product.id, target, pending, need, given });
    if (given < need) unmet.push({ product, need: need - given });
  }
  // Second pass: whatever an exhausted product left on the table goes to the
  // next product, in priority order, that still has need.
  for (const u of unmet) {
    if (room <= 0) break;
    const extra = giveTo(u.product, u.need);
    const row = summary.find((s) => s.productId === u.product.id);
    if (row) row.given += extra;
  }
  return { allocations, exhausted, products: summary, cap: input.cap, pendingTotal };
}

/** Is it time for tonight's run in this workspace, and has it not run yet? */
export function nightlyDue(cfg: OutboundConfig, now: Date): { due: boolean; localDate: string } {
  const clock = localClock(now, cfg.schedule.timezone);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: cfg.schedule.timezone, minute: "2-digit" }).formatToParts(now);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const afterStart = clock.hour > cfg.schedule.hour || (clock.hour === cfg.schedule.hour && minute >= cfg.schedule.minute);
  const due = cfg.schedule.enabled && cfg.schedule.days.includes(clock.weekday) && afterStart && cfg.schedule.lastRunDate !== clock.date;
  return { due, localDate: clock.date };
}

export interface NightResult {
  workspaceId: string;
  localDate: string;
  plan: NightPlan;
  runIds: string[];
  resumed: number;
}

/** Plan and start tonight's runs for one workspace. Idempotent per local date. */
export async function runNightFor(workspaceId: string, now: Date, opts: { enqueue?: boolean } = {}): Promise<NightResult | null> {
  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { outboundConfig: true } });
  const cfg = parseOutboundConfig(ws?.outboundConfig);
  const { due, localDate } = nightlyDue(cfg, now);
  if (!due) return null;
  const db = getWorkspaceClient(workspaceId);

  // Claim the night before doing anything: the date is stored first, and a
  // night that already has runs is never planned twice — a retried job or a
  // restarted worker finds one of the two and stops.
  if ((await db.sourcingRun.count({ where: { trigger: "NIGHTLY", runDate: localDate } })) > 0) return null;
  await prismaUnsafe.workspace.update({
    where: { id: workspaceId },
    data: {
      outboundConfig: {
        ...cfg,
        schedule: { ...cfg.schedule, lastRunDate: localDate },
        cap: { ...cfg.cap, startedAt: cfg.cap.startedAt ?? now.toISOString() },
      },
    },
  });

  const products = await db.product.findMany({ where: { status: "ACTIVE" }, include: { profiles: true } });
  const plan: PlanProduct[] = [];
  for (const p of products) {
    const profiles: PlanProfile[] = [];
    for (const row of p.profiles) {
      const v = toProfileView(row);
      const eligible = v.active && v.dailyQuota > 0 ? (await eligiblePool(db, v, "all", now)).length : 0;
      profiles.push({ id: v.id, quota: v.dailyQuota, weight: v.weight, active: v.active, eligible });
    }
    plan.push({ id: p.id, priority: p.priority, profiles });
  }
  const pending = await db.outreachDraft.groupBy({ by: ["productId"], where: { status: "PENDING", step: 0 }, _count: { _all: true } });
  const pendingByProduct = new Map(pending.filter((x) => x.productId).map((x) => [x.productId!, x._count._all]));
  const nightPlan = planNight({ products: plan, pendingByProduct, cap: workspaceDailyCap(cfg.cap, now) });

  const runIds: string[] = [];
  for (const a of nightPlan.allocations) {
    const run = await createRun(db, workspaceId, { profileId: a.profileId, requested: a.requested, channel: "all", trigger: "NIGHTLY", runDate: localDate });
    runIds.push(run.id);
  }
  // An exhausted profile gets a run whose first pass harvests its segments.
  // It may fill whatever room the plan could not give anyone else — on a
  // fresh install every pool is empty, and a first night that asked for
  // nothing would teach nobody anything.
  let room = Math.max(0, nightPlan.cap - nightPlan.pendingTotal - nightPlan.allocations.reduce((s, a) => s + a.requested, 0));
  for (const profileId of nightPlan.exhausted) {
    const quota = plan.flatMap((p) => p.profiles).find((p) => p.id === profileId)?.quota ?? 1;
    const take = Math.min(quota, room);
    room -= take;
    const run = await createRun(db, workspaceId, { profileId, requested: Math.max(1, take), channel: "all", trigger: "NIGHTLY", runDate: localDate });
    runIds.push(run.id);
  }
  // Runs paused on yesterday's quota resume tonight.
  const paused = await db.sourcingRun.findMany({ where: { status: "PAUSED_QUOTA" }, select: { id: true } });
  if (opts.enqueue !== false) {
    for (const id of [...runIds, ...paused.map((p) => p.id)]) await enqueueRunPass({ workspaceId, runId: id });
  }
  return { workspaceId, localDate, plan: nightPlan, runIds, resumed: paused.length };
}

export async function processNightlySweep(now: Date = new Date()): Promise<NightResult[]> {
  const workspaces = await prismaUnsafe.workspace.findMany({ select: { id: true, outboundConfig: true } });
  const out: NightResult[] = [];
  for (const w of workspaces) {
    if (!parseOutboundConfig(w.outboundConfig).schedule.enabled) continue;
    try {
      const r = await runNightFor(w.id, now);
      if (r) out.push(r);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[outbound] nightly fill failed for ${w.id}`, e);
    }
  }
  return out;
}
