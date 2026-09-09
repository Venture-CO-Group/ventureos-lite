"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import { getWorkspaceClient } from "@/lib/db";
import { MAX_ESTIMATE_MINUTES, parseHours } from "./time-logic";
import {
  addManualEntry,
  boardTimeReport,
  deleteEntry,
  entriesForTask,
  runningTimerFor,
  startTimer,
  stopTimer,
  taskTime,
  weeklyTime,
  type BoardTimeReport,
  type RunningTimer,
  type TaskTime,
  type TimeEntryRow,
  type WeeklyTime,
} from "./time-store";

/** The timer, as the shell sees it. */
export async function getRunningTimer(): Promise<
  (Omit<RunningTimer, "startedAt"> & { startedAt: string }) | null
> {
  const { workspaceId, userId } = await getActiveContext();
  const timer = await runningTimerFor(workspaceId, userId);
  return timer ? { ...timer, startedAt: timer.startedAt.toISOString() } : null;
}

export async function startTaskTimer(
  taskId: string,
): Promise<{ ok: true; stoppedPrevious: string | null } | { ok: false; error: string }> {
  const parsed = z.string().min(1).max(60).safeParse(taskId);
  if (!parsed.success) return { ok: false, error: "Unknown task." };
  const { workspaceId, userId } = await getActiveContext();
  const res = await startTimer(workspaceId, userId, parsed.data);
  if (!res.ok) return res;
  revalidatePath("/tasks");
  return { ok: true, stoppedPrevious: res.stoppedPrevious };
}

export async function stopTaskTimer(): Promise<
  { ok: true; minutes: number } | { ok: false; error: string }
> {
  const { workspaceId, userId } = await getActiveContext();
  const res = await stopTimer(workspaceId, userId);
  if (res.ok) revalidatePath("/tasks");
  return res;
}

const manualSchema = z.object({
  taskId: z.string().min(1).max(60),
  /** As typed: "1.5", "90m", "1h30". Parsed by one function, not six. */
  hours: z.string().min(1).max(20),
  day: z.string().min(10).max(30),
  note: z.string().max(500).optional(),
});

export async function logTimeManually(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = manualSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the entry and try again." };

  const minutes = parseHours(parsed.data.hours);
  if (minutes === null || minutes <= 0) {
    return { ok: false, error: "Try 1.5, 90m, or 1h30." };
  }
  const day = new Date(parsed.data.day);
  if (Number.isNaN(day.getTime())) return { ok: false, error: "That is not a date." };

  const { workspaceId, userId } = await getActiveContext();
  const res = await addManualEntry(workspaceId, userId, {
    taskId: parsed.data.taskId,
    minutes,
    day,
    note: parsed.data.note ?? null,
  });
  if (res.ok) revalidatePath("/tasks");
  return res.ok ? { ok: true } : res;
}

export async function removeTimeEntry(
  entryId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z.string().min(1).max(60).safeParse(entryId);
  if (!parsed.success) return { ok: false, error: "Unknown entry." };
  const { workspaceId, userId } = await getActiveContext();
  const res = await deleteEntry(workspaceId, userId, parsed.data);
  if (res.ok) revalidatePath("/tasks");
  return res;
}

/**
 * Set or clear a task's own estimate.
 *
 * Clearing it does NOT clear the subtask roll-up — it hands the estimate back
 * to it, which is the whole point of showing both.
 */
export async function setTaskEstimate(
  raw: unknown,
): Promise<{ ok: true; minutes: number | null } | { ok: false; error: string }> {
  const parsed = z
    .object({ taskId: z.string().min(1).max(60), hours: z.string().max(20) })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That estimate is not valid." };

  const text = parsed.data.hours.trim();
  const minutes = text === "" ? null : parseHours(text);
  if (text !== "" && (minutes === null || minutes > MAX_ESTIMATE_MINUTES)) {
    return { ok: false, error: "Try 1.5, 90m, or 1h30." };
  }

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const task = await db.task.findUnique({ where: { id: parsed.data.taskId }, select: { id: true } });
  if (!task) return { ok: false, error: "Task not found." };

  await db.task.update({ where: { id: task.id }, data: { estimateMinutes: minutes } });
  revalidatePath("/tasks");
  return { ok: true, minutes };
}

/** The entries on a task, so a mistyped one can be found and removed. */
export async function getTaskEntries(
  taskId: string,
): Promise<(Omit<TimeEntryRow, "startedAt"> & { startedAt: string; mine: boolean })[]> {
  const parsed = z.string().min(1).max(60).safeParse(taskId);
  if (!parsed.success) return [];
  const { workspaceId, userId } = await getActiveContext();
  const rows = await entriesForTask(workspaceId, parsed.data);
  return rows.map((r) => ({
    ...r,
    startedAt: r.startedAt.toISOString(),
    // Only their own is removable, so the UI can say so rather than offering
    // a button that will be refused.
    mine: r.userId === userId,
  }));
}

export async function getTaskTime(taskId: string): Promise<TaskTime | null> {
  const parsed = z.string().min(1).max(60).safeParse(taskId);
  if (!parsed.success) return null;
  const { workspaceId } = await getActiveContext();
  return taskTime(workspaceId, parsed.data);
}

export async function getBoardTimeReport(boardId: string): Promise<BoardTimeReport | null> {
  const parsed = z.string().min(1).max(60).safeParse(boardId);
  if (!parsed.success) return null;
  const { workspaceId } = await getActiveContext();
  return boardTimeReport(workspaceId, parsed.data);
}

export async function getMyWeek(
  fromIso: string,
): Promise<(Omit<WeeklyTime, "byDay"> & { byDay: Record<string, number> }) | null> {
  const parsed = z.string().min(10).max(30).safeParse(fromIso);
  if (!parsed.success) return null;
  const from = new Date(parsed.data);
  if (Number.isNaN(from.getTime())) return null;
  const to = new Date(from.getTime() + 7 * 86_400_000);

  const { workspaceId, userId } = await getActiveContext();
  return weeklyTime(workspaceId, userId, from, to);
}
