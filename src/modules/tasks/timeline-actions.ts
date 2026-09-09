"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import { getWorkspaceClient } from "@/lib/db";
import { recordUndo, type UndoToken } from "../undo/store";
import {
  applyDrag,
  brokenDependents,
  planDependentShift,
  type DragMode,
  type TimelineTask,
} from "./timeline";

/**
 * The timeline's writes (playbook-v5 P19/1).
 *
 * ── ALL OF THEM ARE UNDOABLE ────────────────────────────────────────────────
 *
 * A Gantt chart is the surface where an accidental drag is most expensive: a
 * bar nudged two days looks identical to one that was always there, and the
 * person who nudged it may not notice for a week. So every date change records
 * an inverse, including the confirmed downstream shift, which puts the whole
 * chain back in one go.
 */

export interface TimelineTaskRow {
  id: string;
  title: string;
  startAt: string | null;
  dueAt: string | null;
  doneAt: string | null;
  parentId: string | null;
  priority: string;
}

export interface TimelineView {
  tasks: TimelineTaskRow[];
  edges: { taskId: string; blockedById: string }[];
}

export async function getTimeline(boardId: string): Promise<TimelineView> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const tasks = await db.task.findMany({
    where: { boardId },
    orderBy: [{ parentId: "asc" }, { position: "asc" }],
    select: {
      id: true,
      title: true,
      startAt: true,
      dueAt: true,
      doneAt: true,
      parentId: true,
      priority: true,
    },
    // Bounded: past this a timeline is a wall, not a chart.
    take: 1000,
  });
  const ids = tasks.map((t) => t.id);
  const edges = ids.length
    ? await db.taskDependency.findMany({
        where: { taskId: { in: ids } },
        select: { taskId: true, blockedById: true },
      })
    : [];

  return {
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      startAt: t.startAt?.toISOString() ?? null,
      dueAt: t.dueAt?.toISOString() ?? null,
      doneAt: t.doneAt?.toISOString() ?? null,
      parentId: t.parentId,
      priority: t.priority,
    })),
    edges,
  };
}

const dragSchema = z.object({
  taskId: z.string().min(1).max(60),
  mode: z.enum(["move", "resize-start", "resize-end"]),
  days: z.number().int().min(-3650).max(3650),
});

export interface DragOutcome {
  ok: true;
  undo: UndoToken | null;
  /** Dependents that now start before their blocker ends. Never auto-shifted. */
  broken: { taskId: string; title: string; shiftDays: number }[];
}

export async function dragTimelineTask(
  raw: unknown,
): Promise<DragOutcome | { ok: false; error: string }> {
  const parsed = dragSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That drag is not valid." };
  const { taskId, mode, days } = parsed.data;

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const row = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      startAt: true,
      dueAt: true,
      doneAt: true,
      parentId: true,
      priority: true,
      boardId: true,
    },
  });
  if (!row) return { ok: false, error: "Task not found." };

  const next = applyDrag(row as TimelineTask, mode as DragMode, days);
  if (!next) {
    return { ok: false, error: "There is no date on that task to move." };
  }

  await db.task.update({
    where: { id: taskId },
    data: { startAt: next.startAt, dueAt: next.dueAt },
  });

  const undo = await recordUndo(workspaceId, userId, {
    kind: "bulk_signals",
    label: `Moved “${row.title}” on the timeline`,
    inverse: {
      entity: "task",
      targets: [{ id: taskId, set: { startAt: row.startAt, dueAt: row.dueAt } }],
    },
    expected: {
      [taskId]: {
        startAt: next.startAt ? next.startAt.toISOString() : null,
        dueAt: next.dueAt ? next.dueAt.toISOString() : null,
      },
    },
  });

  /**
   * Who this broke — REPORTED, not fixed.
   *
   * The playbook is explicit that nothing cascades silently. Moving a blocker
   * later does not drag its dependents with it; the caller highlights them and
   * offers a shift the person confirms.
   */
  const siblings = await db.task.findMany({
    where: { boardId: row.boardId },
    select: { id: true, title: true, startAt: true, dueAt: true, doneAt: true, parentId: true, priority: true },
  });
  const edges = await db.taskDependency.findMany({
    where: { blockedById: taskId },
    select: { taskId: true, blockedById: true },
  });
  const titles = new Map(siblings.map((t) => [t.id, t.title]));
  const broken = brokenDependents(siblings as TimelineTask[], edges, taskId).map((b) => ({
    taskId: b.taskId,
    title: titles.get(b.taskId) ?? "a task",
    shiftDays: b.shiftDays,
  }));

  revalidatePath("/tasks");
  return { ok: true, undo, broken };
}

/**
 * The confirmed downstream shift.
 *
 * One undo entry for the whole chain: somebody who agreed to move six tasks
 * wants one press to put all six back, not six.
 */
export async function shiftDependentsAction(
  taskId: string,
): Promise<{ ok: true; moved: number; undo: UndoToken | null } | { ok: false; error: string }> {
  const parsed = z.string().min(1).max(60).safeParse(taskId);
  if (!parsed.success) return { ok: false, error: "Unknown task." };

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const moved = await db.task.findUnique({
    where: { id: parsed.data },
    select: { id: true, boardId: true, title: true },
  });
  if (!moved) return { ok: false, error: "Task not found." };

  const tasks = await db.task.findMany({
    where: { boardId: moved.boardId },
    select: { id: true, title: true, startAt: true, dueAt: true, doneAt: true, parentId: true, priority: true },
  });
  const edges = await db.taskDependency.findMany({
    where: { taskId: { in: tasks.map((t) => t.id) } },
    select: { taskId: true, blockedById: true },
  });

  const plan = planDependentShift(tasks as TimelineTask[], edges, parsed.data);
  if (plan.size === 0) return { ok: true, moved: 0, undo: null };

  const before = new Map(tasks.map((t) => [t.id, { startAt: t.startAt, dueAt: t.dueAt }]));
  for (const [id, dates] of plan) {
    await db.task.update({ where: { id }, data: dates });
  }

  const undo = await recordUndo(workspaceId, userId, {
    kind: "bulk_signals",
    label: `Shifted ${plan.size} dependent task${plan.size === 1 ? "" : "s"}`,
    inverse: {
      entity: "task",
      targets: [...plan.keys()].map((id) => ({
        id,
        set: {
          startAt: before.get(id)?.startAt ?? null,
          dueAt: before.get(id)?.dueAt ?? null,
        },
      })),
    },
    expected: Object.fromEntries(
      [...plan.entries()].map(([id, dates]) => [
        id,
        { startAt: dates.startAt.toISOString(), dueAt: dates.dueAt.toISOString() },
      ]),
    ),
  });

  revalidatePath("/tasks");
  return { ok: true, moved: plan.size, undo };
}
