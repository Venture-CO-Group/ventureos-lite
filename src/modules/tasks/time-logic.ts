/**
 * Estimates and time, in arithmetic (playbook-v5 P20/1).
 *
 * ── MINUTES IN, HOURS OUT ───────────────────────────────────────────────────
 *
 * The column holds whole minutes; people think in hours. Every conversion
 * happens here, once, because a rounding rule applied in six components is six
 * rounding rules — and a variance report built on two of them is a report
 * nobody can reconcile.
 */

export const MAX_ESTIMATE_MINUTES = 60 * 999;

/** "1.5", "1,5", "90m", "1h30" — what somebody actually types. */
export function parseHours(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(",", ".");
  if (!text) return null;

  // Explicit minutes.
  const mins = /^(\d+(?:\.\d+)?)\s*m(?:in)?$/.exec(text);
  if (mins) return clampMinutes(Math.round(Number(mins[1])));

  // "1h30" or "1h 30m" or "1h".
  const hm = /^(\d+)\s*h(?:\s*(\d+)\s*m?)?$/.exec(text);
  if (hm) return clampMinutes(Number(hm[1]) * 60 + Number(hm[2] ?? 0));

  const hours = Number(text);
  if (!Number.isFinite(hours) || hours < 0) return null;
  return clampMinutes(Math.round(hours * 60));
}

function clampMinutes(minutes: number): number | null {
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes > MAX_ESTIMATE_MINUTES) return null;
  return minutes;
}

/** Hours, at one decimal — enough to be useful, not enough to look precise. */
export function formatHours(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "—";
  if (minutes === 0) return "0h";
  const hours = minutes / 60;
  // Whole hours read better without a decimal point.
  return hours % 1 === 0 ? `${hours}h` : `${hours.toFixed(1)}h`;
}

export interface EstimateSource {
  /** What somebody typed on this task, if they did. */
  own: number | null;
  /** The sum of its subtasks' estimates, if it has any with one. */
  fromSubtasks: number | null;
}

export type EstimateMode = "own" | "subtasks" | "none";

export interface Estimate {
  minutes: number | null;
  mode: EstimateMode;
  /** Both, so the UI can show them side by side as the playbook asks. */
  own: number | null;
  fromSubtasks: number | null;
}

/**
 * A parent's estimate can be entered directly OR computed from its subtasks.
 *
 * The playbook asks to SHOW BOTH and mark which is in use, which is the honest
 * rendering: they will disagree, and the disagreement is information — a
 * parent estimated at four hours whose subtasks add to eleven is a plan worth
 * looking at again. A direct estimate wins, because somebody typed it.
 */
export function resolveEstimate(source: EstimateSource): Estimate {
  if (source.own !== null) {
    return { minutes: source.own, mode: "own", own: source.own, fromSubtasks: source.fromSubtasks };
  }
  if (source.fromSubtasks !== null) {
    return {
      minutes: source.fromSubtasks,
      mode: "subtasks",
      own: null,
      fromSubtasks: source.fromSubtasks,
    };
  }
  return { minutes: null, mode: "none", own: null, fromSubtasks: null };
}

export interface Variance {
  estimateMinutes: number;
  actualMinutes: number;
  /** Positive means over. */
  deltaMinutes: number;
  /** Null when there was nothing to be over BY. */
  ratio: number | null;
}

export function varianceOf(estimateMinutes: number | null, actualMinutes: number): Variance {
  const estimate = estimateMinutes ?? 0;
  return {
    estimateMinutes: estimate,
    actualMinutes,
    deltaMinutes: actualMinutes - estimate,
    // No estimate means no variance to speak of — reporting "infinitely over"
    // for unestimated work would drown the rows that were actually estimated.
    ratio: estimate > 0 ? actualMinutes / estimate : null,
  };
}

/** How a variance should read. Bands, not a number, for a glance. */
export function varianceLabel(v: Variance): "on" | "over" | "under" | "unknown" {
  if (v.ratio === null) return "unknown";
  if (v.ratio > 1.15) return "over";
  if (v.ratio < 0.85) return "under";
  return "on";
}

