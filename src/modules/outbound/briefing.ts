/**
 * The morning briefing (spec §4.43.10, playbook-v6 F6/3): the first thing
 * Fanni reads. Factual and short — what is waiting, what dropped and why,
 * where the registry quota stands, which segments are running dry, and why
 * any product missed its target.
 */
import type { CandidateReason, SourcingHint } from "@prisma/client";
import type { WorkspaceClient } from "@/lib/db";
import { quotaMeter } from "@/modules/registry/registry-service";
import { REASON_LABEL } from "./run-store";
import { parseCounters } from "./run-engine";
import { stringArray } from "./catalog";

export interface Briefing {
  active: boolean;
  pending: { total: number; byProduct: Array<{ name: string; n: number }> };
  linkedIn: number;
  lastNight: { date: string; runs: number } | null;
  dropped: { total: number; byReason: Array<{ reason: CandidateReason; label: string; n: number }> };
  quota: { used: number; limit: number; month: string };
  exhausted: Array<{ profile: string; product: string; segments: string[]; suggestion: string }>;
  missed: Array<{ product: string; profile: string; wanted: number; got: number; why: string }>;
}

export function exhaustionSuggestion(hints: SourcingHint[]): string {
  if (hints.includes("NAME_HARVEST_WEAK")) {
    return "These segments are fantasy-named: switch them to a seed list or a Google Places search rather than adding fragments.";
  }
  if (hints.includes("SEED_LIST")) return "Extend the seed list — finite segments do not refill by harvesting.";
  if (hints.includes("PLACES")) return "Run a Prospector search for these segments and add the results to the pool.";
  return "Add name fragments, widen the size band, or add a neighbouring county.";
}

export async function buildBriefing(db: WorkspaceClient, workspaceId: string, now: Date = new Date()): Promise<Briefing> {
  const productCount = await db.product.count({ where: { status: "ACTIVE" } });
  const [pending, products, linkedIn, meter] = await Promise.all([
    db.outreachDraft.groupBy({ by: ["productId"], where: { status: "PENDING" }, _count: { _all: true } }),
    db.product.findMany({ select: { id: true, name: true } }),
    db.prospectCandidate.count({ where: { state: "LINKEDIN_QUEUE", leadId: null } }),
    quotaMeter(workspaceId, now),
  ]);
  const name = (id: string | null) => products.find((p) => p.id === id)?.name ?? "—";

  const latest = await db.sourcingRun.findFirst({ where: { trigger: "NIGHTLY", runDate: { not: null } }, orderBy: { startedAt: "desc" }, select: { runDate: true } });
  const runs = latest?.runDate ? await db.sourcingRun.findMany({ where: { trigger: "NIGHTLY", runDate: latest.runDate } }) : [];

  const reasonTotals = new Map<CandidateReason, number>();
  const exhausted: Briefing["exhausted"] = [];
  const missed: Briefing["missed"] = [];
  const profiles = runs.length
    ? await db.icpProfile.findMany({ where: { id: { in: runs.map((r) => r.profileId).filter((x): x is string => !!x) } } })
    : [];
  const segments = await db.segment.findMany({ select: { key: true, name: true, sourcingHint: true } });

  for (const r of runs) {
    const c = parseCounters(r.counters);
    for (const [reason, n] of Object.entries(c.byReason)) {
      reasonTotals.set(reason as CandidateReason, (reasonTotals.get(reason as CandidateReason) ?? 0) + (n ?? 0));
    }
    const profile = profiles.find((p) => p.id === r.profileId);
    const qualified = ["CONTACT_RESOLVED", "DRAFTED", "PENDING_APPROVAL", "APPROVED", "SENT", "REPLIED"].reduce(
      (s, k) => s + (c.byState[k as keyof typeof c.byState] ?? 0),
      0,
    );
    if (c.poolExhausted && profile) {
      const segs = segments.filter((s) => stringArray(profile.segmentKeys).includes(s.key));
      exhausted.push({
        profile: profile.name,
        product: name(r.productId),
        segments: segs.map((s) => s.name),
        suggestion: exhaustionSuggestion(segs.map((s) => s.sourcingHint)),
      });
    }
    if (qualified < r.requested && r.status !== "RUNNING" && r.status !== "AWAITING_AUDITS") {
      missed.push({
        product: name(r.productId),
        profile: profile?.name ?? "—",
        wanted: r.requested,
        got: qualified,
        why: r.status === "PAUSED_QUOTA" ? "the day's registry allocation ran out — it resumes tonight" : r.message ?? "the remaining candidates did not qualify",
      });
    }
  }

  return {
    active: productCount > 0,
    pending: {
      total: pending.reduce((s, p) => s + p._count._all, 0),
      byProduct: pending.map((p) => ({ name: name(p.productId), n: p._count._all })).sort((a, b) => b.n - a.n),
    },
    linkedIn,
    lastNight: latest?.runDate ? { date: latest.runDate, runs: runs.length } : null,
    dropped: {
      total: [...reasonTotals.values()].reduce((s, n) => s + n, 0),
      byReason: [...reasonTotals.entries()]
        .map(([reason, n]) => ({ reason, label: REASON_LABEL[reason], n }))
        .sort((a, b) => b.n - a.n),
    },
    quota: { used: meter.usedMonth, limit: meter.limit, month: meter.month },
    exhausted,
    missed,
  };
}

/** The briefing as two digest lines — the Monday email's first section. */
export function briefingDigestLines(b: Briefing): Array<{ key: string; label: string; value: string }> {
  if (!b.active) return [];
  const lines = [
    {
      key: "outbound_pending",
      label: "Outbound waiting for approval",
      value: b.pending.total ? `${b.pending.total} (${b.pending.byProduct.map((p) => `${p.name} ${p.n}`).join(", ")})` : "none",
    },
    { key: "outbound_quota", label: "Registry datasheets this month", value: `${b.quota.used} / ${b.quota.limit}` },
  ];
  if (b.dropped.total) {
    lines.push({ key: "outbound_dropped", label: "Dropped last night", value: b.dropped.byReason.slice(0, 3).map((r) => `${r.n} ${r.label}`).join(", ") });
  }
  if (b.exhausted.length) lines.push({ key: "outbound_exhausted", label: "Segments running dry", value: b.exhausted.flatMap((e) => e.segments).join(", ") });
  return lines;
}
