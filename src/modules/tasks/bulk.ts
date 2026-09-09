/**
 * Bulk actions on tasks (playbook-v5 P17/1).
 *
 * ── EVERY PER-ROW RULE STILL APPLIES PER ROW ────────────────────────────────
 *
 * That is the whole requirement. A bulk action is not a shortcut past the
 * rules that hold for one row — it is the same rules, run many times, with the
 * refusals collected instead of thrown. So each function returns
 * `{ applied, skipped[{id, reason}] }` and the caller shows the reasons.
 *
 * ── AND THE RULES WORTH NAMING ──────────────────────────────────────────────
 *
 * COMPLETION does not cascade, in either direction: ticking a parent leaves
 * its subtasks open, and ticking every subtask leaves the parent open. That is
 * the model's existing rule and a bulk tick must not quietly break it.
 *
 * A DEPENDENCY DOES NOT BLOCK COMPLETION. The model is explicit that a
 * dependency is reported, never enforced. But a bulk tick REPORTS the blocked
 * ones as a warning rather than hiding them, because "I ticked forty things
 * and three of them were waiting on something" is worth knowing.
 *
 * A SECTION BELONGS TO A BOARD. Moving tasks into a section from another board
 * would leave a card whose section is on a board it is not on, so those rows
 * are skipped rather than corrupted.
 *
 * DELETION IS PERMANENT and takes subtasks, comments, attachments and
 * dependency links with it (see modules/undo/contract.ts). The count of what
 * goes is reported per row so nobody deletes a parent thinking it is a leaf.
 */

import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { EMPTY_BULK_RESULT, type BulkResult, type SkippedRow } from "@/lib/bulk";
import { TASK_PRIORITIES } from "./board-logic";
import { recordUndo } from "../undo/store";

type Db = ReturnType<typeof getWorkspaceClient>;

/** Rows in this workspace, and a skip for every id that is not. */
async function scope(
  db: Db,
  ids: string[],
): Promise<{
  rows: {
    id: string;
    title: string;
    doneAt: Date | null;
    boardId: string | null;
    parentId: string | null;
  }[];
  missing: SkippedRow[];
}> {
  const rows = await db.task.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true, doneAt: true, boardId: true, parentId: true },
  });
  const found = new Set(rows.map((r) => r.id));
  return {
    rows,
    missing: ids
      .filter((id) => !found.has(id))
      .map((id) => ({ id, reason: "No longer there, or not in this workspace." })),
  };
}

export async function bulkCompleteTasks(
  workspaceId: string,
  userId: string,
  ids: string[],
  done = true,
): Promise<BulkResult> {
  if (ids.length === 0) return EMPTY_BULK_RESULT;
  const db = getWorkspaceClient(workspaceId);
  const { rows, missing } = await scope(db, ids);
  const skipped = [...missing];

  const targets: string[] = [];
  for (const row of rows) {
    if (done && row.doneAt) {
      skipped.push({ id: row.id, reason: "Already complete." });
      continue;
    }
    if (!done && !row.doneAt) {
      skipped.push({ id: row.id, reason: "Already open." });
      continue;
    }
    targets.push(row.id);
  }
  if (targets.length === 0) return { applied: 0, skipped };

  /**
   * Blocked tasks are still completed — a dependency is reported, never
   * enforced — but they are named, because ticking something that was waiting
   * on unfinished work is worth a second look.
   */
  if (done) {
    const blocked = await db.taskDependency.findMany({
      where: { taskId: { in: targets }, blockedBy: { doneAt: null } },
      select: { taskId: true, blockedBy: { select: { title: true } } },
    });
    for (const dep of blocked) {
      skipped.push({
        id: dep.taskId,
        reason: `Completed, but it was waiting on “${dep.blockedBy.title}”.`,
      });
    }
  }

  const doneAt = done ? new Date() : null;
  const { count } = await db.task.updateMany({
    where: { id: { in: targets } },
    data: { doneAt, completedBy: done ? userId : null },
  });

  const undo = done
    ? await recordUndo(workspaceId, userId, {
        kind: "task_done",
        label: `Completed ${count} task${count === 1 ? "" : "s"}`,
        inverse: {
          entity: "task",
          targets: targets.map((id) => ({ id, set: { doneAt: null, completedBy: null } })),
        },
        expected: Object.fromEntries(
          targets.map((id) => [id, { doneAt: doneAt!.toISOString() }]),
        ),
      })
    : null;

  return { applied: count, skipped, undoId: undo?.id ?? null, undoLabel: undo?.label ?? null };
}

