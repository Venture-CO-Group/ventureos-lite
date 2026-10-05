/**
 * Undoing a rejection (history & recovery). The common case is a mis-keyed X
 * during fast keyboard review; the six-second toast puts the card straight
 * back. An undone rejection is RETRACTED, not erased: the event stays in the
 * trail with `retractedAt`, and nothing about it reaches the rejection-reason
 * statistics — which read only candidates still REJECTED and drafts still
 * carrying a reason.
 */
import type { WorkspaceClient } from "@/lib/db";
import { transition } from "./state";

/** Candidate back to the queue, draft back to pending, the rejection retracted. */
export async function retractRejection(
  db: WorkspaceClient,
  workspaceId: string,
  candidateId: string,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const c = await db.prospectCandidate.findUnique({ where: { id: candidateId } });
  if (!c || c.state !== "REJECTED") return false;
  const draft = await db.outreachDraft.findFirst({
    where: { candidateId, step: 0, status: "REJECTED", supersededAt: null },
    orderBy: { decidedAt: "desc" },
  });
  if (!draft) return false;
  await db.outreachDraft.update({
    where: { id: draft.id },
    data: { status: "PENDING", rejectReason: null, rejectNote: null, decidedAt: null, decidedById: null },
  });
  const rejection = await db.candidateEvent.findFirst({
    where: { candidateId, toState: "REJECTED", retractedAt: null },
    orderBy: { at: "desc" },
  });
  if (rejection) await db.candidateEvent.update({ where: { id: rejection.id }, data: { retractedAt: now } });
  await transition(db, workspaceId, c, "PENDING_APPROVAL", {
    restore: true,
    reason: null,
    detail: "rejection undone",
    userId,
    data: { reasonDetail: null },
    at: now,
  });
  return true;
}

/** A rejected follow-up back to pending (the company stays SENT). */
export async function retractFollowupRejection(db: WorkspaceClient, draftId: string): Promise<boolean> {
  const r = await db.outreachDraft.updateMany({
    where: { id: draftId, status: "REJECTED" },
    data: { status: "PENDING", rejectReason: null, rejectNote: null, decidedAt: null, decidedById: null },
  });
  return r.count > 0;
}
