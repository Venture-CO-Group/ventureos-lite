"use server";

import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { isSafeColor } from "@/modules/workspaces/brand";
import { recordUndo, type UndoToken } from "../undo/store";
import {
  TASK_TYPES,
  WORK_BUCKETS,
  WORK_BUCKET_LABEL,
  WORK_BUCKET_RULE,
  dueDateForBucket,
  type WorkBucket,
} from "./logic";
import { buildPriorityMatrix, priorityMapFrom, QUADRANTS } from "@/modules/audit/priority";
import type { AuditCheck } from "@/modules/audit/types";
import {
  TASK_PRIORITIES,
  extractMentions,
  nextPosition,
  readRecurrence,
  cyclePath,
  type DependencyEdge,
} from "./board-logic";
import { nextRunAt } from "@/modules/leads/schedule-logic";
import { assignableMembers } from "@/modules/members/directory";
import {
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENTS_PER_TASK,
  MAX_ATTACHMENT_BYTES,
  MY_WORK_LIMIT,
} from "./attachment-rules";

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";
import {
  addFollowers,
  createBoard as createBoardRow,
  listBoards,
  loadBoard,
  moveTask,
  notifyTaskAudience,
  type BoardSummary,
  type BoardView,
} from "./board-store";
import { chipFor } from "./links";
import {
  onTaskAssigneeChanged,
  onTaskCompleted,
  onTaskCreated,
  onTaskMoved,
  onTaskPriorityChanged,
} from "@/modules/workflow/triggers";

/**
 * The board layer's server actions (P8/1).
 *
 * Everything goes through the guarded client, so a board, a section, a task and
 * a comment are all scoped to the workspace by the same mechanism as every
 * other row. No action here trusts an id from the browser for anything beyond
 * "look this up inside my own workspace" — a foreign id simply finds nothing.
 */

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export async function getBoards(includeArchived = false): Promise<BoardSummary[]> {
  const { workspaceId } = await getActiveContext();
  return listBoards(workspaceId, { includeArchived });
}

export async function getBoard(
  boardId: string,
  filters: { assigneeId?: string | null; includeDone?: boolean } = {},
): Promise<BoardView | null> {
  const { workspaceId } = await getActiveContext();
  return loadBoard(workspaceId, boardId, filters);
}

export interface WorkspaceMemberOption {
  id: string;
  name: string;
  email: string;
}

/** Who a task can be assigned to: the seated members of this workspace. */
export async function getAssignableMembers(): Promise<WorkspaceMemberOption[]> {
  const { workspaceId } = await getActiveContext();
  /**
   * Through the directory, not a bare `findMany` (§1).
   *
   * This used to return every membership row it could find — which since the
   * lifecycle landed includes suspended people, pending invitations, ended
   * memberships and read-only client accounts. Handing work to somebody who
   * cannot sign in is a task that never gets done and that nobody notices for
   * a week.
   */
  const members = await assignableMembers(workspaceId);
  return members.map((m) => ({ id: m.id, name: m.name, email: m.email }));
}

// ---------------------------------------------------------------------------
// boards and sections
// ---------------------------------------------------------------------------

const boardSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  color: z.string().trim().max(20).optional(),
});

export async function createBoard(raw: unknown): Promise<{ id: string }> {
  const input = boardSchema.parse(raw);
  const { workspaceId, userId } = await getActiveContext();
  const id = await createBoardRow(workspaceId, userId, {
    name: input.name,
    description: input.description || null,
    // Validated before it can reach a style attribute — the same rule the
    // letterhead colours go through.
    color: input.color && isSafeColor(input.color) ? input.color : null,
  });
  revalidatePath("/tasks");
  return { id };
}

export async function updateBoard(raw: unknown): Promise<{ ok: true }> {
  const input = boardSchema.extend({ id: z.string().min(1) }).parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.taskBoard.update({
    where: { id: input.id },
    data: {
      name: input.name,
      description: input.description || null,
      color: input.color && isSafeColor(input.color) ? input.color : null,
    },
  });
  revalidatePath("/tasks");
  return { ok: true };
}

/**
 * Archive rather than delete.
 *
 * A board holds work that happened; removing it would take the tasks with it,
 * and "we did that in the old board" is a sentence people need to be able to
 * finish. Archived boards leave the pickers and stay readable.
 */
export async function archiveBoard(
  boardId: string,
  archived: boolean,
): Promise<{ ok: true; undo: UndoToken | null }> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const before = await db.taskBoard.findUnique({
    where: { id: boardId },
    select: { name: true, archivedAt: true },
  });
  if (!before) throw new Error("Board not found");

  const archivedAt = archived ? new Date() : null;
  await db.taskBoard.update({ where: { id: boardId }, data: { archivedAt } });

  /**
   * Archiving takes a board out of the switcher, and the person who did it by
   * accident has no obvious way back — the board is, by construction, no longer
   * in the list they would look in. So this is one of the places an undo earns
   * its keep, and being a flip of one nullable column it is genuinely
   * reversible (see modules/undo/contract.ts).
   */
  const undo = await recordUndo(workspaceId, userId, {
    kind: "board_archive",
    label: archived ? `Archived ${before.name}` : `Restored ${before.name}`,
    inverse: {
      entity: "taskBoard",
      targets: [{ id: boardId, set: { archivedAt: before.archivedAt } }],
    },
    expected: { [boardId]: { archivedAt } },
  });

  revalidatePath("/tasks");
  return { ok: true, undo };
}

const sectionSchema = z.object({
  boardId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
});