export async function bulkAssignTasks(
  workspaceId: string,
  userId: string,
  ids: string[],
  assigneeId: string | null,
): Promise<BulkResult> {
  if (ids.length === 0) return EMPTY_BULK_RESULT;

  // Checked ONCE rather than per row: it is one person, and a hundred
  // identical refusals is not a report.
  if (assigneeId) {
    const member = await prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId: assigneeId, workspaceId } },
      select: { state: true },
    });
    if (!member) {
      return { applied: 0, skipped: ids.map((id) => ({ id, reason: "That person is not in this workspace." })) };
    }
    if (member.state !== "ACTIVE") {
      return { applied: 0, skipped: ids.map((id) => ({ id, reason: "That person's access is suspended." })) };
    }
  }

  const db = getWorkspaceClient(workspaceId);
  const { rows, missing } = await scope(db, ids);
  const targets = rows.map((r) => r.id);
  if (targets.length === 0) return { applied: 0, skipped: missing };

  const before = await db.task.findMany({
    where: { id: { in: targets } },
    select: { id: true, assigneeId: true },
  });
  const { count } = await db.task.updateMany({
    where: { id: { in: targets } },
    data: { assigneeId },
  });

  const undo = await recordUndo(workspaceId, userId, {
    kind: "bulk_owner",
    label: `Reassigned ${count} task${count === 1 ? "" : "s"}`,
    inverse: {
      entity: "task",
      targets: before.map((t) => ({ id: t.id, set: { assigneeId: t.assigneeId } })),
    },
    expected: Object.fromEntries(targets.map((id) => [id, { assigneeId }])),
  });

  return { applied: count, skipped: missing, undoId: undo?.id ?? null, undoLabel: undo?.label ?? null };
}

export async function bulkSetTaskPriority(
  workspaceId: string,
  userId: string,
  ids: string[],
  priority: string,
): Promise<BulkResult> {
  if (ids.length === 0) return EMPTY_BULK_RESULT;
  if (!(TASK_PRIORITIES as readonly string[]).includes(priority)) {
    return { applied: 0, skipped: ids.map((id) => ({ id, reason: "That is not a priority." })) };
  }
  const db = getWorkspaceClient(workspaceId);
  const { rows, missing } = await scope(db, ids);
  const targets = rows.map((r) => r.id);
  if (targets.length === 0) return { applied: 0, skipped: missing };

  const before = await db.task.findMany({
    where: { id: { in: targets } },
    select: { id: true, priority: true },
  });
  const { count } = await db.task.updateMany({ where: { id: { in: targets } }, data: { priority } });

  const undo = await recordUndo(workspaceId, userId, {
    kind: "bulk_signals",
    label: `Set ${count} task${count === 1 ? "" : "s"} to ${priority}`,
    inverse: {
      entity: "task",
      targets: before.map((t) => ({ id: t.id, set: { priority: t.priority } })),
    },
    expected: Object.fromEntries(targets.map((id) => [id, { priority }])),
  });

  return { applied: count, skipped: missing, undoId: undo?.id ?? null, undoLabel: undo?.label ?? null };
}