/**
 * A running timer's minutes so far.
 *
 * Computed rather than stored: a timer left running over a weekend must not
 * need a job to keep its number honest.
 */
export function runningMinutes(startedAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 60_000));
}

/**
 * A timer nobody stopped.
 *
 * The product cannot know whether somebody worked for fourteen hours or went
 * home, so it does not guess: past this it is FLAGGED for the person to fix,
 * and never silently truncated to something plausible.
 */
export const RUNAWAY_TIMER_MINUTES = 12 * 60;

export function isRunaway(startedAt: Date, now: Date = new Date()): boolean {
  return runningMinutes(startedAt, now) > RUNAWAY_TIMER_MINUTES;
}

// ---------------------------------------------------------------------------
// workload (playbook-v5 P19/3)
// ---------------------------------------------------------------------------

/**
 * How much of a day one person is assumed to have.
 *
 * Six hours, not eight: nobody spends a working day only on scheduled tasks,
 * and a capacity model that pretends otherwise reports everybody as
 * comfortable right up to the point they are not.
 */
export const MINUTES_PER_DAY = 6 * 60;

/**
 * When there are no estimates, a load has to be guessed from the COUNT — and
 * the playbook is emphatic that a count-based figure must not be presented as
 * if it were hours. So this is the assumption, it is stated in the UI, and the
 * two modes are labelled differently wherever a number is shown.
 */
export const DEFAULT_TASKS_PER_DAY = 4;

export type LoadMode = "estimates" | "count";

export interface DayLoad {
  /** Local YYYY-MM-DD. */
  day: string;
  /** 0–1+, where 1 is a full day. Over 1 is overload. */
  load: number;
  /** What produced it, so the UI never mislabels a count as hours. */
  mode: LoadMode;
  taskCount: number;
  estimatedMinutes: number;
}

export interface WorkloadTask {
  id: string;
  dueAt: Date | null;
  estimateMinutes: number | null;
}

/**
 * One person's load per day across a range.
 *
 * ── WHY THE MODE IS PER DAY AND NOT PER PERSON ──────────────────────────────
 *
 * A day whose tasks are all estimated can be reported in hours; a day where
 * none are cannot. Deciding once per person would mean one unestimated task
 * turning a whole week into a count — or, worse, an estimated day being
 * reported as "4 tasks" when the real answer was known.
 */
export function loadByDay(
  tasks: WorkloadTask[],
  days: string[],
  tasksPerDay: number = DEFAULT_TASKS_PER_DAY,
): DayLoad[] {
  const byDay = new Map<string, WorkloadTask[]>();
  for (const task of tasks) {
    if (!task.dueAt) continue;
    const key = localDayKey(task.dueAt);
    byDay.set(key, [...(byDay.get(key) ?? []), task]);
  }

  return days.map((day) => {
    const onDay = byDay.get(day) ?? [];
    const estimated = onDay.filter((t) => t.estimateMinutes !== null);
    const estimatedMinutes = estimated.reduce((n, t) => n + (t.estimateMinutes ?? 0), 0);

    // Estimates are used only when EVERY task that day has one. A partial sum
    // would understate the day and read as capacity that is not there.
    if (onDay.length > 0 && estimated.length === onDay.length) {
      return {
        day,
        load: estimatedMinutes / MINUTES_PER_DAY,
        mode: "estimates",
        taskCount: onDay.length,
        estimatedMinutes,
      };
    }
    return {
      day,
      load: onDay.length / Math.max(1, tasksPerDay),
      mode: "count",
      taskCount: onDay.length,
      estimatedMinutes,
    };
  });
}

/** Local YYYY-MM-DD. Never toISOString — see modules/tasks/calendar.dayKey. */
export function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Over capacity. The threshold is 1 by definition of `load`. */
export function isOverloaded(day: DayLoad): boolean {
  return day.load > 1;
}

/** The sentence the workload header has to carry. */
export function loadAssumption(mode: LoadMode, tasksPerDay: number): string {
  if (mode === "estimates") {
    return `Load is estimated hours against ${MINUTES_PER_DAY / 60} hours a day.`;
  }
  return `No estimates on this work, so load is a task COUNT against an assumed ${tasksPerDay} tasks a day — not hours.`;
}