export async function createSection(raw: unknown): Promise<{ id: string }> {
  const input = sectionSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  // Confirms the board is ours before writing a child row against it.
  const board = await db.taskBoard.findUnique({
    where: { id: input.boardId },
    select: { id: true },
  });
  if (!board) throw new Error("Board not found");

  const existing = await db.taskSection.findMany({
    where: { boardId: input.boardId },
    select: { position: true },
  });
  const section = await db.taskSection.create({
    data: {
      workspaceId,
      boardId: input.boardId,
      name: input.name,
      position: nextPosition(existing.map((s) => s.position)),
    },
    select: { id: true },
  });
  revalidatePath("/tasks");
  return { id: section.id };
}

export async function renameSection(sectionId: string, name: string): Promise<{ ok: true }> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) throw new Error("A section name is 1–80 characters.");
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.taskSection.update({ where: { id: sectionId }, data: { name: trimmed } });
  revalidatePath("/tasks");
  return { ok: true };
}

/**
 * Delete a section. Its tasks move to the board's unsectioned area rather than
 * disappearing — the schema's `onDelete: SetNull` says so, and it is deliberate:
 * deleting a column should never be a way to delete work by accident.
 */
export async function deleteSection(sectionId: string): Promise<{ ok: true; moved: number }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const moved = await db.task.count({ where: { sectionId } });
  await db.taskSection.delete({ where: { id: sectionId } });
  revalidatePath("/tasks");
  return { ok: true, moved };
}

// ---------------------------------------------------------------------------
// tasks on a board
// ---------------------------------------------------------------------------

const boardTaskSchema = z.object({
  boardId: z.string().min(1),
  sectionId: z.string().min(1).nullable().optional(),
  title: z.string().trim().min(1).max(200),
  note: z.string().trim().max(5000).optional(),
  type: z.enum(TASK_TYPES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueAt: z.string().optional(),
  startAt: z.string().optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  parentId: z.string().min(1).optional(),
});

export async function createBoardTask(raw: unknown): Promise<{ id: string }> {
  const input = boardTaskSchema.parse(raw);
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const siblings = await db.task.findMany({
    where: { boardId: input.boardId, sectionId: input.sectionId ?? null, parentId: null },
    select: { position: true },
  });

  const task = await db.task.create({
    data: {
      workspaceId,
      boardId: input.boardId,
      sectionId: input.sectionId ?? null,
      parentId: input.parentId ?? null,
      title: input.title,
      note: input.note || null,
      type: input.type ?? "todo",
      priority: input.priority ?? "none",
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      startAt: input.startAt ? new Date(input.startAt) : null,
      // Unassigned by default, and visibly so. Silently making the creator the
      // owner is how a board fills up with work nobody agreed to.
      assigneeId: input.assigneeId ?? null,
      tags: input.tags ?? [],
      position: nextPosition(siblings.map((s) => s.position)),
      createdBy: userId,
    },
    select: { id: true, assigneeId: true },
  });

  // The creator follows what they made; the assignee follows what they owe.
  await addFollowers(workspaceId, task.id, [userId, ...(task.assigneeId ? [task.assigneeId] : [])]);
  if (task.assigneeId && task.assigneeId !== userId) {
    await notifyTaskAudience(workspaceId, task.id, userId, {
      type: "task_assigned",
      title: input.title,
      body: "A new task was assigned to you.",
    });
  }

  /**
   * Board automations (playbook-v5 P20/5). Best-effort and last, so a rule
   * that throws cannot fail the creation somebody just made.
   */
  await onTaskCreated(workspaceId, task.id);

  revalidatePath("/tasks");
  return { id: task.id };
}

const updateTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().max(5000).nullable().optional(),
  type: z.enum(TASK_TYPES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueAt: z.string().nullable().optional(),
  startAt: z.string().nullable().optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});

export async function updateTask(raw: unknown): Promise<{ ok: true }> {
  const input = updateTaskSchema.parse(raw);
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const before = await db.task.findUnique({
    where: { id: input.id },
    select: { assigneeId: true, title: true, priority: true },
  });
  if (!before) throw new Error("Task not found");

  const data: Record<string, unknown> = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.note !== undefined) data.note = input.note || null;
  if (input.type !== undefined) data.type = input.type;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.dueAt !== undefined) data.dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (input.startAt !== undefined) data.startAt = input.startAt ? new Date(input.startAt) : null;
  if (input.assigneeId !== undefined) data.assigneeId = input.assigneeId;
  if (input.tags !== undefined) data.tags = input.tags;

  await db.task.update({ where: { id: input.id }, data });

  // Only on a real handover — re-saving a task without touching the assignee
  // must not fire a notification.
  if (input.assigneeId !== undefined && input.assigneeId && input.assigneeId !== before.assigneeId) {
    await addFollowers(workspaceId, input.id, [input.assigneeId]);
    await notifyTaskAudience(workspaceId, input.id, userId, {
      type: "task_assigned",
      title: input.title ?? before.title,
      body: "This task was assigned to you.",
    });
  }

  /**
   * One trigger per thing that actually changed (playbook-v5 P20/5). Compared
   * against `before` rather than fired on every save: a rule on "priority
   * changed" that fires when somebody edits the note is a rule nobody trusts.
   */
  if (input.priority !== undefined && input.priority !== before.priority) {
    await onTaskPriorityChanged(workspaceId, input.id);
  }
  if (input.assigneeId !== undefined && input.assigneeId !== before.assigneeId) {
    await onTaskAssigneeChanged(workspaceId, input.id);
  }

  revalidatePath("/tasks");
  revalidatePath("/");
  return { ok: true };
}

const moveSchema = z.object({
  id: z.string().min(1),
  sectionId: z.string().min(1).nullable(),
  afterId: z.string().min(1).nullable(),
});

