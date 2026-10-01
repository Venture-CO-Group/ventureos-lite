/**
 * Signal Engine pure logic (spec §4.13). Weekly aggregation, the n>=20 proposal
 * gate, and the approval-only mutation rule. NOTHING here writes to the DB — the
 * weekly job produces proposals as data; a mutation is only computed when an
 * Owner *approves*. This is what guarantees "nothing self-modifies".
 */
export const MIN_PROPOSAL_N = 20;

export type ProposalKind = "FRAME_PROMOTION" | "SCORE_WEIGHT" | "STAGE_PROBABILITY" | "FRAGMENT_RETIREMENT";

export interface ProposalDraft {
  kind: ProposalKind;
  title: string;
  evidence: string;
  n: number;
  data: Record<string, unknown>;
}

export function isEligible(n: number): boolean {
  return n >= MIN_PROPOSAL_N;
}

/** Gate: only proposals backed by n>=20 reach the approval queue. */
export function filterEligibleProposals(drafts: ProposalDraft[]): ProposalDraft[] {
  return drafts.filter((d) => isEligible(d.n));
}

// ---- weekly aggregation (feeds the single Sonnet call) --------------------

export interface WeekFact {
  dims: string[]; // dimension keys, e.g. "frame:B", "segment:HoReCa", "source:REFERRAL"
  sent: number;
  accepted: number;
  replied: number;
  won: number;
  lost: number;
  revenue: number;
}

export interface DimStat {
  key: string;
  n: number; // sample size (facts touching this dimension)
  sent: number;
  accepted: number;
  replied: number;
  won: number;
  lost: number;
  revenue: number;
  acceptRate: number; // accepted / sent
  replyRate: number; // replied / sent
  closeRate: number; // won / (won + lost)
}

export function aggregateWeek(facts: WeekFact[]): DimStat[] {
  const map = new Map<string, DimStat>();
  for (const f of facts) {
    for (const key of f.dims) {
      let s = map.get(key);
      if (!s) {
        s = {
          key,
          n: 0,
          sent: 0,
          accepted: 0,
          replied: 0,
          won: 0,
          lost: 0,
          revenue: 0,
          acceptRate: 0,
          replyRate: 0,
          closeRate: 0,
        };
        map.set(key, s);
      }
      s.n += 1;
      s.sent += f.sent;
      s.accepted += f.accepted;
      s.replied += f.replied;
      s.won += f.won;
      s.lost += f.lost;
      s.revenue += f.revenue;
    }
  }
  const rows = [...map.values()];
  for (const s of rows) {
    s.acceptRate = s.sent > 0 ? s.accepted / s.sent : 0;
    s.replyRate = s.sent > 0 ? s.replied / s.sent : 0;
    s.closeRate = s.won + s.lost > 0 ? s.won / (s.won + s.lost) : 0;
  }
  rows.sort((a, b) => b.n - a.n || b.revenue - a.revenue || a.key.localeCompare(b.key));
  return rows;
}

// ---- approval-only mutation -----------------------------------------------

export type Decision = "approve" | "reject";

export interface FrameMutation {
  type: "frame";
  frameId: string;
  version: number;
  status: "APPROVED";
}
export interface WeightMutation {
  type: "weight";
  criterion: string;
  weight: number;
}
/**
 * A pipeline stage's default probability, recalibrated against its own win/loss
 * record (playbook-v2 P4/c). Quarterly, min n=20, and — like everything else
 * here — only ever applied by an explicit Owner approval.
 */
export interface StageProbabilityMutation {
  type: "stage_probability";
  stageId: string;
  probability: number;
}
/** Remove one name fragment from a segment's harvest set (playbook-v6 F6/4). */
export interface FragmentMutation {
  type: "fragment";
  segmentKey: string;
  fragment: string;
}

export type ProposalMutation = FrameMutation | WeightMutation | StageProbabilityMutation | FragmentMutation;

/**
 * The mutation a decision implies. A rejection (or anything but an explicit
 * approval) implies NO mutation. Approving a frame promotion bumps its version
 * and marks it APPROVED; approving a score-weight change sets the new weight.
 */
export function proposalEffect(
  kind: ProposalKind,
  data: Record<string, unknown>,
  decision: Decision,
  ctx: { currentFrameVersion?: number },
): ProposalMutation | null {
  if (decision !== "approve") return null;
  if (kind === "FRAME_PROMOTION") {
    return {
      type: "frame",
      frameId: String(data.frameId),
      version: (ctx.currentFrameVersion ?? 1) + 1,
      status: "APPROVED",
    };
  }
  if (kind === "SCORE_WEIGHT") {
    return { type: "weight", criterion: String(data.criterion), weight: Number(data.weight) };
  }
  if (kind === "FRAGMENT_RETIREMENT") {
    return { type: "fragment", segmentKey: String(data.segmentKey), fragment: String(data.fragment) };
  }
  if (kind === "STAGE_PROBABILITY") {
    return {
      type: "stage_probability",
      stageId: String(data.stageId),
      // Clamped here rather than at the call site: an approval must not be able
      // to write a probability the forecast cannot weigh.
      probability: Math.max(0, Math.min(100, Math.round(Number(data.probability)))),
    };
  }
  return null;
}
