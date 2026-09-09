"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import type { BulkResult } from "@/lib/bulk";
import {
  bulkAssignTasks,
  bulkCompleteTasks,
  bulkDeleteTasks,
  bulkMoveTasksToSection,
  bulkSetTaskDue,
  bulkSetTaskPriority,
  bulkTagTasks,
} from "./bulk";

/**
 * The session-facing wrappers for a bulk task action (playbook-v5 P17/1).
 *
 * Each takes at most one BATCH of ids — the bar chunks — so the input bound is
 * the batch size rather than "however many the client felt like sending".
 */
const ids = z.array(z.string().min(1).max(60)).min(1).max(200);

export async function bulkTasksComplete(raw: unknown, done = true): Promise<BulkResult> {
  const parsed = ids.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const { workspaceId, userId } = await getActiveContext();
  const res = await bulkCompleteTasks(workspaceId, userId, parsed.data, done);
  revalidatePath("/tasks");
  revalidatePath("/");
  return res;
}

export async function bulkTasksAssign(raw: unknown, assigneeId: string | null): Promise<BulkResult> {
  const parsed = ids.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const who = z.string().min(1).max(60).nullable().safeParse(assigneeId);
  if (!who.success) return { applied: 0, skipped: [] };
  const { workspaceId, userId } = await getActiveContext();
  const res = await bulkAssignTasks(workspaceId, userId, parsed.data, who.data);
  revalidatePath("/tasks");
  revalidatePath("/");
  return res;
}

export async function bulkTasksPriority(raw: unknown, priority: string): Promise<BulkResult> {
  const parsed = ids.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const { workspaceId, userId } = await getActiveContext();
  const res = await bulkSetTaskPriority(workspaceId, userId, parsed.data, priority);
  revalidatePath("/tasks");
  return res;
}

export async function bulkTasksDue(raw: unknown, dueAt: string | null): Promise<BulkResult> {
  const parsed = ids.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const { workspaceId, userId } = await getActiveContext();
  const res = await bulkSetTaskDue(workspaceId, userId, parsed.data, dueAt);
  revalidatePath("/tasks");
  revalidatePath("/");
  return res;
}

export async function bulkTasksTag(
  raw: unknown,
  tag: string,
  mode: "add" | "remove" = "add",
): Promise<BulkResult> {
  const parsed = ids.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const { workspaceId, userId } = await getActiveContext();
  const res = await bulkTagTasks(workspaceId, userId, parsed.data, tag, mode);
  revalidatePath("/tasks");
  return res;
}

export async function bulkTasksSection(raw: unknown, sectionId: string): Promise<BulkResult> {
  const parsed = ids.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const { workspaceId, userId } = await getActiveContext();
  const res = await bulkMoveTasksToSection(workspaceId, userId, parsed.data, sectionId);
  revalidatePath("/tasks");
  return res;
}

export async function bulkTasksDelete(raw: unknown): Promise<BulkResult> {
  const parsed = ids.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const { workspaceId } = await getActiveContext();
  const res = await bulkDeleteTasks(workspaceId, parsed.data);
  revalidatePath("/tasks");
  revalidatePath("/");
  return res;
}

/** "Everything matching" on a board: every task the board query would show. */
export async function resolveBoardTaskIds(
  boardId: string,
  opts: { includeDone?: boolean; assigneeId?: string | null } = {},
): Promise<string[]> {
  const { workspaceId } = await getActiveContext();
  const { getWorkspaceClient } = await import("@/lib/db");
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.task.findMany({
    where: {
      boardId,
      parentId: null,
      ...(opts.includeDone ? {} : { doneAt: null }),
      ...(opts.assigneeId ? { assigneeId: opts.assigneeId } : {}),
    },
    select: { id: true },
    // Bounded: a board with more than this is not a bulk action, it is a job.
    take: 2000,
  });
  return rows.map((r) => r.id);
}