/** Drag-and-drop. `afterId` is the card it was dropped below; null = top. */
export async function moveBoardTask(raw: unknown): Promise<{ ok: true }> {
  const input = moveSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const before = await db.task.findUnique({
    where: { id: input.id },
    select: { sectionId: true },
  });
  await moveTask(workspaceId, input.id, {
    sectionId: input.sectionId,
    afterId: input.afterId,
  });
  // Reordering within a column is not a move to a section: a rule on "lands in
  // Blocked" must not fire every time somebody tidies that column.
  if (before && before.sectionId !== (input.sectionId ?? null)) {
    await onTaskMoved(workspaceId, input.id);
  }
  revalidatePath("/tasks");
  return { ok: true };
}

/**
 * Tick or untick, undoably.
 *
 * Completing a parent does NOT complete its subtasks, and completing every
 * subtask does not complete the parent. A summary line that makes its children
 * vanish is how work gets lost, and a parent that closes itself takes the
 * decision away from the person who would have noticed the last step was not
 * actually finished.
 */
export async function setTaskDone(
  taskId: string,
  done: boolean,
): Promise<{ ok: true; undo?: UndoToken | null }> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, title: true, doneAt: true },
  });
  if (!task) throw new Error("Task not found");

  const doneAt = done ? new Date() : null;
  const { count } = await db.task.updateMany({
    where: { id: taskId },
    data: { doneAt, completedBy: done ? userId : null },
  });

  const undo =
    count > 0 && done
      ? await recordUndo(workspaceId, userId, {
          kind: "task_done",
          label: `Completed “${task.title}”`,
          inverse: { entity: "task", targets: [{ id: taskId, set: { doneAt: null } }] },
          expected: { [taskId]: { doneAt: doneAt!.toISOString() } },
        })
      : null;

  /**
   * A recurring task spawns its successor here (P3/3.2).
   *
   * Best-effort: a missing successor is an inconvenience, and losing it must
   * not undo a tick that has already happened.
   */
  if (count > 0 && done) {
    await spawnRecurrence(workspaceId, userId, taskId).catch(() => null);
    // Completion is a trigger; reopening is not. A rule that fired on the way
    // back out would undo itself every time somebody corrected a mis-click.
    await onTaskCompleted(workspaceId, taskId);
  }

  revalidatePath("/tasks");
  revalidatePath("/");
  return { ok: true, undo };
}

/**
 * Delete a task and its subtasks.
 *
 * The cascade here is right and the one on completion is not: deleting a
 * parent is an explicit statement that this piece of work is not happening,
 * and leaving its steps behind as orphans would be worse than removing them.
 */
export async function deleteTask(taskId: string): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.task.delete({ where: { id: taskId } });
  revalidatePath("/tasks");
  revalidatePath("/");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// detail: subtasks and comments
// ---------------------------------------------------------------------------

export interface TaskCommentView {
  id: string;
  body: string;
  userId: string;
  userName: string;
  createdAt: Date;
  editedAt: Date | null;
}

export interface TaskDetailView {
  id: string;
  boardId: string | null;
  sectionId: string | null;
  title: string;
  note: string | null;
  type: string;
  priority: string;
  tags: string[];
  dueAt: Date | null;
  startAt: Date | null;
  doneAt: Date | null;
  assigneeId: string | null;
  source: string | null;
  entityType: string | null;
  entityId: string | null;
  subtasks: Array<{ id: string; title: string; doneAt: Date | null; assigneeId: string | null }>;
  comments: TaskCommentView[];
  followers: string[];
  /** What this task is waiting for (P3/3.1), with whether it is still open. */
  blockedBy: Array<{ id: string; title: string; doneAt: Date | null }>;
  /** What is waiting for THIS one, so a delay's cost is visible. */
  blocking: Array<{ id: string; title: string }>;
  /** Null when it happens once. */
  recurrence: { cadence: string; dayOfWeek?: number; dayOfMonth?: number } | null;
  attachments: TaskAttachmentView[];
}

export async function getTaskDetail(taskId: string): Promise<TaskDetailView | null> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      boardId: true,
      sectionId: true,
      title: true,
      note: true,
      type: true,
      priority: true,
      tags: true,
      dueAt: true,
      startAt: true,
      doneAt: true,
      assigneeId: true,
      source: true,
      entityType: true,
      entityId: true,
      subtasks: {
        orderBy: { position: "asc" },
        select: { id: true, title: true, doneAt: true, assigneeId: true },
      },
      comments: {
        orderBy: { createdAt: "asc" },
        select: { id: true, body: true, userId: true, createdAt: true, editedAt: true },
      },
      followers: { select: { userId: true } },
      recurrence: true,
      blockedBy: {
        select: { blockedBy: { select: { id: true, title: true, doneAt: true } } },
      },
      blocking: {
        select: { task: { select: { id: true, title: true } } },
      },
      attachments: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          filename: true,
          path: true,
          contentType: true,
          sizeBytes: true,
          createdAt: true,
        },
      },
    },
  });
  if (!task) return null;

  const userIds = [...new Set(task.comments.map((c) => c.userId))];
  const users = userIds.length
    ? await prismaUnsafe.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true },
      })
    : [];
  const name = new Map(users.map((u) => [u.id, u.name]));

  return {
    ...task,
    tags: Array.isArray(task.tags) ? (task.tags as string[]) : [],
    comments: task.comments.map((c) => ({
      ...c,
      userName: name.get(c.userId) ?? "Someone",
    })),
    followers: task.followers.map((f) => f.userId),
    blockedBy: task.blockedBy.map((d) => d.blockedBy),
    blocking: task.blocking.map((d) => d.task),
    recurrence: readRecurrence(task.recurrence),
    attachments: task.attachments,
  };
}

