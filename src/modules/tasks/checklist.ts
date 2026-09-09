/**
 * Checklists — reads and writes (playbook-v5 P20/3).
 *
 * ── THE DISTINCTION, IN ONE LINE ────────────────────────────────────────────
 *
 * A checklist is the steps WITHIN this task; a subtask is work somebody else
 * may own. That sentence is in the UI, because without it the two controls sit
 * side by side and nobody knows which to reach for — and the answer decides
 * whether the thing can be assigned, scheduled and reported on.
 *
 * ── AND WHAT A CHECKLIST DOES NOT DO ────────────────────────────────────────
 *
 * Ticking every item does NOT complete the task. The playbook is explicit, and
 * it matches the existing rule that a parent never completes from its
 * subtasks: deciding the work is finished belongs to the person who can see
 * whether the last step was real.
 */

import { getWorkspaceClient } from "@/lib/db";
import {
  MAX_CHECKLIST_ITEMS,
  MAX_ITEM_LENGTH,
  nextPosition,
  progressOf,
  type ChecklistItem,
  type ChecklistProgress,
} from "./checklist-logic";

export type { ChecklistItem, ChecklistProgress };

export async function listChecklist(
  workspaceId: string,
  taskId: string,
): Promise<ChecklistItem[]> {
  const db = getWorkspaceClient(workspaceId);
  return db.taskChecklistItem.findMany({
    where: { taskId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, text: true, doneAt: true, position: true },
  });
}

export async function addChecklistItem(
  workspaceId: string,
  taskId: string,
  text: string,
): Promise<{ ok: true; item: ChecklistItem } | { ok: false; error: string }> {
  const clean = text.trim().slice(0, MAX_ITEM_LENGTH);
  if (!clean) return { ok: false, error: "Give the step some words." };

  const db = getWorkspaceClient(workspaceId);
  const task = await db.task.findUnique({ where: { id: taskId }, select: { id: true } });
  if (!task) return { ok: false, error: "Task not found." };

  const existing = await db.taskChecklistItem.findMany({
    where: { taskId },
    select: { position: true },
  });
  /**
   * Capped. Fifty steps inside one task is a sign the task should have been
   * split, and an uncapped list would make the detail panel unusable long
   * before anybody noticed.
   */
  if (existing.length >= MAX_CHECKLIST_ITEMS) {
    return {
      ok: false,
      error: `Fifty steps is the limit — past that, this wants to be several tasks.`,
    };
  }

  const item = await db.taskChecklistItem.create({
    data: {
      workspaceId,
      taskId,
      text: clean,
      position: nextPosition(existing.map((e) => e.position)),
    },
    select: { id: true, text: true, doneAt: true, position: true },
  });
  return { ok: true, item };
}

export async function setChecklistItemDone(
  workspaceId: string,
  itemId: string,
  done: boolean,
): Promise<{ ok: true; progress: ChecklistProgress } | { ok: false; error: string }> {
  const db = getWorkspaceClient(workspaceId);
  const item = await db.taskChecklistItem.findUnique({
    where: { id: itemId },
    select: { id: true, taskId: true },
  });
  if (!item) return { ok: false, error: "That step no longer exists." };

  await db.taskChecklistItem.update({
    where: { id: itemId },
    data: { doneAt: done ? new Date() : null },
  });

  /**
   * NOTHING TOUCHES THE TASK HERE.
   *
   * The task's `doneAt` is not written, not even when the last item is ticked.
   * That is the rule, and this is the only place it could have been broken.
   */
  const items = await db.taskChecklistItem.findMany({
    where: { taskId: item.taskId },
    select: { doneAt: true },
  });
  return { ok: true, progress: progressOf(items) };
}

export async function editChecklistItem(
  workspaceId: string,
  itemId: string,
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const clean = text.trim().slice(0, MAX_ITEM_LENGTH);
  if (!clean) return { ok: false, error: "Give the step some words." };
  const db = getWorkspaceClient(workspaceId);
  const { count } = await db.taskChecklistItem.updateMany({
    where: { id: itemId },
    data: { text: clean },
  });
  return count > 0 ? { ok: true } : { ok: false, error: "That step no longer exists." };
}

export async function removeChecklistItem(
  workspaceId: string,
  itemId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getWorkspaceClient(workspaceId);
  const { count } = await db.taskChecklistItem.deleteMany({ where: { id: itemId } });
  return count > 0 ? { ok: true } : { ok: false, error: "That step no longer exists." };
}

/**
 * Promote a step to a real subtask, in one action.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The playbook asks for it, and it is the right escape hatch: somebody writes
 * a step, then discovers it needs an owner and a date. Without this they have
 * to retype it as a subtask and delete the step, which is exactly the friction
 * that makes people avoid the lighter tool in the first place.
 *
 * The step is REMOVED, not left ticked. Two records of one piece of work is
 * how a progress count starts lying.
 */
export async function promoteToSubtask(
  workspaceId: string,
  itemId: string,
): Promise<{ ok: true; subtaskId: string } | { ok: false; error: string }> {
  const db = getWorkspaceClient(workspaceId);
  const item = await db.taskChecklistItem.findUnique({
    where: { id: itemId },
    select: { id: true, text: true, doneAt: true, taskId: true },
  });
  if (!item) return { ok: false, error: "That step no longer exists." };

  const parent = await db.task.findUnique({
    where: { id: item.taskId },
    select: { id: true, boardId: true, sectionId: true, parentId: true },
  });
  if (!parent) return { ok: false, error: "Task not found." };
  /**
   * Subtasks are one level deep. Promoting a step on a subtask would make a
   * grandchild, and the progress counts, the board query and the timeline's
   * indentation all assume two levels.
   */
  if (parent.parentId) {
    return {
      ok: false,
      error: "This task is already a subtask — promote the step on its parent instead.",
    };
  }

  const siblings = await db.task.findMany({
    where: { parentId: parent.id },
    select: { position: true },
  });

  const subtask = await db.task.create({
    data: {
      workspaceId,
      title: item.text,
      parentId: parent.id,
      boardId: parent.boardId,
      sectionId: parent.sectionId,
      // A ticked step becomes a completed subtask: the fact it was done is
      // worth keeping, and resetting it would lose work.
      doneAt: item.doneAt,
      position: nextPosition(siblings.map((s) => s.position)),
    },
    select: { id: true },
  });

  await db.taskChecklistItem.delete({ where: { id: itemId } });
  return { ok: true, subtaskId: subtask.id };
}
