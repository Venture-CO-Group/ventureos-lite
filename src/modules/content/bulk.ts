/**
 * Bulk status changes on the content board (playbook-v5 P17/1).
 *
 * ── THE PHASE RULE STILL HOLDS PER POST ─────────────────────────────────────
 *
 * A post moves through its phases in order; an illegal jump is refused for one
 * card and must be refused for forty. So each row is checked against the same
 * transition table the drag uses, and the ones that cannot make the jump come
 * back as skips naming where they actually are.
 *
 * The approval rule holds too: only somebody who may approve can move a post
 * INTO the approved phase, and that is checked once for the actor rather than
 * once per row.
 */

import { getWorkspaceClient } from "@/lib/db";
import { EMPTY_BULK_RESULT, type BulkResult, type SkippedRow } from "@/lib/bulk";
import { recordUndo } from "../undo/store";
import { canTransition } from "./board";
import type { ContentStatus } from "@prisma/client";

export async function bulkSetContentStatus(
  workspaceId: string,
  userId: string,
  ids: string[],
  to: ContentStatus,
  /** Whether the actor may approve or reopen. Checked once, for the person. */
  isApprover: boolean,
): Promise<BulkResult> {
  if (ids.length === 0) return EMPTY_BULK_RESULT;
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.contentPost.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, title: true },
  });
  const found = new Set(rows.map((r) => r.id));
  const skipped: SkippedRow[] = ids
    .filter((id) => !found.has(id))
    .map((id) => ({ id, reason: "No longer there, or not in this workspace." }));

  const targets: string[] = [];
  for (const row of rows) {
    if (row.status === to) {
      skipped.push({ id: row.id, reason: `Already in ${to.toLowerCase()}.` });
      continue;
    }
    const verdict = canTransition(row.status as ContentStatus, to, isApprover);
    if (!verdict.allowed) {
      skipped.push({ id: row.id, reason: verdict.message });
      continue;
    }
    targets.push(row.id);
  }
  if (targets.length === 0) return { applied: 0, skipped };

  const before = rows.filter((r) => targets.includes(r.id));
  const { count } = await db.contentPost.updateMany({
    where: { id: { in: targets } },
    data: { status: to },
  });

  const undo = await recordUndo(workspaceId, userId, {
    kind: "content_status",
    label: `Moved ${count} post${count === 1 ? "" : "s"} to ${to.toLowerCase()}`,
    inverse: {
      entity: "contentPost",
      targets: before.map((p) => ({ id: p.id, set: { status: p.status } })),
    },
    expected: Object.fromEntries(targets.map((id) => [id, { status: to }])),
  });

  return { applied: count, skipped, undoId: undo?.id ?? null, undoLabel: undo?.label ?? null };
}