export async function addSubtask(parentId: string, title: string): Promise<{ id: string }> {
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > 200) throw new Error("A subtask title is 1–200 characters.");
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const parent = await db.task.findUnique({
    where: { id: parentId },
    select: { id: true, boardId: true, sectionId: true },
  });
  if (!parent) throw new Error("Task not found");

  const siblings = await db.task.findMany({
    where: { parentId },
    select: { position: true },
  });
  const sub = await db.task.create({
    data: {
      workspaceId,
      parentId,
      // A subtask lives on its parent's board so a board-wide filter finds it,
      // but never in a section — it is rendered inside the parent's card.
      boardId: parent.boardId,
      sectionId: null,
      title: trimmed,
      position: nextPosition(siblings.map((s) => s.position)),
      createdBy: userId,
    },
    select: { id: true },
  });
  revalidatePath("/tasks");
  return { id: sub.id };
}

const commentSchema = z.object({
  taskId: z.string().min(1),
  body: z.string().trim().min(1).max(5000),
});

export async function addComment(raw: unknown): Promise<{ id: string }> {
  const input = commentSchema.parse(raw);
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const members = await getAssignableMembers();
  const mentions = extractMentions(input.body, members);

  const comment = await db.taskComment.create({
    data: {
      workspaceId,
      taskId: input.taskId,
      userId,
      body: input.body,
      // Resolved now and stored: a later rename must not silently un-mention
      // somebody who was already notified.
      mentions,
    },
    select: { id: true },
  });

  // Commenting is subscribing — and so is being named.
  await addFollowers(workspaceId, input.taskId, [userId, ...mentions]);
  const task = await db.task.findUnique({
    where: { id: input.taskId },
    select: { title: true },
  });
  await notifyTaskAudience(workspaceId, input.taskId, userId, {
    type: "task_commented",
    title: task?.title ?? "Task",
    body: input.body.slice(0, 140),
  });

  revalidatePath("/tasks");
  return { id: comment.id };
}


// ---------------------------------------------------------------------------
// a board from an audit (P1/1.3)
// ---------------------------------------------------------------------------

/**
 * Turn an audit's findings into a piece of work.
 *
 * ── WHY THIS BUTTON ─────────────────────────────────────────────────────────
 *
 * The priority matrix (P2/4) already decides what is worth doing first: every
 * failing check carries an impact and an effort, and the four quadrants are
 * "quick wins / worth planning / fill-ins / later". That was a chart. Nothing
 * carried it into work, so the plan was re-typed by hand into whatever the
 * operator happened to use.
 *
 * The four quadrants ARE four sections, in the order they should be read. Each
 * finding becomes a task with a priority derived from the same impact/effort
 * pair, so the board opens already sorted the way the matrix argued for.
 *
 * Passing checks are excluded — `buildPriorityMatrix` already does that, and
 * listing them would turn a plan back into an inventory.
 */
export async function createBoardFromAudit(
  auditId: string,
): Promise<
  | { ok: true; boardId: string; tasks: number }
  | { ok: false; error: string }
> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const audit = await db.auditResult.findUnique({
    where: { id: auditId },
    select: { id: true, url: true, checks: true, status: true, companyId: true },
  });
  if (!audit) return { ok: false, error: "Audit not found." };
  if (audit.status !== "done") {
    return { ok: false, error: "Wait for the audit to finish first." };
  }

  const checks = Array.isArray(audit.checks) ? (audit.checks as unknown as AuditCheck[]) : [];
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { auditConfig: true },
  });
  const matrix = buildPriorityMatrix(checks, priorityMapFrom(ws?.auditConfig));
  const total = matrix.quadrants.reduce((n, q) => n + q.findings.length, 0);
  if (total === 0) {
    // Nothing failing is a good result, and an empty board is not a plan.
    return { ok: false, error: "This audit has no failing checks — there is nothing to plan." };
  }

  const site = audit.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const existing = await db.taskBoard.findMany({ select: { position: true } });

  // Only quadrants that actually have findings become columns: four headings
  // with two of them empty is a board that looks unfinished on arrival.
  const used = matrix.quadrants.filter((q) => q.findings.length > 0);
  const board = await db.taskBoard.create({
    data: {
      workspaceId,
      name: `${site} — audit plan`,
      description: `From the site audit of ${audit.url}. Ordered by the impact/effort matrix.`,
      position: nextPosition(existing.map((b) => b.position)),
      createdBy: userId,
      sections: {
        create: used.map((q, i) => ({
          workspaceId,
          name: QUADRANTS.find((def) => def.id === q.id)!.en,
          position: (i + 1) * 1024,
        })),
      },
    },
    select: { id: true },
  });

  const sections = await db.taskSection.findMany({
    where: { boardId: board.id },
    orderBy: { position: "asc" },
    select: { id: true, name: true },
  });

  /**
   * Impact and effort collapse into one priority.
   *
   * The matrix keeps them as two axes because that is what makes a quadrant;
   * a task carries one field, so the mapping has to be stated somewhere. High
   * impact and cheap is the most urgent thing on any list.
   */
  const priorityFor = (impact: string, effort: string): string => {
    if (impact === "high") return effort === "quick" ? "urgent" : "high";
    if (impact === "medium") return "medium";
    return "low";
  };

  let created = 0;
  for (const q of used) {
    const sectionName = QUADRANTS.find((def) => def.id === q.id)!.en;
    const sectionId = sections.find((s) => s.name === sectionName)?.id ?? null;
    for (const [i, f] of q.findings.entries()) {
      await db.task.create({
        data: {
          workspaceId,
          boardId: board.id,
          sectionId,
          title: f.label,
          note: [
            f.detail ? `Measured: ${f.detail}` : null,
            `Impact ${f.impact} · effort ${f.effort}`,
            `From the audit of ${audit.url}`,
          ]
            .filter(Boolean)
            .join("\n"),
          priority: priorityFor(f.impact, f.effort),
          tags: f.category ? [f.category] : [],
          position: (i + 1) * 1024,
          createdBy: userId,
          source: "audit_plan",
          // Hangs off the company when the audit knows one, so the work is
          // reachable from the client rather than only from the board.
          ...(audit.companyId ? { entityType: "company", entityId: audit.companyId } : {}),
        },
      });
      created += 1;
    }
  }

  revalidatePath("/tasks");
  revalidatePath("/audit");
  return { ok: true, boardId: board.id, tasks: created };
}


