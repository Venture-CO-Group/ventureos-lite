/**
 * Bulk actions on inbox threads (playbook-v5 P17/1).
 *
 * Mark read, link to a lead, archive. Each is a per-thread rule run many
 * times: a thread already read is skipped rather than counted, a thread that
 * is already linked to a DIFFERENT lead is skipped rather than silently
 * relinked — reassigning correspondence to another company is not something a
 * bulk action should do quietly.
 */

import { getWorkspaceClient } from "@/lib/db";
import { EMPTY_BULK_RESULT, type BulkResult, type SkippedRow } from "@/lib/bulk";

async function threads(db: ReturnType<typeof getWorkspaceClient>, ids: string[]) {
  const rows = await db.emailThread.findMany({
    where: { id: { in: ids } },
    select: { id: true, unread: true, leadId: true, archivedAt: true, subject: true },
  });
  const found = new Set(rows.map((r) => r.id));
  const missing: SkippedRow[] = ids
    .filter((id) => !found.has(id))
    .map((id) => ({ id, reason: "No longer there, or not in this workspace." }));
  return { rows, missing };
}

export async function bulkMarkThreadsRead(
  workspaceId: string,
  ids: string[],
  unread = false,
): Promise<BulkResult> {
  if (ids.length === 0) return EMPTY_BULK_RESULT;
  const db = getWorkspaceClient(workspaceId);
  const { rows, missing } = await threads(db, ids);
  const skipped = [...missing];
  const targets = rows
    .filter((r) => {
      if (r.unread === unread) {
        skipped.push({ id: r.id, reason: unread ? "Already unread." : "Already read." });
        return false;
      }
      return true;
    })
    .map((r) => r.id);
  if (targets.length === 0) return { applied: 0, skipped };
  const { count } = await db.emailThread.updateMany({
    where: { id: { in: targets } },
    data: { unread },
  });
  return { applied: count, skipped };
}

export async function bulkArchiveThreads(
  workspaceId: string,
  ids: string[],
  archived = true,
): Promise<BulkResult> {
  if (ids.length === 0) return EMPTY_BULK_RESULT;
  const db = getWorkspaceClient(workspaceId);
  const { rows, missing } = await threads(db, ids);
  const skipped = [...missing];
  const targets = rows
    .filter((r) => {
      const already = archived ? r.archivedAt !== null : r.archivedAt === null;
      if (already) {
        skipped.push({ id: r.id, reason: archived ? "Already archived." : "Not archived." });
        return false;
      }
      return true;
    })
    .map((r) => r.id);
  if (targets.length === 0) return { applied: 0, skipped };
  const { count } = await db.emailThread.updateMany({
    where: { id: { in: targets } },
    data: { archivedAt: archived ? new Date() : null },
  });
  return { applied: count, skipped };
}

export async function bulkLinkThreadsToLead(
  workspaceId: string,
  ids: string[],
  leadId: string,
): Promise<BulkResult> {
  if (ids.length === 0) return EMPTY_BULK_RESULT;
  const db = getWorkspaceClient(workspaceId);
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true } });
  if (!lead) {
    return { applied: 0, skipped: ids.map((id) => ({ id, reason: "That lead does not exist." })) };
  }

  const { rows, missing } = await threads(db, ids);
  const skipped = [...missing];
  const targets = rows
    .filter((r) => {
      if (r.leadId === leadId) {
        skipped.push({ id: r.id, reason: "Already linked to that lead." });
        return false;
      }
      /**
       * Already pointing somewhere ELSE is a skip, not an overwrite.
       * Reassigning a conversation to a different company is a decision, and a
       * bulk action that did it silently would move correspondence out from
       * under whoever was reading it.
       */
      if (r.leadId) {
        skipped.push({ id: r.id, reason: "Already linked to a different lead — unlink it first." });
        return false;
      }
      return true;
    })
    .map((r) => r.id);
  if (targets.length === 0) return { applied: 0, skipped };
  const { count } = await db.emailThread.updateMany({
    where: { id: { in: targets } },
    data: { leadId, matchType: "manual" },
  });
  return { applied: count, skipped };
}
