/**
 * Measuring the motor (spec §4.43.10, playbook-v6 F6/4–5).
 *
 * Two numbers matter most and are computed first-class:
 *
 *   - the APPROVAL RATE — approved ÷ (approved + rejected). It measures the
 *     targeting: a low rate means the profile or the source is wrong, not the
 *     copy;
 *   - the REJECTION-REASON DISTRIBUTION — "wrong targeting" dominating points
 *     at sourcing, "weak copy" at the templates.
 *
 * Plus the funnel, fragment yields (which name fragments find companies that
 * get approved) and cost per meeting per product. All of it arithmetic over
 * stored rows — no model is asked to count.
 */
import type { CandidateReason, CandidateState } from "@prisma/client";
import type { WorkspaceClient } from "@/lib/db";
import { quotaMonth } from "@/modules/registry/quota";

export interface FragmentYield {
  fragment: string;
  sourced: number;
  approved: number;
}

const PREFILTER: CandidateReason[] = ["IN_CRM", "SUPPRESSED", "RECENTLY_FILTERED", "NO_TAX_NUMBER"];
/** Reasons a candidate can only have after passing the local ICP filter. */
const POST_FILTER: CandidateReason[] = ["AUDIT_SCORE", "SIGNALS", "NO_NAMED_CONTACT", "NO_HOOK"];
const QUALIFIED: CandidateState[] = ["FILTERED_IN", "AUDITED", "CONTACT_RESOLVED", "DRAFTED", "PENDING_APPROVAL", "APPROVED", "SENT", "REPLIED", "LINKEDIN_QUEUE"];
const APPROVED: CandidateState[] = ["APPROVED", "SENT", "REPLIED"];
export const REVIEW_REASON_LIST: CandidateReason[] = ["WRONG_TARGETING", "WEAK_COPY", "WRONG_CONTACT", "BAD_TIMING", "ALREADY_IN_CONTACT", "OTHER"];

export interface FunnelRow {
  productId: string | null;
  productName: string;
  profileId: string | null;
  profileName: string | null;
  sourced: number;
  prefiltered: number;
  enriched: number;
  qualified: number;
  drafted: number;
  approved: number;
  rejected: number;
  sent: number;
  replied: number;
  meetings: number;
  approvalRate: number | null;
  rejectionReasons: Partial<Record<CandidateReason, number>>;
}

interface CandidateLite {
  id: string;
  productId: string | null;
  profileId: string | null;
  state: CandidateState;
  reason: CandidateReason | null;
  leadId: string | null;
}

/** Pure: one funnel row from a set of candidates and what we know about them. */
export function funnelFor(
  cands: readonly CandidateLite[],
  drafted: ReadonlySet<string>,
  meetings: ReadonlySet<string>,
): Omit<FunnelRow, "productId" | "productName" | "profileId" | "profileName"> {
  const count = (f: (c: CandidateLite) => boolean) => cands.filter(f).length;
  const prefiltered = count((c) => c.state === "FILTERED_OUT" && !!c.reason && PREFILTER.includes(c.reason));
  const notFound = count((c) => c.reason === "NOT_IN_REGISTRY");
  const waiting = count((c) => c.state === "SOURCED");
  const approved = count((c) => APPROVED.includes(c.state));
  const rejected = count((c) => c.state === "REJECTED");
  const reasons: Partial<Record<CandidateReason, number>> = {};
  for (const c of cands) if (c.state === "REJECTED" && c.reason) reasons[c.reason] = (reasons[c.reason] ?? 0) + 1;
  return {
    sourced: cands.length,
    prefiltered,
    enriched: cands.length - prefiltered - notFound - waiting,
    qualified: count((c) => QUALIFIED.includes(c.state) || (c.state === "FILTERED_OUT" && !!c.reason && POST_FILTER.includes(c.reason))),
    drafted: count((c) => drafted.has(c.id)),
    approved,
    rejected,
    sent: count((c) => c.state === "SENT" || c.state === "REPLIED"),
    replied: count((c) => c.state === "REPLIED"),
    meetings: count((c) => !!c.leadId && meetings.has(c.leadId)),
    approvalRate: approved + rejected > 0 ? approved / (approved + rejected) : null,
    rejectionReasons: reasons,
  };
}

