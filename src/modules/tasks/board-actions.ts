"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { isSafeColor } from "@/modules/workspaces/brand";
import { recordUndo, type UndoToken } from "../undo/store";
import { TASK_TYPES } from "./logic";
import { buildPriorityMatrix, priorityMapFrom, QUADRANTS } from "@/modules/audit/priority";
import type { AuditCheck } from "@/modules/audit/types";
import { TASK_PRIORITIES, extractMentions, nextPosition } from "./board-logic";
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
  const memberships = await prismaUnsafe.membership.findMany({
    where: { workspaceId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    email: m.user.email,
  }));
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
export async function archiveBoard(boardId: string, archived: boolean): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.taskBoard.update({
    where: { id: boardId },
    data: { archivedAt: archived ? new Date() : null },
  });
  revalidatePath("/tasks");
  return { ok: true };
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
    select: { assigneeId: true, title: true },
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
  await moveTask(workspaceId, input.id, {
    sectionId: input.sectionId,
    afterId: input.afterId,
  });
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
