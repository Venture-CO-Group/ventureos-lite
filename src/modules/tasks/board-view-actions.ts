"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import {
  COMPLETION_FILTERS,
  GROUP_BYS,
  writeForGroup,
  type GroupBy,
} from "./grouping";
import { WORK_BUCKETS, dueDateForBucket, type WorkBucket } from "./logic";
import {
  createTaskView,
  deleteTaskView,
  listTaskViews,
  updateTaskView,
  type TaskBoardView,
} from "./board-views";
import { recordUndo, type UndoToken } from "../undo/store";

const filterSchema = z.object({
  assigneeId: z.string().min(1).max(60).nullable(),
  priority: z.string().min(1).max(20).nullable(),
  tag: z.string().min(1).max(40).nullable(),
  due: z.enum(WORK_BUCKETS).nullable(),
  completion: z.enum(COMPLETION_FILTERS),
  blocked: z.boolean().nullable(),
});

const viewSchema = z.object({
  name: z.string().trim().min(1).max(60),
  shared: z.boolean(),
  boardId: z.string().min(1).max(60).nullable(),
  groupBy: z.enum(GROUP_BYS),
  filter: filterSchema,
});

export async function getTaskViews(): Promise<TaskBoardView[]> {
  const { workspaceId, userId } = await getActiveContext();
  return listTaskViews(workspaceId, userId);
}

export async function saveTaskView(
  raw: unknown,
): Promise<{ ok: true; view: TaskBoardView } | { ok: false; error: string }> {
  const parsed = viewSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the view and try again." };
  const { workspaceId, userId } = await getActiveContext();
  const res = await createTaskView(workspaceId, userId, parsed.data);
  if (res.ok) revalidatePath("/tasks");
  return res;
}

export async function patchTaskView(
  id: string,
  raw: unknown,
): Promise<{ ok: true; view: TaskBoardView } | { ok: false; error: string }> {
  const parsed = viewSchema.partial().safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the view and try again." };
  const { workspaceId, userId, role } = await getActiveContext();
  const res = await updateTaskView(workspaceId, userId, role, id, parsed.data);
  if (res.ok) revalidatePath("/tasks");
  return res;
}

export async function removeTaskView(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspaceId, userId, role } = await getActiveContext();
  const res = await deleteTaskView(workspaceId, userId, role, id);
  if (res.ok) revalidatePath("/tasks");
  return res;
}

/**
 * A card dropped into a group (playbook-v5 P18/2).
 *
 * ── THIS IS NOT A MOVE ──────────────────────────────────────────────────────
 *
 * Grouping is a view concern. Dragging into "High" sets priority high; into a
 * person's column assigns it; into a due bucket reschedules it. `sectionId`
 * and `position` are NOT touched — those are what dragging means when the
 * board is grouped by section, which goes through `moveBoardTask` instead.
 *
 * The caller cannot ask for a section change here: `writeForGroup` returns
 * null for `section`, and a null is refused rather than quietly reinterpreted.
 */
export async function regroupTask(
  taskId: string,
  groupBy: string,
  groupKey: string,
): Promise<{ ok: true; undo: UndoToken | null } | { ok: false; error: string }> {
  const by = z.enum(GROUP_BYS).safeParse(groupBy);
  if (!by.success) return { ok: false, error: "That is not a grouping." };
  if (by.data === "section") {
    return { ok: false, error: "Moving between columns is a move, not a regroup." };
  }

  const write = writeForGroup(by.data as GroupBy, groupKey);
  if (!write) return { ok: false, error: "Nothing can be dropped into that group." };

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const before = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      priority: true,
      assigneeId: true,
      dueAt: true,
      startAt: true,
      tags: true,
      sectionId: true,
    },
  });
  if (!before) return { ok: false, error: "Task not found." };

  let data: Record<string, unknown>;
  let inverse: Record<string, unknown>;
  let label: string;

  if (write.field === "priority") {
    data = { priority: write.value };
    inverse = { priority: before.priority };
    label = `Set “${before.title}” to ${write.value}`;
  } else if (write.field === "assigneeId") {
    if (write.value) {
      const member = await prismaUnsafe.membership.findUnique({
        where: { userId_workspaceId: { userId: write.value, workspaceId } },
        select: { state: true },
      });
      if (!member) return { ok: false, error: "That person is not in this workspace." };
      if (member.state !== "ACTIVE") {
        return { ok: false, error: "That person's access is suspended." };
      }
    }
    data = { assigneeId: write.value };
    inverse = { assigneeId: before.assigneeId };
    label = write.value ? `Reassigned “${before.title}”` : `Unassigned “${before.title}”`;
  } else if (write.field === "dueBucket") {
    const target = dueDateForBucket(write.value as WorkBucket);
    if (target === undefined) return { ok: false, error: "You cannot make work overdue." };
    // The same rule the inline edit and the bulk action enforce.
    if (target && before.startAt && before.startAt.getTime() > target.getTime()) {
      return { ok: false, error: "A task cannot be due before it starts." };
    }
    data = { dueAt: target };
    inverse = { dueAt: before.dueAt };
    label = `Rescheduled “${before.title}”`;
  } else {
    const tags = Array.isArray(before.tags) ? (before.tags as string[]) : [];
    if (tags.includes(write.value)) return { ok: true, undo: null };
    if (tags.length >= 12) return { ok: false, error: "Twelve tags is the limit." };
    data = { tags: [...tags, write.value] };
    inverse = { tags };
    label = `Tagged “${before.title}” ${write.value}`;
  }

  await db.task.update({ where: { id: taskId }, data });

  /**
   * Asserted rather than assumed: the whole point of this path is that a
   * regroup does not move a card between columns, and a mistake here would
   * shred a board's arrangement silently.
   */
  const after = await db.task.findUnique({
    where: { id: taskId },
    select: { sectionId: true },
  });
  if (after && after.sectionId !== before.sectionId) {
    throw new Error("regroup changed sectionId — that is a bug, not a drop");
  }

  const undo = await recordUndo(workspaceId, userId, {
    kind: "bulk_signals",
    label,
    inverse: { entity: "task", targets: [{ id: taskId, set: inverse }] },
    // Tags are a JSON array and the undo compares by string, so nothing is
    // claimed about their prior state.
    expected: write.field === "tag" ? {} : { [taskId]: data },
  });

  revalidatePath("/tasks");
  return { ok: true, undo };
}
