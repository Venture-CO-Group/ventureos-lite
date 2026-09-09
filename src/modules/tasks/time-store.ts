/**
 * Estimates and time entries, against the database (playbook-v5 P20/1).
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 *
 * The playbook is explicit that this is not really a task feature: it is how
 * the business answers "what does a website project actually cost us". So the
 * numbers have to be trustworthy — one running timer, no invented minutes, and
 * a variance that says "unknown" rather than guessing when nobody estimated.
 */

import { getWorkspaceClient } from "@/lib/db";
import { resolveEstimate, runningMinutes, varianceOf, type Estimate, type Variance } from "./time-logic";

export interface RunningTimer {
  entryId: string;
  taskId: string;
  taskTitle: string;
  startedAt: Date;
  minutesSoFar: number;
}

/** The one timer this person has running, if any. */
export async function runningTimerFor(
  workspaceId: string,
  userId: string,
  now: Date = new Date(),
): Promise<RunningTimer | null> {
  const db = getWorkspaceClient(workspaceId);
  const row = await db.timeEntry.findFirst({
    where: { userId, endedAt: null },
    select: { id: true, taskId: true, startedAt: true, task: { select: { title: true } } },
  });
  if (!row) return null;
  return {
    entryId: row.id,
    taskId: row.taskId,
    taskTitle: row.task.title,
    startedAt: row.startedAt,
    minutesSoFar: runningMinutes(row.startedAt, now),
  };
}

export type StartResult =
  | { ok: true; entryId: string; stoppedPrevious: string | null }
  | { ok: false; error: string };

/**
 * Start the clock on a task.
 *
 * ── STARTING A SECOND TIMER STOPS THE FIRST ─────────────────────────────────
 *
 * Rather than refusing. Somebody who has moved on to another task has moved
 * on; making them go back and stop the old one first is a rule that teaches
 * people to stop using the timer. The previous entry is closed with its real
 * elapsed minutes and the fact is REPORTED, so nothing happens silently.
 *
 * The database enforces at-most-one running entry per person with a partial
 * unique index, so two tabs racing cannot produce two.
 */
export async function startTimer(
  workspaceId: string,
  userId: string,
  taskId: string,
  now: Date = new Date(),
): Promise<StartResult> {
  const db = getWorkspaceClient(workspaceId);
  const task = await db.task.findUnique({ where: { id: taskId }, select: { id: true } });
  if (!task) return { ok: false, error: "Task not found." };

  const current = await runningTimerFor(workspaceId, userId, now);
  let stoppedPrevious: string | null = null;
  if (current) {
    if (current.taskId === taskId) {
      return { ok: true, entryId: current.entryId, stoppedPrevious: null };
    }
    await stopTimer(workspaceId, userId, now);
    stoppedPrevious = current.taskTitle;
  }

  const created = await db.timeEntry.create({
    data: { workspaceId, taskId, userId, startedAt: now },
    select: { id: true },
  });
  return { ok: true, entryId: created.id, stoppedPrevious };
}

/** Stop the clock, writing the elapsed minutes onto the entry. */
export async function stopTimer(
  workspaceId: string,
  userId: string,
  now: Date = new Date(),
): Promise<{ ok: true; minutes: number } | { ok: false; error: string }> {
  const db = getWorkspaceClient(workspaceId);
  const row = await db.timeEntry.findFirst({
    where: { userId, endedAt: null },
    select: { id: true, startedAt: true },
  });
  if (!row) return { ok: false, error: "No timer is running." };

  const minutes = runningMinutes(row.startedAt, now);
  await db.timeEntry.update({
    where: { id: row.id },
    data: { endedAt: now, minutes },
  });
  return { ok: true, minutes };
}

/**
 * A stretch of work typed in afterwards.
 *
 * Its own path rather than a fake timer: a manual entry has a date somebody
 * chose and a note explaining it, and pretending it ran would put a start time
 * on it that nobody meant.
 */
export async function addManualEntry(
  workspaceId: string,
  userId: string,
  input: { taskId: string; minutes: number; day: Date; note?: string | null },
): Promise<{ ok: true; entryId: string } | { ok: false; error: string }> {
  if (input.minutes <= 0) return { ok: false, error: "Give it some minutes." };
  const db = getWorkspaceClient(workspaceId);
  const task = await db.task.findUnique({ where: { id: input.taskId }, select: { id: true } });
  if (!task) return { ok: false, error: "Task not found." };

  const startedAt = new Date(input.day);
  startedAt.setHours(9, 0, 0, 0);
  const endedAt = new Date(startedAt.getTime() + input.minutes * 60_000);
  const created = await db.timeEntry.create({
    data: {
      workspaceId,
      taskId: input.taskId,
      userId,
      startedAt,
      endedAt,
      minutes: input.minutes,
      note: input.note?.trim() || null,
    },
    select: { id: true },
  });
  return { ok: true, entryId: created.id };
}

export async function deleteEntry(
  workspaceId: string,
  userId: string,
  entryId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getWorkspaceClient(workspaceId);
  const row = await db.timeEntry.findUnique({
    where: { id: entryId },
    select: { id: true, userId: true },
  });
  if (!row) return { ok: false, error: "That entry no longer exists." };
  // Somebody's own time is theirs to correct; another person's is not.
  if (row.userId !== userId) return { ok: false, error: "That entry belongs to somebody else." };
  await db.timeEntry.delete({ where: { id: entryId } });
  return { ok: true };
}