// ---------------------------------------------------------------------------
// dependencies (P3/3.1)
// ---------------------------------------------------------------------------

const depSchema = z.object({
  taskId: z.string().min(1),
  blockedById: z.string().min(1),
});

/**
 * "This cannot start until that is done."
 *
 * Refused when it would close a cycle. That is the whole reason dependencies
 * were left out of the first version: "A waits for B, B waits for A" is a pair
 * of tasks that can never be started according to the graph, and once three or
 * four are involved nobody looking at the board can see why nothing is
 * startable. A badly drawn graph is worse than no graph.
 */
export async function addDependency(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const input = depSchema.safeParse(raw);
  if (!input.success) return { ok: false, error: "Unknown task." };
  const { taskId, blockedById } = input.data;
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  if (taskId === blockedById) {
    return { ok: false, error: "A task cannot wait for itself." };
  }
  // Both ends must be ours; the guarded client makes a foreign id find nothing.
  const both = await db.task.findMany({
    where: { id: { in: [taskId, blockedById] } },
    select: { id: true, title: true },
  });
  if (both.length !== 2) return { ok: false, error: "One of those tasks no longer exists." };

  const existing = await db.taskDependency.findMany({
    select: { taskId: true, blockedById: true },
  });
  /**
   * Named, not just refused (playbook-v5 P19/1).
   *
   * "That would make a loop" is all a form needed. On the timeline somebody
   * draws a dependency between two bars, and with fifteen tasks on screen the
   * useful question is WHICH chain — so the message walks it.
   */
  const cycle = cyclePath(existing as DependencyEdge[], taskId, blockedById);
  if (cycle) {
    const titles = await db.task.findMany({
      where: { id: { in: [...new Set(cycle)] } },
      select: { id: true, title: true },
    });
    const label = new Map(titles.map((t) => [t.id, t.title]));
    const chain = cycle.map((id) => label.get(id) ?? "a deleted task").join(" → ");
    return {
      ok: false,
      error: `That would make a loop: ${chain}. Nothing in that chain could ever start.`,
    };
  }

  await db.taskDependency
    .create({ data: { workspaceId, taskId, blockedById } })
    .catch(() => {
      // The unique index: asking twice is not an error.
    });
  revalidatePath("/tasks");
  return { ok: true };
}

export async function removeDependency(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const input = depSchema.safeParse(raw);
  if (!input.success) return { ok: false, error: "Unknown task." };
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.taskDependency.deleteMany({
    where: { taskId: input.data.taskId, blockedById: input.data.blockedById },
  });
  revalidatePath("/tasks");
  return { ok: true };
}

/** Candidates to depend on: other tasks on the same board. */
export async function dependencyCandidates(
  taskId: string,
): Promise<Array<{ id: string; title: string; doneAt: Date | null }>> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { boardId: true },
  });
  if (!task?.boardId) return [];
  return db.task.findMany({
    where: { boardId: task.boardId, parentId: null, id: { not: taskId } },
    orderBy: { position: "asc" },
    take: 200,
    select: { id: true, title: true, doneAt: true },
  });
}

// ---------------------------------------------------------------------------
// recurrence (P3/3.2)
// ---------------------------------------------------------------------------

const recurrenceSchema = z.object({
  taskId: z.string().min(1),
  recurrence: z
    .object({
      cadence: z.enum(["daily", "weekly", "monthly"]),
      dayOfWeek: z.coerce.number().int().min(1).max(7).optional(),
      dayOfMonth: z.coerce.number().int().min(1).max(28).optional(),
    })
    .nullable(),
});

export async function setRecurrence(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const input = recurrenceSchema.safeParse(raw);
  if (!input.success) return { ok: false, error: "Check the repeat settings." };
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.task.update({
    where: { id: input.data.taskId },
    data: { recurrence: (input.data.recurrence ?? null) as never },
  });
  revalidatePath("/tasks");
  return { ok: true };
}

/**
 * Spawn the successor of a completed recurring task.
 *
 * ── WHY ON COMPLETION AND NOT ON A TIMER ────────────────────────────────────
 *
 * A timer that generates instances fills a board with future copies of the
 * same task, and a task nobody ticked piles up behind the ones nobody ticked
 * before it. Spawning on completion means the board always holds exactly one
 * of each recurring task: the next one.
 *
 * Called from `setTaskDone`. Never throws outward — a successor is a
 * convenience, and losing it must not undo a tick that already happened.
 */
