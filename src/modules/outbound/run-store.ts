/**
 * Runs and the pool, session-free (playbook-v6 F3/8). The server actions
 * beside this add the session and the permission check; tests and the
 * nightly scheduler call these directly.
 */
import type { CandidateReason, CandidateState, Prisma, RunTrigger } from "@prisma/client";
import type { WorkspaceClient } from "@/lib/db";
import { quotaMeter } from "@/modules/registry/registry-service";
import { estimateShare } from "@/modules/registry/quota";
import { toProfileView } from "./catalog";
import { eligiblePool, parseCounters, type RunCounters } from "./run-engine";

const PREFILTER_REASONS: CandidateReason[] = ["IN_CRM", "SUPPRESSED", "RECENTLY_FILTERED", "NO_TAX_NUMBER"];
/** Until a profile has history, assume about a third of enriched companies qualify. */
export const DEFAULT_PASS_RATE = 0.35;

export interface RunEstimate {
  eligible: number;
  passRate: number;
  passRateFromHistory: boolean;
  expectedLookups: number;
  monthShare: number;
  remainingToday: number;
  monthRemaining: number;
  /** The run will stop for the day before it is done. */
  exceedsToday: boolean;
}

/**
 * What a run will cost before it starts (spec §4.43.4): pool size, expected
 * detail lookups, and their share of the month. An upper bound — cached
 * datasheets make the real spend smaller.
 */
export async function estimateRunCost(
  db: WorkspaceClient,
  workspaceId: string,
  input: { profileId: string; requested: number; channel: string },
  now: Date = new Date(),
): Promise<RunEstimate | null> {
  const profileRow = await db.icpProfile.findUnique({ where: { id: input.profileId } });
  if (!profileRow) return null;
  const profile = toProfileView(profileRow);
  const pool = await eligiblePool(db, profile, input.channel, now);

  const [qualifiedEver, enrichedEver] = await Promise.all([
    db.prospectCandidate.count({
      where: { profileId: profile.id, state: { in: ["FILTERED_IN", "AUDITED", "CONTACT_RESOLVED", "DRAFTED", "PENDING_APPROVAL", "APPROVED", "SENT", "REPLIED", "LINKEDIN_QUEUE"] } },
    }),
    db.prospectCandidate.count({
      where: {
        profileId: profile.id,
        state: { not: "SOURCED" },
        OR: [{ reason: null }, { reason: { notIn: PREFILTER_REASONS } }],
      },
    }),
  ]);
  const fromHistory = enrichedEver >= 20;
  const passRate = fromHistory ? Math.max(0.02, qualifiedEver / enrichedEver) : DEFAULT_PASS_RATE;
  const expectedLookups = Math.min(pool.length, Math.ceil(input.requested / passRate));
  const meter = await quotaMeter(workspaceId, now);
  return {
    eligible: pool.length,
    passRate: Math.round(passRate * 100) / 100,
    passRateFromHistory: fromHistory,
    expectedLookups,
    monthShare: estimateShare(expectedLookups, meter.limit),
    remainingToday: meter.batchRemainingToday,
    monthRemaining: meter.monthRemaining,
    exceedsToday: expectedLookups > meter.batchRemainingToday,
  };
}

export async function createRun(
  db: WorkspaceClient,
  workspaceId: string,
  input: {
    profileId: string;
    requested: number;
    channel: string;
    trigger: RunTrigger;
    estimate?: RunEstimate | null;
    startedById?: string | null;
    runDate?: string | null;
  },
): Promise<{ id: string }> {
  const profile = await db.icpProfile.findUnique({ where: { id: input.profileId }, select: { productId: true } });
  return db.sourcingRun.create({
    data: {
      workspaceId,
      productId: profile?.productId ?? null,
      profileId: input.profileId,
      trigger: input.trigger,
      channel: input.channel,
      requested: input.requested,
      estimate: (input.estimate ?? null) as unknown as Prisma.InputJsonValue,
      startedById: input.startedById ?? null,
      runDate: input.runDate ?? null,
    },
    select: { id: true },
  });
}

// ---- views ---------------------------------------------------------------------

export interface RunRow {
  id: string;
  productName: string | null;
  profileName: string | null;
  trigger: RunTrigger;
  channel: string;
  requested: number;
  status: string;
  quotaUsed: number;
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
  counters: RunCounters;
}

export async function listRuns(db: WorkspaceClient, take = 30): Promise<RunRow[]> {
  const runs = await db.sourcingRun.findMany({ orderBy: { startedAt: "desc" }, take });
  const profileIds = [...new Set(runs.map((r) => r.profileId).filter((x): x is string => !!x))];
  const profiles = profileIds.length
    ? await db.icpProfile.findMany({ where: { id: { in: profileIds } }, select: { id: true, name: true, product: { select: { name: true } } } })
    : [];
  return runs.map((r) => {
    const p = profiles.find((x) => x.id === r.profileId);
    return {
      id: r.id,
      productName: p?.product.name ?? null,
      profileName: p?.name ?? null,
      trigger: r.trigger,
      channel: r.channel,
      requested: r.requested,
      status: r.status,
      quotaUsed: r.quotaUsed,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      message: r.message,
      counters: parseCounters(r.counters),
    };
  });
}

