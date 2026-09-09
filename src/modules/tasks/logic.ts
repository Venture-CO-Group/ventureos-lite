/**
 * Task grouping and ordering (playbook-v2 P3/3).
 *
 * Pure over rows, so the thing that decides what a person sees first is
 * testable without a database — and so "overdue" has exactly one definition in
 * the codebase rather than one per query.
 */
export const TASK_TYPES = ["call", "email", "todo", "follow_up"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TYPE_LABEL: Record<TaskType, string> = {
  call: "Call",
  email: "Email",
  todo: "To do",
  follow_up: "Follow-up",
};

export function isTaskType(v: unknown): v is TaskType {
  return typeof v === "string" && (TASK_TYPES as readonly string[]).includes(v);
}

export interface TaskLike {
  id: string;
  type: string;
  title: string;
  note?: string | null;
  dueAt: Date | null;
  doneAt: Date | null;
  entityType?: string | null;
  entityId?: string | null;
  source?: string | null;
}

export type TaskBucket = "overdue" | "today" | "upcoming" | "someday" | "done";

/**
 * Which list a task belongs in.
 *
 * A task with no due date is "someday" rather than overdue: a reminder someone
 * wrote without a date is not late, and treating it as late trains people to
 * ignore the overdue count — which is the one number that has to stay
 * trustworthy.
 */
export function bucketOf(task: TaskLike, now: Date = new Date()): TaskBucket {
  if (task.doneAt) return "done";
  if (!task.dueAt) return "someday";

  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  if (task.dueAt.getTime() < startOfDay(now).getTime()) return "overdue";
  if (task.dueAt.getTime() <= endOfToday.getTime()) return "today";
  return "upcoming";
}

export function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/**
 * A task due earlier TODAY is not overdue.
 *
 * Overdue is measured in whole days, not minutes: a 09:00 task at 11:00 is
 * still today's work, and colouring it red at 09:01 is how a list becomes
 * noise by lunchtime.
 */
export function isOverdue(task: TaskLike, now: Date = new Date()): boolean {
  return bucketOf(task, now) === "overdue";
}

const BUCKET_ORDER: Record<TaskBucket, number> = {
  overdue: 0,
  today: 1,
  upcoming: 2,
  someday: 3,
  done: 4,
};

/**
 * The order a person should work in: overdue first, then today, then soonest.
 *
 * Within a bucket, an earlier due date wins; a dateless task sorts last inside
 * its own bucket. Ties break on title so the list does not shuffle between
 * renders, which is the kind of instability that makes a list feel broken.
 */
export function orderTasks<T extends TaskLike>(tasks: T[], now: Date = new Date()): T[] {
  return [...tasks].sort((a, b) => {
    const bucketDiff = BUCKET_ORDER[bucketOf(a, now)] - BUCKET_ORDER[bucketOf(b, now)];
    if (bucketDiff !== 0) return bucketDiff;

    const aDue = a.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bDue = b.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;

    return a.title.localeCompare(b.title);
  });
}

export interface GroupedTasks<T extends TaskLike> {
  overdue: T[];
  today: T[];
  upcoming: T[];
  someday: T[];
  counts: { overdue: number; today: number; open: number };
}

export function groupTasks<T extends TaskLike>(
  tasks: T[],
  now: Date = new Date(),
): GroupedTasks<T> {
  const ordered = orderTasks(
    tasks.filter((t) => !t.doneAt),
    now,
  );
  const overdue = ordered.filter((t) => bucketOf(t, now) === "overdue");
  const today = ordered.filter((t) => bucketOf(t, now) === "today");
  const upcoming = ordered.filter((t) => bucketOf(t, now) === "upcoming");
  const someday = ordered.filter((t) => bucketOf(t, now) === "someday");

  return {
    overdue,
    today,
    upcoming,
    someday,
    counts: {
      overdue: overdue.length,
      today: today.length,
      open: ordered.length,
    },
  };
}

/**
 * A due date `days` from now, at end of day.

 * End of day rather than this exact time tomorrow: a follow-up "in 3 days"
 * means that day, not 14:37 on that day, and an hour-precise deadline nobody
 * chose only creates false overdues.
 */
export function dueInDays(days: number, now: Date = new Date()): Date {
  const due = new Date(now);
  due.setDate(due.getDate() + days);
  due.setHours(17, 0, 0, 0);
  return due;
}

// ---------------------------------------------------------------------------
// My Work buckets (playbook-v5 P18/1)
// ---------------------------------------------------------------------------

/**
 * The five sections My Work is arranged into.
 *
 * ── WHY THIS IS DERIVED FROM bucketOf AND NOT A SECOND OPINION ──────────────
 *
 * The playbook asks that "Today Queue and My Work agree on what is due", and
 * the only way to guarantee that is one function. `bucketOf` already decides
 * overdue / today / upcoming / someday for the dashboard panel; My Work needs
 * upcoming split into "this week" and "later", which is a finer READING of the
 * same answer rather than a new one. So this calls `bucketOf` first and only
 * subdivides what it returns — and a test asserts the two can never disagree.
 */
export const WORK_BUCKETS = ["overdue", "today", "week", "later", "undated"] as const;
export type WorkBucket = (typeof WORK_BUCKETS)[number];

export const WORK_BUCKET_LABEL: Record<WorkBucket, string> = {
  overdue: "Overdue",
  today: "Today",
  week: "This week",
  later: "Later",
  undated: "No date",
};

/**
 * What dragging INTO a bucket means, said out loud in the UI.
 *
 * The playbook asks for the rule to be explicit, because "drop it in Later"
 * has no obvious date. Today is today; this week is the coming Sunday; later
 * is a week out; no date clears it. Overdue is not a destination — nobody
 * means "make this late", so it is the one bucket you cannot drop into.
 */
export const WORK_BUCKET_RULE: Record<WorkBucket, string> = {
  overdue: "What has already passed. You cannot move work into it — nobody means “make this late”.",
  today: "Sets the due date to the end of today.",
  week: "Sets the due date to the end of this week, which is the coming Sunday.",
  later: "Sets the due date to a week from today.",
  undated: "Clears the due date, so it stops counting towards anything.",
};

/** Sunday of the week `now` falls in, at end of day. */
export function endOfWeek(now: Date = new Date()): Date {
  const out = new Date(now);
  // Monday-first weeks: getDay() is 0 for Sunday, so Sunday IS the end.
  const daysToSunday = (7 - out.getDay()) % 7;
  out.setDate(out.getDate() + daysToSunday);
  out.setHours(23, 59, 59, 999);
  return out;
}

export function workBucketOf(task: TaskLike, now: Date = new Date()): WorkBucket | "done" {
  const coarse = bucketOf(task, now);
  if (coarse === "done") return "done";
  if (coarse === "overdue") return "overdue";
  if (coarse === "today") return "today";
  if (coarse === "someday") return "undated";
  // `upcoming`, split by whether it lands inside this week.
  return task.dueAt && task.dueAt.getTime() <= endOfWeek(now).getTime() ? "week" : "later";
}

/**
 * The date a drop into a bucket produces, or `undefined` for a bucket that is
 * not a destination.
 *
 * End of day, like every other due date this system writes: "due Friday" means
 * that day, not 14:37 on it.
 */
export function dueDateForBucket(bucket: WorkBucket, now: Date = new Date()): Date | null | undefined {
  if (bucket === "overdue") return undefined;
  if (bucket === "undated") return null;
  if (bucket === "today") {
    const out = new Date(now);
    out.setHours(23, 59, 59, 999);
    return out;
  }
  if (bucket === "week") return endOfWeek(now);
  const out = new Date(now);
  out.setDate(out.getDate() + 7);
  out.setHours(23, 59, 59, 999);
  return out;
}

export interface WorkBuckets<T extends TaskLike> {
  overdue: T[];
  today: T[];
  week: T[];
  later: T[];
  undated: T[];
}

export function bucketWork<T extends TaskLike>(
  tasks: T[],
  now: Date = new Date(),
): WorkBuckets<T> {
  const out: WorkBuckets<T> = { overdue: [], today: [], week: [], later: [], undated: [] };
  for (const task of orderTasks(tasks.filter((t) => !t.doneAt), now)) {
    const bucket = workBucketOf(task, now);
    if (bucket === "done") continue;
    out[bucket].push(task);
  }
  return out;
}