async function meetingLeads(db: WorkspaceClient, leadIds: string[]): Promise<Set<string>> {
  if (leadIds.length === 0) return new Set();
  const [meetings, staged] = await Promise.all([
    db.meeting.findMany({ where: { leadId: { in: leadIds } }, select: { leadId: true } }),
    db.lead.findMany({ where: { id: { in: leadIds }, stage: { in: ["MEETING_BOOKED", "HANDED_OFF"] } }, select: { id: true } }),
  ]);
  return new Set([...meetings.map((m) => m.leadId).filter((x): x is string => !!x), ...staged.map((l) => l.id)]);
}

export async function outboundFunnel(db: WorkspaceClient, since: Date | null = null): Promise<{ products: FunnelRow[]; profiles: FunnelRow[]; total: FunnelRow }> {
  const cands = await db.prospectCandidate.findMany({
    where: since ? { createdAt: { gte: since } } : {},
    select: { id: true, productId: true, profileId: true, state: true, reason: true, leadId: true },
  });
  const [drafts, products, profiles, meetings] = await Promise.all([
    db.outreachDraft.findMany({ where: { step: 0, candidateId: { in: cands.map((c) => c.id) } }, select: { candidateId: true } }),
    db.product.findMany({ select: { id: true, name: true } }),
    db.icpProfile.findMany({ select: { id: true, name: true, productId: true } }),
    meetingLeads(db, cands.map((c) => c.leadId).filter((x): x is string => !!x)),
  ]);
  const drafted = new Set(drafts.map((d) => d.candidateId));
  const productName = (id: string | null) => products.find((p) => p.id === id)?.name ?? "—";
  const byProduct = new Map<string | null, CandidateLite[]>();
  const byProfile = new Map<string | null, CandidateLite[]>();
  for (const c of cands) {
    byProduct.set(c.productId, [...(byProduct.get(c.productId) ?? []), c]);
    byProfile.set(c.profileId, [...(byProfile.get(c.profileId) ?? []), c]);
  }
  return {
    products: [...byProduct.entries()].map(([id, list]) => ({
      productId: id,
      productName: productName(id),
      profileId: null,
      profileName: null,
      ...funnelFor(list, drafted, meetings),
    })),
    profiles: [...byProfile.entries()].map(([id, list]) => {
      const p = profiles.find((x) => x.id === id);
      return { productId: p?.productId ?? null, productName: productName(p?.productId ?? null), profileId: id, profileName: p?.name ?? "deleted profile", ...funnelFor(list, drafted, meetings) };
    }),
    total: { productId: null, productName: "All products", profileId: null, profileName: null, ...funnelFor(cands, drafted, meetings) },
  };
}

// ---- fragments -------------------------------------------------------------------

/** Per segment, per fragment: companies the fragment found, and how many were approved. */
export async function fragmentYields(db: WorkspaceClient): Promise<Record<string, FragmentYield[]>> {
  const pool = await db.candidatePool.findMany({ where: { source: "NAME_HARVEST" }, select: { id: true, hits: true }, take: 50_000 });
  const approvedPools = new Set(
    (await db.prospectCandidate.findMany({ where: { state: { in: APPROVED } }, select: { poolId: true } })).map((c) => c.poolId),
  );
  const decidedPools = new Map<string, boolean>();
  for (const c of await db.prospectCandidate.findMany({ where: { state: { in: [...APPROVED, "REJECTED"] } }, select: { poolId: true, state: true } })) {
    decidedPools.set(c.poolId, decidedPools.get(c.poolId) || c.state !== "REJECTED");
  }
  const out: Record<string, Map<string, FragmentYield & { decided: number }>> = {};
  for (const row of pool) {
    const hits = Array.isArray(row.hits) ? (row.hits as Array<{ segment?: string; fragment?: string }>) : [];
    for (const h of hits) {
      if (!h.segment || !h.fragment) continue;
      const seg = (out[h.segment] ??= new Map());
      const y = seg.get(h.fragment) ?? { fragment: h.fragment, sourced: 0, approved: 0, decided: 0 };
      y.sourced++;
      if (approvedPools.has(row.id)) y.approved++;
      if (decidedPools.has(row.id)) y.decided++;
      seg.set(h.fragment, y);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, m]) => [k, [...m.values()]]));
}