/** The funnel, in the order the spec draws it (playbook-v6 F3/8). */
export const FUNNEL: Array<{ label: string; states: CandidateState[] }> = [
  { label: "Sourced", states: [] },
  { label: "Past the free pre-filter", states: [] },
  { label: "Enriched", states: [] },
  { label: "Filtered in", states: ["FILTERED_IN", "AUDITED", "CONTACT_RESOLVED", "DRAFTED", "PENDING_APPROVAL", "APPROVED", "SENT", "REPLIED", "LINKEDIN_QUEUE"] },
  { label: "Audited", states: ["AUDITED", "CONTACT_RESOLVED", "DRAFTED", "PENDING_APPROVAL", "APPROVED", "SENT", "REPLIED", "LINKEDIN_QUEUE"] },
  { label: "Contact resolved", states: ["CONTACT_RESOLVED", "DRAFTED", "PENDING_APPROVAL", "APPROVED", "SENT", "REPLIED"] },
];

export interface FunnelStep {
  label: string;
  count: number;
}

export function funnelFrom(c: RunCounters): FunnelStep[] {
  const sum = (states: CandidateState[]) => states.reduce((n, s) => n + (c.byState[s] ?? 0), 0);
  const prefiltered = PREFILTER_REASONS.reduce((n, r) => n + (c.byReason[r] ?? 0), 0);
  const notInRegistry = c.byReason.NOT_IN_REGISTRY ?? 0;
  const waiting = c.byState.SOURCED ?? 0;
  return [
    { label: "Sourced", count: c.total },
    { label: "Past the free pre-filter", count: c.total - prefiltered },
    { label: "Enriched", count: c.total - prefiltered - notInRegistry - waiting },
    ...FUNNEL.slice(3).map((f) => ({ label: f.label, count: sum(f.states) })),
  ];
}

export interface RunDetail extends RunRow {
  funnel: FunnelStep[];
  reasons: Array<{ reason: CandidateReason; count: number; examples: string[] }>;
  candidates: Array<{
    id: string;
    name: string;
    state: CandidateState;
    reason: CandidateReason | null;
    reasonDetail: string | null;
    priority: number;
    parked: boolean;
  }>;
}

export async function loadRunDetail(db: WorkspaceClient, runId: string, now: Date = new Date()): Promise<RunDetail | null> {
  const [row] = (await listRuns(db, 200)).filter((r) => r.id === runId);
  if (!row) return null;
  const cands = await db.prospectCandidate.findMany({
    where: { runId },
    orderBy: [{ priority: "desc" }],
    take: 300,
    select: { id: true, name: true, state: true, reason: true, reasonDetail: true, priority: true, parkedUntil: true },
  });
  const byReason = new Map<CandidateReason, string[]>();
  for (const c of cands) {
    if (!c.reason) continue;
    const list = byReason.get(c.reason) ?? [];
    if (list.length < 3 && c.reasonDetail) list.push(`${c.name}: ${c.reasonDetail}`);
    byReason.set(c.reason, list);
  }
  return {
    ...row,
    funnel: funnelFrom(row.counters),
    reasons: Object.entries(row.counters.byReason)
      .map(([reason, count]) => ({
        reason: reason as CandidateReason,
        count: count ?? 0,
        examples: byReason.get(reason as CandidateReason) ?? [],
      }))
      .sort((a, b) => b.count - a.count),
    candidates: cands.map((c) => ({
      id: c.id,
      name: c.name,
      state: c.state,
      reason: c.reason,
      reasonDetail: c.reasonDetail,
      priority: c.priority,
      parked: !!c.parkedUntil && c.parkedUntil > now,
    })),
  };
}

export const REASON_LABEL: Record<CandidateReason, string> = {
  IN_CRM: "already in the CRM",
  SUPPRESSED: "suppressed",
  RECENTLY_FILTERED: "refused recently",
  NOT_IN_REGISTRY: "not in the registry",
  NO_TAX_NUMBER: "no tax number",
  STATUS: "registry status",
  SEGMENT: "outside the segments",
  SIZE: "size",
  REVENUE: "revenue",
  REGION: "region",
  LEGAL_FORM: "legal form",
  FOUNDED: "founding year",
  NO_WEBSITE: "no website",
  EXISTING_CLIENT: "existing client",
  AUDIT_SCORE: "audit score",
  SIGNALS: "missing signals",
  NO_NAMED_CONTACT: "no named contact",
  NO_HOOK: "no company-specific hook",
  WRONG_TARGETING: "wrong targeting",
  WEAK_COPY: "weak copy",
  WRONG_CONTACT: "wrong contact",
  BAD_TIMING: "bad timing",
  ALREADY_IN_CONTACT: "already in contact",
  OTHER: "other",
};
