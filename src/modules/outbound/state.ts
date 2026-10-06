/**
 * The candidate state machine (spec §4.43.8, playbook-v6 F3/1).
 *
 *   SOURCED → ENRICHED → FILTERED_IN / FILTERED_OUT(reason) → AUDITED →
 *   CONTACT_RESOLVED / NO_CONTACT → DRAFTED → PENDING_APPROVAL →
 *   APPROVED / REJECTED(reason) → SENT → REPLIED
 *
 * plus LINKEDIN_QUEUE for the candidates with nothing to email (or routed
 * there by the reviewer). Every move goes through `transition`, which refuses
 * an edge this table does not list and writes the event — so "how did this
 * candidate get here" always has an answer, and a bug that skips a step fails
 * loudly instead of producing a candidate that was sent without being drafted.
 */
import type { CandidateReason, CandidateState, Prisma } from "@prisma/client";
import type { WorkspaceClient } from "@/lib/db";

export const ALLOWED: Record<CandidateState, readonly CandidateState[]> = {
  SOURCED: ["ENRICHED", "FILTERED_OUT", "FILTERED_IN"],
  ENRICHED: ["FILTERED_IN", "FILTERED_OUT"],
  FILTERED_IN: ["AUDITED", "FILTERED_OUT"],
  FILTERED_OUT: [],
  AUDITED: ["CONTACT_RESOLVED", "NO_CONTACT", "LINKEDIN_QUEUE", "FILTERED_OUT"],
  CONTACT_RESOLVED: ["DRAFTED", "FILTERED_OUT", "LINKEDIN_QUEUE"],
  NO_CONTACT: ["LINKEDIN_QUEUE"],
  DRAFTED: ["PENDING_APPROVAL", "FILTERED_OUT"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "LINKEDIN_QUEUE"],
  // Follow-ups are drafts of their own (OutreachDraft.step); the candidate
  // stays SENT while they are reviewed and sent.
  APPROVED: ["SENT", "REPLIED"],
  REJECTED: [],
  SENT: ["REPLIED"],
  REPLIED: [],
  LINKEDIN_QUEUE: [],
};

/**
 * The ways back (history and recovery). Not part of the forward flow: only a
 * person can take these, through `restoreCandidate` or the reject undo, and
 * `transition` refuses them unless the caller says it is a restore.
 */
export const RESTORE_EDGES: Partial<Record<CandidateState, readonly CandidateState[]>> = {
  REJECTED: ["PENDING_APPROVAL", "CONTACT_RESOLVED"],
  FILTERED_OUT: ["CONTACT_RESOLVED", "PENDING_APPROVAL"],
};

export function canRestore(from: CandidateState, to: CandidateState): boolean {
  return RESTORE_EDGES[from]?.includes(to) ?? false;
}

/** In the funnel and moving — what a run counts toward its target. */
export const QUALIFIED_STATES: readonly CandidateState[] = [
  "FILTERED_IN",
  "AUDITED",
  "CONTACT_RESOLVED",
  "DRAFTED",
  "PENDING_APPROVAL",
  "APPROVED",
  "SENT",
  "REPLIED",
];

/** A company in any of these is being worked somewhere and must not be sourced again. */
export const IN_FLIGHT_STATES: readonly CandidateState[] = [
  "SOURCED",
  "ENRICHED",
  "FILTERED_IN",
  "AUDITED",
  "CONTACT_RESOLVED",
  "DRAFTED",
  "PENDING_APPROVAL",
  "APPROVED",
  "SENT",
  "REPLIED",
  "LINKEDIN_QUEUE",
];

export class IllegalTransitionError extends Error {
  constructor(from: CandidateState, to: CandidateState) {
    super(`Candidate cannot move ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: CandidateState, to: CandidateState): boolean {
  return ALLOWED[from].includes(to);
}

export async function transition(
  db: WorkspaceClient,
  workspaceId: string,
  candidate: { id: string; state: CandidateState },
  to: CandidateState,
  opts: {
    reason?: CandidateReason | null;
    detail?: string | null;
    userId?: string | null;
    data?: Prisma.ProspectCandidateUpdateInput;
    at?: Date;
    /** A person taking one of the RESTORE_EDGES. */
    restore?: boolean;
  } = {},
): Promise<CandidateState> {
  const allowed = canTransition(candidate.state, to) || (opts.restore === true && canRestore(candidate.state, to));
  if (!allowed) throw new IllegalTransitionError(candidate.state, to);
  const at = opts.at ?? new Date();
  await db.prospectCandidate.update({
    where: { id: candidate.id },
    data: {
      ...(opts.data ?? {}),
      state: to,
      stateChangedAt: at,
      stateChangedById: opts.userId ?? null,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      ...(opts.detail !== undefined ? { reasonDetail: opts.detail } : {}),
    },
  });
  await db.candidateEvent.create({
    data: {
      workspaceId,
      candidateId: candidate.id,
      fromState: candidate.state,
      toState: to,
      reason: opts.reason ?? null,
      detail: opts.detail ?? null,
      userId: opts.userId ?? null,
      at,
    },
  });
  candidate.state = to;
  return to;
}