async function spawnRecurrence(
  workspaceId: string,
  userId: string,
  taskId: string,
): Promise<string | null> {
  const db = getWorkspaceClient(workspaceId);
  const done = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      boardId: true,
      sectionId: true,
      title: true,
      note: true,
      type: true,
      priority: true,
      tags: true,
      assigneeId: true,
      entityType: true,
      entityId: true,
      recurrence: true,
      position: true,
    },
  });
  const rule = readRecurrence(done?.recurrence);
  if (!done || !rule) return null;

  // Same arithmetic as a scheduled export, so "the first Monday of every
  // month" is computed by one tested function rather than two.
  const due = nextRunAt(
    {
      cadence: rule.cadence,
      dayOfWeek: rule.dayOfWeek ?? 1,
      dayOfMonth: rule.dayOfMonth ?? 1,
      hour: 17,
    },
    new Date(Date.now() + 60_000),
  );

  const next = await db.task.create({
    data: {
      workspaceId,
      boardId: done.boardId,
      sectionId: done.sectionId,
      title: done.title,
      note: done.note,
      type: done.type,
      priority: done.priority,
      tags: done.tags as never,
      assigneeId: done.assigneeId,
      entityType: done.entityType,
      entityId: done.entityId,
      dueAt: due,
      // The rule travels with the successor, or the chain stops after one.
      recurrence: done.recurrence as never,
      recurredFromId: done.id,
      position: done.position,
      createdBy: userId,
      source: "recurring",
    },
    select: { id: true },
  });
  // Whoever owes it should hear about it, exactly as for a fresh assignment.
  if (done.assigneeId) await addFollowers(workspaceId, next.id, [done.assigneeId]);
  return next.id;
}

// ---------------------------------------------------------------------------
// templates (P3/3.3)
// ---------------------------------------------------------------------------

export interface BoardTemplateSummary {
  id: string;
  name: string;
  description: string | null;
  sections: number;
  tasks: number;
}

