/**
 * Removing recipients from a campaign audience (playbook-v5 P17/1).
 *
 * ── WHAT MAY NOT BE REMOVED, AND WHY ────────────────────────────────────────
 *
 * A recipient who has ALREADY BEEN SENT TO stays. The row is the record that
 * mail went to that address — it is what suppression, bounce handling and the
 * complaint circuit breaker read, and deleting it would make a cold-email
 * programme unable to prove what it had sent. Removing somebody from a future
 * send is `suppressed`; removing the evidence is not on offer.
 *
 * So "remove" means: delete the ones that have not been sent to, and SUPPRESS
 * the ones that have — reporting which is which rather than pretending the two
 * are the same action.
 */

import { getWorkspaceClient } from "@/lib/db";
import { EMPTY_BULK_RESULT, type BulkResult, type SkippedRow } from "@/lib/bulk";

export async function bulkRemoveRecipients(
  workspaceId: string,
  ids: string[],
): Promise<BulkResult> {
  if (ids.length === 0) return EMPTY_BULK_RESULT;
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.campaignRecipient.findMany({
    where: { id: { in: ids } },
    select: { id: true, sentAt: true, stepSent: true, suppressed: true, email: true },
  });
  const found = new Set(rows.map((r) => r.id));
  const skipped: SkippedRow[] = ids
    .filter((id) => !found.has(id))
    .map((id) => ({ id, reason: "No longer there, or not in this workspace." }));

  const deletable: string[] = [];
  const suppressible: string[] = [];
  for (const row of rows) {
    const sent = row.sentAt !== null || row.stepSent > 0;
    if (!sent) {
      deletable.push(row.id);
      continue;
    }
    if (row.suppressed) {
      skipped.push({ id: row.id, reason: "Already sent to, and already suppressed." });
      continue;
    }
    suppressible.push(row.id);
  }

  let applied = 0;
  if (deletable.length > 0) {
    applied += (await db.campaignRecipient.deleteMany({ where: { id: { in: deletable } } })).count;
  }
  if (suppressible.length > 0) {
    const { count } = await db.campaignRecipient.updateMany({
      where: { id: { in: suppressible } },
      data: { suppressed: true },
    });
    applied += count;
    // Reported, not hidden: the two halves of "remove" are different actions
    // and somebody auditing a campaign needs to know which one happened.
    for (const id of suppressible) {
      skipped.push({
        id,
        reason: "Already sent to — suppressed instead of removed, so the record of the send stays.",
      });
    }
  }

  return { applied, skipped };
}