/** A date cell sends "2026-09-14" or "" — never a timestamp. */
function parseDay(value: string | null): Date | null | undefined {
  if (value === null || value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return undefined;
  const d = new Date(`${value.trim()}T12:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function bulkSetTaskDue(
  workspaceId: string,
  userId: string,
  ids: string[],
  dueAt: string | null,
): Promise<BulkResult> {
  if (ids.length === 0) return EMPTY_BULK_RESULT;
  const parsed = parseDay(dueAt);
  if (parsed === undefined) {
    return { applied: 0, skipped: ids.map((id) => ({ id, reason: "That is not a date." })) };
  }
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.task.findMany({
    where: { id: { in: ids } },
    select: { id: true, dueAt: true, startAt: true },
  });
  const found = new Set(rows.map((r) => r.id));
  const skipped: SkippedRow[] = ids
    .filter((id) => !found.has(id))
    .map((id) => ({ id, reason: "No longer there, or not in this workspace." }));

  const targets: string[] = [];
  for (const row of rows) {
    // The same rule the inline edit enforces: a due date before its own start
    // is the error that makes a timeline draw a bar backwards.
    if (parsed && row.startAt && row.startAt.getTime() > parsed.getTime()) {
      skipped.push({ id: row.id, reason: "It starts after that date." });
      continue;
    }
    targets.push(row.id);
  }
  if (targets.length === 0) return { applied: 0, skipped };

  const before = rows.filter((r) => targets.includes(r.id));
  const { count } = await db.task.updateMany({
    where: { id: { in: targets } },
    data: { dueAt: parsed },
  });

  const undo = await recordUndo(workspaceId, userId, {
    kind: "bulk_signals",
    label: `Rescheduled ${count} task${count === 1 ? "" : "s"}`,
    inverse: {
      entity: "task",
      targets: before.map((t) => ({ id: t.id, set: { dueAt: t.dueAt } })),
    },
    expected: Object.fromEntries(
      targets.map((id) => [id, { dueAt: parsed ? parsed.toISOString() : null }]),
    ),
  });

  return { applied: count, skipped, undoId: undo?.id ?? null, undoLabel: undo?.label ?? null };
}

export async function bulkTagTasks(
  workspaceId: string,
  userId: string,
  ids: string[],
  tag: string,
  mode: "add" | "remove" = "add",
): Promise<BulkResult> {
  if (ids.length === 0) return EMPTY_BULK_RESULT;
  const clean = tag.trim();
  if (!clean) return { applied: 0, skipped: ids.map((id) => ({ id, reason: "Give the tag a name." })) };
  if (clean.length > 40) {
    return { applied: 0, skipped: ids.map((id) => ({ id, reason: "That tag is too long." })) };
  }

  const db = getWorkspaceClient(workspaceId);
  const rows = await db.task.findMany({
    where: { id: { in: ids } },
    select: { id: true, tags: true },
  });
  const found = new Set(rows.map((r) => r.id));
  const skipped: SkippedRow[] = ids
    .filter((id) => !found.has(id))
    .map((id) => ({ id, reason: "No longer there, or not in this workspace." }));

  const before: { id: string; tags: string[] }[] = [];
  let applied = 0;
  for (const row of rows) {
    const tags = Array.isArray(row.tags) ? (row.tags as string[]) : [];
    const has = tags.includes(clean);
    if (mode === "add" && has) {
      skipped.push({ id: row.id, reason: "Already tagged." });
      continue;
    }
    if (mode === "remove" && !has) {
      skipped.push({ id: row.id, reason: "Was not tagged." });
      continue;
    }
    const next = mode === "add" ? [...tags, clean] : tags.filter((t) => t !== clean);
    if (next.length > 12) {
      skipped.push({ id: row.id, reason: "Twelve tags is the limit." });
      continue;
    }
    before.push({ id: row.id, tags });
    await db.task.update({ where: { id: row.id }, data: { tags: next } });
    applied += 1;
  }
  if (applied === 0) return { applied: 0, skipped };

  const undo = await recordUndo(workspaceId, userId, {
    kind: "bulk_signals",
    label: `${mode === "add" ? "Tagged" : "Untagged"} ${applied} task${applied === 1 ? "" : "s"}`,
    inverse: {
      entity: "task",
      targets: before.map((t) => ({ id: t.id, set: { tags: t.tags } })),
    },
    // Tags are a JSON array; the undo compares by string, and comparing arrays
    // that way is unreliable — so nothing is claimed about their prior state.
    expected: {},
  });

  return { applied, skipped, undoId: undo?.id ?? null, undoLabel: undo?.label ?? null };
}

export async function bulkMoveTasksToSection(
  workspaceId: string,
  userId: string,
  ids: string[],
  sectionId: string,
): Promise<BulkResult> {
  if (ids.length === 0) return EMPTY_BULK_RESULT;
  const db = getWorkspaceClient(workspaceId);
  const section = await db.taskSection.findUnique({
    where: { id: sectionId },
    select: { id: true, boardId: true, name: true },
  });
  if (!section) {
    return { applied: 0, skipped: ids.map((id) => ({ id, reason: "That column no longer exists." })) };
  }

  const { rows, missing } = await scope(db, ids);
  const skipped = [...missing];
  const targets: string[] = [];
  for (const row of rows) {
    /**
     * A section belongs to a board. Moving a card from another board into this
     * column would leave it with a section that is not on its own board — a
     * row the board query cannot render.
     */
    if (row.boardId !== section.boardId) {
      skipped.push({ id: row.id, reason: "It is on a different board." });
      continue;
    }
    targets.push(row.id);
  }
  if (targets.length === 0) return { applied: 0, skipped };

  const before = await db.task.findMany({
    where: { id: { in: targets } },
    select: { id: true, sectionId: true },
  });
  const { count } = await db.task.updateMany({
    where: { id: { in: targets } },
    data: { sectionId },
  });

  const undo = await recordUndo(workspaceId, userId, {
    kind: "bulk_stage",
    label: `Moved ${count} task${count === 1 ? "" : "s"} to ${section.name}`,
    inverse: {
      entity: "task",
      targets: before.map((t) => ({ id: t.id, set: { sectionId: t.sectionId } })),
    },
    expected: Object.fromEntries(targets.map((id) => [id, { sectionId }])),
  });

  return { applied: count, skipped, undoId: undo?.id ?? null, undoLabel: undo?.label ?? null };
}

/**
 * Deletion. No undo, and the contract says so out loud: `undo` restores fields
 * on rows that still exist, so a deleted task cannot come back — see
 * modules/undo/contract.ts.
 */
export async function bulkDeleteTasks(
  workspaceId: string,
  ids: string[],
): Promise<BulkResult> {
  if (ids.length === 0) return EMPTY_BULK_RESULT;
  const db = getWorkspaceClient(workspaceId);
  const { rows, missing } = await scope(db, ids);
  const skipped = [...missing];
  const targets = rows.map((r) => r.id);
  if (targets.length === 0) return { applied: 0, skipped };

  /**
   * What else goes with them, reported before it happens: a parent takes its
   * subtasks, and nobody should delete one thinking it was a leaf.
   */
  const children = await db.task.groupBy({
    by: ["parentId"],
    where: { parentId: { in: targets } },
    _count: { _all: true },
  });
  for (const group of children) {
    if (!group.parentId) continue;
    skipped.push({
      id: group.parentId,
      reason: `Deleted, along with ${group._count._all} subtask${group._count._all === 1 ? "" : "s"}.`,
    });
  }

  const { count } = await db.task.deleteMany({ where: { id: { in: targets } } });
  return { applied: count, skipped };
}