export async function listBoardTemplates(): Promise<BoardTemplateSummary[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.taskBoard.findMany({
    where: { isTemplate: true, archivedAt: null },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      description: true,
      _count: { select: { sections: true, tasks: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    sections: r._count.sections,
    tasks: r._count.tasks,
  }));
}

/**
 * Turn a board into a template, or a template back into a board.
 *
 * A template IS a board — named sections holding tasks with titles, notes and
 * priorities — so this is a flag rather than a copy. Its tasks keep their
 * relative due offsets instead of dates, because "three days after we start"
 * is the only thing a template can honestly say.
 */
export async function setBoardTemplate(
  boardId: string,
  isTemplate: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const board = await db.taskBoard.findUnique({ where: { id: boardId }, select: { id: true } });
  if (!board) return { ok: false, error: "That board no longer exists." };

  await db.taskBoard.update({ where: { id: boardId }, data: { isTemplate } });
  if (isTemplate) {
    // Absolute dates make no sense on a template. Convert each one into an
    // offset from today so the shape of the plan survives.
    const tasks = await db.task.findMany({
      where: { boardId, dueAt: { not: null } },
      select: { id: true, dueAt: true },
    });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (const t of tasks) {
      const days = Math.max(
        0,
        Math.round((t.dueAt!.getTime() - today.getTime()) / 86_400_000),
      );
      await db.task.update({
        where: { id: t.id },
        data: { dueOffsetDays: days, dueAt: null },
      });
    }
  }
  revalidatePath("/tasks");
  return { ok: true };
}

const fromTemplateSchema = z.object({
  templateId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
});

/**
 * A new board, copied from a template.
 *
 * Sections, tasks, notes, priorities and tags come across; assignees and
 * comments do not. An onboarding template that arrives pre-assigned to
 * whoever happened to build it is a board somebody has to un-assign first, and
 * a comment from a previous engagement is somebody else's conversation.
 */
export async function createBoardFromTemplate(
  raw: unknown,
): Promise<{ ok: true; boardId: string; tasks: number } | { ok: false; error: string }> {
  const input = fromTemplateSchema.safeParse(raw);
  if (!input.success) return { ok: false, error: "Check the name." };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const template = await db.taskBoard.findUnique({
    where: { id: input.data.templateId },
    select: {
      id: true,
      isTemplate: true,
      color: true,
      description: true,
      sections: { orderBy: { position: "asc" }, select: { id: true, name: true, position: true } },
    },
  });
  if (!template || !template.isTemplate) {
    return { ok: false, error: "That template no longer exists." };
  }

  const existing = await db.taskBoard.findMany({
    where: { isTemplate: false },
    select: { position: true },
  });
  const board = await db.taskBoard.create({
    data: {
      workspaceId,
      name: input.data.name,
      description: template.description,
      color: template.color,
      position: nextPosition(existing.map((b) => b.position)),
      createdBy: userId,
      sections: {
        create: template.sections.map((s) => ({
          workspaceId,
          name: s.name,
          position: s.position,
        })),
      },
    },
    select: { id: true },
  });

  const newSections = await db.taskSection.findMany({
    where: { boardId: board.id },
    orderBy: { position: "asc" },
    select: { id: true, name: true },
  });
  const sectionFor = new Map(
    template.sections.map((s, i) => [s.id, newSections[i]?.id ?? null] as const),
  );

  const sourceTasks = await db.task.findMany({
    where: { boardId: template.id, parentId: null },
    orderBy: { position: "asc" },
    select: {
      id: true,
      sectionId: true,
      title: true,
      note: true,
      type: true,
      priority: true,
      tags: true,
      dueOffsetDays: true,
      position: true,
    },
  });

  const today = new Date();
  today.setHours(17, 0, 0, 0);
  let created = 0;
  for (const t of sourceTasks) {
    const dueAt =
      t.dueOffsetDays === null
        ? null
        : new Date(today.getTime() + t.dueOffsetDays * 86_400_000);
    await db.task.create({
      data: {
        workspaceId,
        boardId: board.id,
        sectionId: t.sectionId ? (sectionFor.get(t.sectionId) ?? null) : null,
        title: t.title,
        note: t.note,
        type: t.type,
        priority: t.priority,
        tags: t.tags as never,
        dueAt,
        position: t.position,
        createdBy: userId,
        source: "template",
      },
    });
    created += 1;
  }

  revalidatePath("/tasks");
  return { ok: true, boardId: board.id, tasks: created };
}

// ---------------------------------------------------------------------------
// my work, across boards (P3/3.4)
// ---------------------------------------------------------------------------

export interface MyWorkItem {
  id: string;
  /** call | email | todo | follow_up. Needed to satisfy TaskLike, which the
   *  shared bucketing works over — one shape, one set of due-ness rules. */
  type: string;
  title: string;
  priority: string;
  dueAt: Date | null;
  boardId: string | null;
  boardName: string | null;
  sectionName: string | null;
  entityLabel: string | null;
  entityHref: string | null;
  blockedCount: number;
  /**
   * Added for the My Work screen (playbook-v5 P18/1). Each answers a question
   * the flat list could not: what kind of work this is, how far through it is,
   * and — the one that matters — whether WE raised it or the person did.
   */
  tags: string[];
  subtasks: { done: number; total: number } | null;
  /** Set when the system created it. "raised from a signal", not their idea. */
  source: string | null;
  doneAt: Date | null;
}

/**
 * Everything assigned to me, across every board.
 *
 * ── WHY THIS IS NOT THE DASHBOARD PANEL ─────────────────────────────────────
 *
 * The dashboard panel groups by urgency and knows nothing about boards: it
 * cannot say which piece of work a task came from, which is the first thing
 * somebody asks when they see it. A board answers "where is everything"; this
 * answers "what do I do next", which is a sort across all of them.
 */
export async function myWork(): Promise<MyWorkItem[]> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  /**
   * Two queries, not one — and a defect an e2e flake exposed.
   *
   * This was `orderBy: [{ dueAt: "asc" }, ...]` with `take: 200`, which leans
   * on the database's default placement of NULLs. Postgres puts them LAST for
   * an ascending sort and MySQL puts them FIRST, so the same code would order
   * "My work" differently on the two flavours the schema is written for — and
   * on Postgres an UNDATED task fell off the end of the two hundred whenever
   * enough dated ones existed. Work assigned to somebody, silently invisible.
   *
   * Prisma's `nulls` option would say it explicitly but is not supported on
   * MySQL, so the placement is decided here instead: dated first, ordered by
   * when they are due; undated after them. That is also the right reading —
   * something with a date on it is the more urgent thing.
   */
  const SELECT = {
    id: true,
    type: true,
    title: true,
    priority: true,
    dueAt: true,
    doneAt: true,
    boardId: true,
    entityType: true,
    entityId: true,
    tags: true,
    source: true,
    board: { select: { name: true } },
    section: { select: { name: true } },
  } as const;
  const MINE = { doneAt: null, parentId: null, assigneeId: userId } as const;

  const dated = await db.task.findMany({
    where: { ...MINE, dueAt: { not: null } },
    orderBy: [{ dueAt: "asc" }, { position: "asc" }],
    take: MY_WORK_LIMIT,
    select: SELECT,
  });
  const undated =
    dated.length < MY_WORK_LIMIT
      ? await db.task.findMany({
          where: { ...MINE, dueAt: null },
          orderBy: [{ priority: "asc" }, { position: "asc" }],
          take: MY_WORK_LIMIT - dated.length,
          select: SELECT,
        })
      : [];
  const rows = [...dated, ...undated];
  if (rows.length === 0) return [];

  // What is still waiting on something, so the list can say so rather than
  // presenting a blocked task as the next thing to pick up.
  const deps = await db.taskDependency.findMany({
    where: { taskId: { in: rows.map((r) => r.id) } },
    select: { taskId: true, blockedById: true },
  });
  const blockerIds = [...new Set(deps.map((d) => d.blockedById))];
  const blockers = blockerIds.length
    ? await db.task.findMany({
        where: { id: { in: blockerIds } },
        select: { id: true, doneAt: true },
      })
    : [];
  const open = new Set(blockers.filter((b) => !b.doneAt).map((b) => b.id));
  const blockedCount = new Map<string, number>();
  for (const d of deps) {
    if (!open.has(d.blockedById)) continue;
    blockedCount.set(d.taskId, (blockedCount.get(d.taskId) ?? 0) + 1);
  }

  /**
   * Subtask progress, in one grouped query rather than one per row.
   *
   * "3/7" is the difference between a list of titles and a list you can judge
   * how much is left in.
   */
  const children = await db.task.groupBy({
    by: ["parentId"],
    where: { parentId: { in: rows.map((r) => r.id) } },
    _count: { _all: true },
  });
  const childrenDone = await db.task.groupBy({
    by: ["parentId"],
    where: { parentId: { in: rows.map((r) => r.id) }, doneAt: { not: null } },
    _count: { _all: true },
  });
  const doneByParent = new Map(childrenDone.map((c) => [c.parentId, c._count._all]));
  const subtaskProgress = new Map<string, { done: number; total: number }>();
  for (const group of children) {
    if (!group.parentId) continue;
    subtaskProgress.set(group.parentId, {
      done: doneByParent.get(group.parentId) ?? 0,
      total: group._count._all,
    });
  }

  const leadIds = rows.filter((r) => r.entityType === "lead" && r.entityId).map((r) => r.entityId!);
  const companyIds = rows
    .filter((r) => r.entityType === "company" && r.entityId)
    .map((r) => r.entityId!);
  const [leads, companies] = await Promise.all([
    leadIds.length
      ? db.lead.findMany({
          where: { id: { in: leadIds } },
          select: { id: true, contactName: true, company: { select: { name: true } } },
        })
      : Promise.resolve([]),
    companyIds.length
      ? db.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ]);
  const leadLabel = new Map(leads.map((l) => [l.id, l.contactName || l.company?.name || "lead"]));
  const companyLabel = new Map(companies.map((c) => [c.id, c.name]));

  return rows.map((r) => {
    /**
     * One resolver for the chip (playbook-v5 P20/4). This chain used to be
     * written out in three files with three slightly different sets of cases,
     * which is how a company-linked task ended up pointing at a query
     * parameter nobody read.
     */
    const { label: entityLabel, href: entityHref } = chipFor(r, {
      lead: leadLabel,
      company: companyLabel,
    });
    return {
      id: r.id,
      type: r.type,
      title: r.title,
      priority: r.priority,
      dueAt: r.dueAt,
      boardId: r.boardId,
      boardName: r.board?.name ?? null,
      sectionName: r.section?.name ?? null,
      entityLabel,
      entityHref,
      blockedCount: blockedCount.get(r.id) ?? 0,
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
      subtasks: subtaskProgress.get(r.id) ?? null,
      source: r.source ?? null,
      doneAt: r.doneAt,
    };
  });
}