export interface TimeEntryRow {
  id: string;
  userId: string;
  startedAt: Date;
  minutes: number;
  note: string | null;
  running: boolean;
}

/** The entries on a task, newest first, so a mistyped one can be removed. */
export async function entriesForTask(
  workspaceId: string,
  taskId: string,
): Promise<TimeEntryRow[]> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.timeEntry.findMany({
    where: { taskId },
    orderBy: { startedAt: "desc" },
    take: 50,
    select: { id: true, userId: true, startedAt: true, endedAt: true, minutes: true, note: true },
  });
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    startedAt: r.startedAt,
    minutes: r.minutes,
    note: r.note,
    running: r.endedAt === null,
  }));
}

export interface TaskTime {
  taskId: string;
  estimate: Estimate;
  actualMinutes: number;
  variance: Variance;
}

/** Estimate, actual and variance for one task, with the subtask roll-up. */
export async function taskTime(workspaceId: string, taskId: string): Promise<TaskTime | null> {
  const db = getWorkspaceClient(workspaceId);
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, estimateMinutes: true },
  });
  if (!task) return null;

  const [subtasks, spent] = await Promise.all([
    db.task.aggregate({
      where: { parentId: taskId, estimateMinutes: { not: null } },
      _sum: { estimateMinutes: true },
      _count: { _all: true },
    }),
    db.timeEntry.aggregate({ where: { taskId }, _sum: { minutes: true } }),
  ]);

  const estimate = resolveEstimate({
    own: task.estimateMinutes,
    fromSubtasks: subtasks._count._all > 0 ? (subtasks._sum.estimateMinutes ?? 0) : null,
  });
  const actualMinutes = spent._sum.minutes ?? 0;
  return { taskId, estimate, actualMinutes, variance: varianceOf(estimate.minutes, actualMinutes) };
}

export interface BoardTimeReport {
  boardId: string;
  estimateMinutes: number;
  actualMinutes: number;
  variance: Variance;
  /** How much of the board has an estimate at all — the honesty figure. */
  estimatedTasks: number;
  totalTasks: number;
}

/**
 * Estimate against actual for a whole board.
 *
 * `estimatedTasks` is reported beside the totals on purpose: a board where
 * three of forty tasks are estimated has a variance figure that means almost
 * nothing, and the reader has to be able to see that.
 */
export async function boardTimeReport(
  workspaceId: string,
  boardId: string,
): Promise<BoardTimeReport> {
  const db = getWorkspaceClient(workspaceId);
  const tasks = await db.task.findMany({
    where: { boardId },
    select: { id: true, estimateMinutes: true },
  });
  const ids = tasks.map((t) => t.id);
  const spent = ids.length
    ? await db.timeEntry.aggregate({ where: { taskId: { in: ids } }, _sum: { minutes: true } })
    : { _sum: { minutes: 0 } };

  const estimateMinutes = tasks.reduce((n, t) => n + (t.estimateMinutes ?? 0), 0);
  const actualMinutes = spent._sum.minutes ?? 0;
  return {
    boardId,
    estimateMinutes,
    actualMinutes,
    variance: varianceOf(estimateMinutes || null, actualMinutes),
    estimatedTasks: tasks.filter((t) => t.estimateMinutes !== null).length,
    totalTasks: tasks.length,
  };
}

export interface WeeklyTime {
  userId: string;
  /** Local YYYY-MM-DD → minutes. */
  byDay: Record<string, number>;
  totalMinutes: number;
}

/** One person's week, for the per-person summary the playbook asks for. */
export async function weeklyTime(
  workspaceId: string,
  userId: string,
  from: Date,
  to: Date,
): Promise<WeeklyTime> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.timeEntry.findMany({
    where: { userId, startedAt: { gte: from, lte: to } },
    select: { startedAt: true, minutes: true },
  });
  const byDay: Record<string, number> = {};
  for (const row of rows) {
    const key = `${row.startedAt.getFullYear()}-${String(row.startedAt.getMonth() + 1).padStart(2, "0")}-${String(row.startedAt.getDate()).padStart(2, "0")}`;
    byDay[key] = (byDay[key] ?? 0) + row.minutes;
  }
  return {
    userId,
    byDay,
    totalMinutes: rows.reduce((n, r) => n + r.minutes, 0),
  };
}

/** Everything logged in this workspace, for the export. */
export async function timeEntriesForExport(
  workspaceId: string,
): Promise<
  { taskTitle: string; userId: string; startedAt: Date; minutes: number; note: string | null }[]
> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.timeEntry.findMany({
    orderBy: { startedAt: "asc" },
    select: {
      startedAt: true,
      minutes: true,
      note: true,
      userId: true,
      task: { select: { title: true } },
    },
  });
  return rows.map((r) => ({
    taskTitle: r.task.title,
    userId: r.userId,
    startedAt: r.startedAt,
    minutes: r.minutes,
    note: r.note,
  }));
}

/** How much time one person has logged here — for the removal impact report. */
export async function loggedMinutesFor(workspaceId: string, userId: string): Promise<number> {
  const db = getWorkspaceClient(workspaceId);
  const spent = await db.timeEntry.aggregate({ where: { userId }, _sum: { minutes: true } });
  return spent._sum.minutes ?? 0;
}
