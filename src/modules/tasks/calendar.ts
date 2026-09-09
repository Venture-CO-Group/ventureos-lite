/**
 * Calendar geometry (playbook-v5 P19/2).
 *
 * Pure, for the same reason the timeline's arithmetic is: a month grid that
 * looks right in September is wrong in a month that starts on a Sunday, and
 * only a test over many months says so.
 *
 * Monday-first weeks throughout — the app is Hungarian-facing and a Sunday
 * column would be wrong for everybody using it.
 */

import { startOfDay } from "./logic";

export const CALENDAR_MODES = ["month", "week"] as const;
export type CalendarMode = (typeof CALENDAR_MODES)[number];

export const CALENDAR_MODE_LABEL: Record<CalendarMode, string> = {
  month: "Month",
  week: "Week",
};

export function isCalendarMode(v: string): v is CalendarMode {
  return (CALENDAR_MODES as readonly string[]).includes(v);
}

/** Monday of the week `date` falls in. */
export function startOfWeek(date: Date): Date {
  const out = startOfDay(date);
  // getDay(): 0 = Sunday. Monday-first means Sunday is the seventh day.
  const back = (out.getDay() + 6) % 7;
  out.setDate(out.getDate() - back);
  return out;
}

export function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

export function sameDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

/**
 * The days a view covers.
 *
 * A month grid runs from the Monday before the 1st to the Sunday after the
 * last day, so it is always whole weeks — six rows some months, five others,
 * and never a ragged edge.
 */
export function calendarDays(mode: CalendarMode, anchor: Date): Date[] {
  if (mode === "week") {
    const from = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(from, i));
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const from = startOfWeek(first);
  const to = addDays(startOfWeek(last), 6);
  const days: Date[] = [];
  for (let d = from; d.getTime() <= to.getTime(); d = addDays(d, 1)) days.push(d);
  return days;
}

/** The month or week a step moves to. */
export function shiftAnchor(mode: CalendarMode, anchor: Date, steps: number): Date {
  if (mode === "week") return addDays(anchor, steps * 7);
  return new Date(anchor.getFullYear(), anchor.getMonth() + steps, 1);
}

export function calendarTitle(mode: CalendarMode, anchor: Date): string {
  if (mode === "month") {
    return anchor.toLocaleDateString("hu-HU", { month: "long", year: "numeric" });
  }
  const from = startOfWeek(anchor);
  const to = addDays(from, 6);
  return `${from.toLocaleDateString("hu-HU", { month: "short", day: "numeric" })} – ${to.toLocaleDateString("hu-HU", { month: "short", day: "numeric" })}`;
}

export type CalendarItemKind = "task" | "meeting" | "callback";

export interface CalendarItem {
  id: string;
  kind: CalendarItemKind;
  title: string;
  at: Date;
  /** Tasks only: whether it is finished, and where to open it. */
  doneAt?: Date | null;
  href?: string | null;
  priority?: string;
}

/**
 * Items grouped by the day they fall on.
 *
 * Keyed on the local calendar day, not the ISO date: a meeting at 23:30 local
 * belongs to that evening, and keying on the UTC date would file it under
 * tomorrow for anybody east of Greenwich.
 */
export function itemsByDay(items: CalendarItem[]): Map<number, CalendarItem[]> {
  const out = new Map<number, CalendarItem[]>();
  for (const item of items) {
    const key = startOfDay(item.at).getTime();
    out.set(key, [...(out.get(key) ?? []), item]);
  }
  for (const list of out.values()) list.sort((a, b) => a.at.getTime() - b.at.getTime());
  return out;
}

export function itemsOn(byDay: Map<number, CalendarItem[]>, day: Date): CalendarItem[] {
  return byDay.get(startOfDay(day).getTime()) ?? [];
}

/**
 * The date a drop on a day should write.
 *
 * End of that day, like every other due date this system writes — "due Friday"
 * means that day, not the moment somebody happened to drop it.
 */
export function dueDateForDay(day: Date): Date {
  const out = startOfDay(day);
  out.setHours(23, 59, 0, 0);
  return out;
}

/**
 * A drop that spans days in week view, which the playbook asks for: dragging
 * across three columns sets a start AND a due date.
 *
 * Ordered, so dragging right-to-left means the same thing as left-to-right —
 * nobody drags backwards on purpose and refusing it would just feel broken.
 */
export function spanForDrop(fromDay: Date, toDay: Date): { startAt: Date; dueAt: Date } {
  const a = startOfDay(fromDay);
  const b = startOfDay(toDay);
  const [start, end] = a.getTime() <= b.getTime() ? [a, b] : [b, a];
  const startAt = new Date(start);
  startAt.setHours(9, 0, 0, 0);
  return { startAt, dueAt: dueDateForDay(end) };
}

/**
 * A day as `YYYY-MM-DD`, from the LOCAL calendar.
 *
 * Not `toISOString().slice(0, 10)`, which is the bug this replaced: a local
 * midnight in CEST serialises to 22:00 the PREVIOUS day, so every day cell was
 * labelled with yesterday's date for anybody east of Greenwich. The e2e caught
 * it as "drag endpoints not found", which is a kinder failure than a task
 * silently landing a day early.
 */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Back to a local Date at noon, which is inside the day in every timezone. */
export function dayFromKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Days outside the anchor's month, for dimming in month view. */
export function isOtherMonth(day: Date, anchor: Date): boolean {
  return day.getMonth() !== anchor.getMonth();
}
