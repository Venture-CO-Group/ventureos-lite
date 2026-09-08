/**
 * When a scheduled export is next due.
 *
 * Pure, because "next Monday at 08:00" is the kind of arithmetic that looks
 * obviously right and is wrong at a month boundary, on the day itself, and in
 * February. All of those are pinned by tests rather than discovered by a
 * customer noticing a report never arrived.
 */

export const EXPORT_CADENCES = ["daily", "weekly", "monthly"] as const;
export type ExportCadence = (typeof EXPORT_CADENCES)[number];

export const CADENCE_LABEL: Record<ExportCadence, string> = {
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
};

export function isExportCadence(v: unknown): v is ExportCadence {
  return typeof v === "string" && (EXPORT_CADENCES as readonly string[]).includes(v);
}

/** 1 = Monday … 7 = Sunday, matching ISO rather than JS's Sunday-is-0. */
export const WEEKDAY_LABEL: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};

export interface ScheduleSpec {
  cadence: ExportCadence;
  /** 1-7, ISO weekday. Ignored unless weekly. */
  dayOfWeek: number;
  /** 1-28. Ignored unless monthly. */
  dayOfMonth: number;
  /** 0-23. */
  hour: number;
}

/** ISO weekday (1 = Monday) for a Date. */
export function isoWeekday(d: Date): number {
  const js = d.getDay();
  return js === 0 ? 7 : js;
}

/**
 * The next firing at or after `from`.
 *
 * "At or after" rather than "strictly after": when a schedule is created at
 * 07:00 for 08:00 today, the first run should be in an hour rather than in a
 * week. Callers that have just RUN one pass `now + 1 minute` so the same slot
 * cannot fire twice.
 *
 * Day-of-month is clamped to 28 on the way in, so "the 1st" and "the 28th"
 * both exist in every month and there is no February special case.
 */
export function nextRunAt(spec: ScheduleSpec, from: Date): Date {
  const hour = clamp(spec.hour, 0, 23);

  if (spec.cadence === "daily") {
    const candidate = atHour(from, hour);
    return candidate >= from ? candidate : atHour(addDays(from, 1), hour);
  }

  if (spec.cadence === "weekly") {
    const target = clamp(spec.dayOfWeek, 1, 7);
    let candidate = atHour(from, hour);
    let delta = target - isoWeekday(from);
    // Today, but the hour has passed: a whole week, not zero.
    if (delta < 0 || (delta === 0 && candidate < from)) delta += 7;
    candidate = atHour(addDays(from, delta), hour);
    return candidate;
  }

  // monthly
  const day = clamp(spec.dayOfMonth, 1, 28);
  const thisMonth = new Date(from);
  thisMonth.setDate(day);
  const candidate = atHour(thisMonth, hour);
  if (candidate >= from) return candidate;
  const next = new Date(from);
  // Set the day BEFORE the month, or moving from the 31st to a short month
  // rolls into the one after.
  next.setDate(1);
  next.setMonth(next.getMonth() + 1);
  next.setDate(day);
  return atHour(next, hour);
}

function atHour(d: Date, hour: number): Date {
  const out = new Date(d);
  out.setHours(hour, 0, 0, 0);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** A sentence a person can check against what they meant. */
export function describeSchedule(spec: ScheduleSpec): string {
  const hh = `${String(clamp(spec.hour, 0, 23)).padStart(2, "0")}:00`;
  if (spec.cadence === "daily") return `Every day at ${hh}`;
  if (spec.cadence === "weekly") {
    return `Every ${WEEKDAY_LABEL[clamp(spec.dayOfWeek, 1, 7)]} at ${hh}`;
  }
  const day = clamp(spec.dayOfMonth, 1, 28);
  const suffix = day === 1 ? "st" : day === 2 ? "nd" : day === 3 ? "rd" : "th";
  return `The ${day}${suffix} of every month at ${hh}`;
}