/**
 * Fragments to propose retiring: at least 20 decided candidates and not one
 * approved. Arithmetic, n ≥ 20 like every Signal Engine proposal; an Owner
 * decides.
 */
export async function fragmentRetirementCandidates(
  db: WorkspaceClient,
): Promise<Array<{ segmentKey: string; fragment: string; sourced: number; decided: number }>> {
  const pool = await db.candidatePool.findMany({ where: { source: "NAME_HARVEST" }, select: { id: true, hits: true }, take: 50_000 });
  const decided = await db.prospectCandidate.findMany({ where: { state: { in: [...APPROVED, "REJECTED"] } }, select: { poolId: true, state: true } });
  const byPool = new Map<string, { decided: number; approved: number }>();
  for (const d of decided) {
    const t = byPool.get(d.poolId) ?? { decided: 0, approved: 0 };
    t.decided++;
    if (d.state !== "REJECTED") t.approved++;
    byPool.set(d.poolId, t);
  }
  const tally = new Map<string, { segmentKey: string; fragment: string; sourced: number; decided: number; approved: number }>();
  for (const row of pool) {
    const hits = Array.isArray(row.hits) ? (row.hits as Array<{ segment?: string; fragment?: string }>) : [];
    const t = byPool.get(row.id);
    for (const h of hits) {
      if (!h.segment || !h.fragment) continue;
      const key = `${h.segment}|${h.fragment}`;
      const y = tally.get(key) ?? { segmentKey: h.segment, fragment: h.fragment, sourced: 0, decided: 0, approved: 0 };
      y.sourced++;
      y.decided += t?.decided ?? 0;
      y.approved += t?.approved ?? 0;
      tally.set(key, y);
    }
  }
  return [...tally.values()].filter((y) => y.decided >= 20 && y.approved === 0).map(({ approved: _a, ...rest }) => rest);
}

// ---- cost ----------------------------------------------------------------------------

export interface ProductCost {
  productId: string | null;
  productName: string;
  month: string;
  registryLookups: number;
  claudeUsd: number;
  meetings: number;
  /** Null until there is a meeting to divide by. */
  claudeUsdPerMeeting: number | null;
  lookupsPerMeeting: number | null;
}

/** Per product, for one month: what it spent and what it brought (spec §4.43.10/5). */
export async function costReport(db: WorkspaceClient, at: Date = new Date()): Promise<ProductCost[]> {
  const month = quotaMonth(at);
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  const [ledger, drafts, products, cands] = await Promise.all([
    db.registryQuotaLedger.findMany({ where: { month, cacheHit: false, candidateId: { not: null } }, select: { candidateId: true } }),
    db.outreachDraft.findMany({ where: { createdAt: { gte: start, lt: end } }, select: { productId: true, claudeCostUsd: true } }),
    db.product.findMany({ select: { id: true, name: true } }),
    db.prospectCandidate.findMany({ select: { id: true, productId: true, leadId: true } }),
  ]);
  const productOf = new Map(cands.map((c) => [c.id, c.productId]));
  const meetings = await meetingLeads(db, cands.map((c) => c.leadId).filter((x): x is string => !!x));
  const rows = new Map<string | null, ProductCost>();
  const row = (id: string | null) => {
    let r = rows.get(id);
    if (!r) {
      r = { productId: id, productName: products.find((p) => p.id === id)?.name ?? "—", month, registryLookups: 0, claudeUsd: 0, meetings: 0, claudeUsdPerMeeting: null, lookupsPerMeeting: null };
      rows.set(id, r);
    }
    return r;
  };
  for (const l of ledger) row(productOf.get(l.candidateId!) ?? null).registryLookups++;
  for (const d of drafts) row(d.productId).claudeUsd += Number(d.claudeCostUsd ?? 0);
  for (const c of cands) if (c.leadId && meetings.has(c.leadId)) row(c.productId).meetings++;
  return [...rows.values()].map((r) => ({
    ...r,
    claudeUsd: Math.round(r.claudeUsd * 100) / 100,
    claudeUsdPerMeeting: r.meetings ? Math.round((r.claudeUsd / r.meetings) * 100) / 100 : null,
    lookupsPerMeeting: r.meetings ? Math.round(r.registryLookups / r.meetings) : null,
  }));
}