// ---------------------------------------------------------------------------
// attachments (P3/3.5)
// ---------------------------------------------------------------------------

export interface TaskAttachmentView {
  id: string;
  filename: string;
  path: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
}

export async function listAttachments(taskId: string): Promise<TaskAttachmentView[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  return db.taskAttachment.findMany({
    where: { taskId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      filename: true,
      path: true,
      contentType: true,
      sizeBytes: true,
      createdAt: true,
    },
  });
}

const attachSchema = z.object({
  taskId: z.string().min(1),
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
  /** The file itself, base64. Bounded by MAX_ATTACHMENT_BYTES after decoding. */
  base64: z.string().min(1),
});

export async function addAttachment(
  raw: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const input = attachSchema.safeParse(raw);
  if (!input.success) return { ok: false, error: "That file could not be read." };
  if (!ALLOWED_ATTACHMENT_TYPES.has(input.data.contentType)) {
    return {
      ok: false,
      error: "That file type is not accepted. Documents, spreadsheets, images, PDFs and zips are.",
    };
  }

  const bytes = Buffer.from(input.data.base64, "base64");
  if (bytes.length === 0) return { ok: false, error: "That file is empty." };
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: `That file is ${Math.round(bytes.length / 1_000_000)} MB; the limit is ${
        MAX_ATTACHMENT_BYTES / 1_000_000
      } MB.`,
    };
  }

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const task = await db.task.findUnique({ where: { id: input.data.taskId }, select: { id: true } });
  if (!task) return { ok: false, error: "That task no longer exists." };

  const count = await db.taskAttachment.count({ where: { taskId: input.data.taskId } });
  if (count >= MAX_ATTACHMENTS_PER_TASK) {
    return { ok: false, error: `A task holds at most ${MAX_ATTACHMENTS_PER_TASK} files.` };
  }

  /**
   * The stored name is generated, never the uploaded one.
   *
   * A filename from a browser is attacker-controlled text: "../../.env" is a
   * path, and a duplicate name would overwrite somebody else's file. The
   * original is kept in the row for display only.
   */
  const ext = (input.data.filename.split(".").pop() ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const rel = `tasks/${input.data.taskId}-${randomBytes(8).toString("hex")}${ext ? `.${ext}` : ""}`;
  await mkdir(join(FILES_DIR, "tasks"), { recursive: true });
  await writeFile(join(FILES_DIR, rel), bytes);

  const row = await db.taskAttachment.create({
    data: {
      workspaceId,
      taskId: input.data.taskId,
      filename: input.data.filename,
      path: rel,
      contentType: input.data.contentType,
      sizeBytes: bytes.length,
      uploadedBy: userId,
    },
    select: { id: true },
  });
  revalidatePath("/tasks");
  return { ok: true, id: row.id };
}

export async function deleteAttachment(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const row = await db.taskAttachment.findUnique({ where: { id }, select: { path: true } });
  if (!row) return { ok: false, error: "That file no longer exists." };

  await db.taskAttachment.delete({ where: { id } });
  // The row is the record; a file left on disk is a leak, but a failed unlink
  // must not leave a row pointing at nothing.
  await unlink(join(FILES_DIR, row.path)).catch(() => {});
  revalidatePath("/tasks");
  return { ok: true };
}

/**
 * Reschedule by dropping into a bucket (playbook-v5 P18/1).
 *
 * The rule each bucket applies is stated in the UI (WORK_BUCKET_RULE) rather
 * than left for somebody to infer, and `overdue` is refused because nobody
 * means "make this late".
 *
 * Undoable, because a drag is the easiest thing in the product to do by
 * accident.
 */
export async function rescheduleToBucket(
  taskId: string,
  bucket: string,
): Promise<{ ok: true; undo: UndoToken | null } | { ok: false; error: string }> {
  if (!(WORK_BUCKETS as readonly string[]).includes(bucket)) {
    return { ok: false, error: "That is not a bucket." };
  }
  const target = dueDateForBucket(bucket as WorkBucket);
  if (target === undefined) {
    return { ok: false, error: WORK_BUCKET_RULE.overdue };
  }

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const before = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, title: true, dueAt: true, startAt: true },
  });
  if (!before) return { ok: false, error: "Task not found." };

  // The same rule the inline edit and the bulk action enforce.
  if (target && before.startAt && before.startAt.getTime() > target.getTime()) {
    return { ok: false, error: "A task cannot be due before it starts." };
  }

  await db.task.update({ where: { id: taskId }, data: { dueAt: target } });

  const undo = await recordUndo(workspaceId, userId, {
    kind: "bulk_signals",
    label: `Moved “${before.title}” to ${WORK_BUCKET_LABEL[bucket as WorkBucket]}`,
    inverse: { entity: "task", targets: [{ id: taskId, set: { dueAt: before.dueAt } }] },
    expected: { [taskId]: { dueAt: target ? target.toISOString() : null } },
  });

  revalidatePath("/tasks");
  revalidatePath("/");
  return { ok: true, undo };
}
