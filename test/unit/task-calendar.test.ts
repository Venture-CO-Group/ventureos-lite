import { describe, it, expect } from "vitest";
import {
  CALENDAR_MODES,
  CALENDAR_MODE_LABEL,
  calendarDays,
  calendarTitle,
  dayFromKey,
  dayKey,
  dueDateForDay,
  isCalendarMode,
  isOtherMonth,
  itemsByDay,
  itemsOn,
  sameDay,
  shiftAnchor,
  spanForDrop,
  startOfWeek,
  type CalendarItem,
} from "../../src/modules/tasks/calendar";

const d = (y: number, m: number, day: number, h = 12) => new Date(y, m - 1, day, h, 0, 0, 0);

describe("the two modes", () => {
  it("names both", () => {
    for (const m of CALENDAR_MODES) expect(CALENDAR_MODE_LABEL[m]).toBeTruthy();
    expect(isCalendarMode("month")).toBe(true);
    expect(isCalendarMode("year")).toBe(false);
  });
});

/**
 * Monday-first weeks throughout. The app is Hungarian-facing, and a Sunday
 * column would be wrong for everybody using it.
 */
describe("weeks start on Monday", () => {
  it("walks back to Monday from any day", () => {
    // Wednesday 9 September 2026 → Monday the 7th.
    expect(startOfWeek(d(2026, 9, 9)).getDate()).toBe(7);
    // A Monday is already the start.
    expect(startOfWeek(d(2026, 9, 7)).getDate()).toBe(7);
    // And a SUNDAY belongs to the week that began the previous Monday, which
    // is the case a Sunday-first implementation gets wrong.
    expect(startOfWeek(d(2026, 9, 13)).getDate()).toBe(7);
  });

  it("gives a week exactly seven days, Monday to Sunday", () => {
    const days = calendarDays("week", d(2026, 9, 9));
    expect(days).toHaveLength(7);
    expect(days[0]!.getDay()).toBe(1);
    expect(days[6]!.getDay()).toBe(0);
  });
});

describe("the month grid", () => {
  /** Whole weeks, always — five rows some months and six others, never ragged. */
  it("is a whole number of weeks", () => {
    for (const [y, m] of [
      [2026, 2],
      [2026, 3],
      [2026, 8],
      [2026, 9],
      [2026, 11],
      [2027, 2],
    ] as const) {
      const days = calendarDays("month", d(y, m, 15));
      expect(days.length % 7, `${y}-${m}`).toBe(0);
      expect(days[0]!.getDay(), `${y}-${m}`).toBe(1);
      expect(days.at(-1)!.getDay(), `${y}-${m}`).toBe(0);
    }
  });

  it("covers every day of the month it is anchored on", () => {
    const days = calendarDays("month", d(2026, 9, 15));
    const inMonth = days.filter((x) => x.getMonth() === 8);
    expect(inMonth).toHaveLength(30);
  });

  /** A month that starts on a Sunday is the case that catches naive grids. */
  it("handles a month beginning on a Sunday", () => {
    // 1 November 2026 is a Sunday.
    const days = calendarDays("month", d(2026, 11, 15));
    expect(days[0]!.getDay()).toBe(1);
    expect(days.some((x) => x.getMonth() === 10 && x.getDate() === 1)).toBe(true);
  });

  it("marks the days that spill in from the neighbouring months", () => {
    const anchor = d(2026, 9, 15);
    const days = calendarDays("month", anchor);
    expect(isOtherMonth(days[0]!, anchor)).toBe(true);
    expect(isOtherMonth(d(2026, 9, 15), anchor)).toBe(false);
  });
});

describe("moving through time", () => {
  it("steps a week at a time in week view", () => {
    expect(shiftAnchor("week", d(2026, 9, 9), 1).getDate()).toBe(16);
    expect(shiftAnchor("week", d(2026, 9, 9), -1).getDate()).toBe(2);
  });

  it("steps a month at a time in month view, and lands on the 1st", () => {
    const next = shiftAnchor("month", d(2026, 9, 30), 1);
    expect(next.getMonth()).toBe(9);
    expect(next.getDate()).toBe(1);
  });

  /** The 31st of a month stepping into a 30-day one must not overflow. */
  it("does not skip a month when stepping from a 31st", () => {
    const next = shiftAnchor("month", d(2026, 1, 31), 1);
    expect(next.getMonth()).toBe(1);
  });

  it("titles both views", () => {
    expect(calendarTitle("month", d(2026, 9, 9))).toMatch(/2026/);
    expect(calendarTitle("week", d(2026, 9, 9))).toContain("–");
  });
});

describe("placing items on days", () => {
  const item = (over: Partial<CalendarItem>): CalendarItem => ({
    id: "i1",
    kind: "task",
    title: "Something",
    at: d(2026, 9, 9),
    ...over,
  });

  it("groups by the day, in time order", () => {
    const byDay = itemsByDay([
      item({ id: "late", at: d(2026, 9, 9, 16) }),
      item({ id: "early", at: d(2026, 9, 9, 9) }),
      item({ id: "other", at: d(2026, 9, 10) }),
    ]);
    expect(itemsOn(byDay, d(2026, 9, 9)).map((i) => i.id)).toEqual(["early", "late"]);
    expect(itemsOn(byDay, d(2026, 9, 10)).map((i) => i.id)).toEqual(["other"]);
  });

  /**
   * Keyed on the LOCAL day. A meeting at 23:30 belongs to that evening; keying
   * on the UTC date would file it under tomorrow for anybody east of
   * Greenwich, which is everybody using this.
   */
  it("keeps a late-evening item on its own evening", () => {
    const byDay = itemsByDay([item({ at: d(2026, 9, 9, 23) })]);
    expect(itemsOn(byDay, d(2026, 9, 9))).toHaveLength(1);
    expect(itemsOn(byDay, d(2026, 9, 10))).toHaveLength(0);
  });

  it("returns nothing for an empty day", () => {
    expect(itemsOn(itemsByDay([]), d(2026, 9, 9))).toEqual([]);
  });

  it("knows two dates are the same day whatever the time", () => {
    expect(sameDay(d(2026, 9, 9, 1), d(2026, 9, 9, 23))).toBe(true);
    expect(sameDay(d(2026, 9, 9), d(2026, 9, 10))).toBe(false);
  });
});

/**
 * A day key is a LOCAL calendar day.
 *
 * `toISOString().slice(0, 10)` on a local midnight gives the previous day east
 * of Greenwich, which labelled every cell with yesterday's date. The e2e
 * surfaced it as a drag that could not find its target; this is the cheaper
 * place to catch it.
 */
describe("day keys", () => {
  it("uses the local date, not the UTC one", () => {
    // Local midnight — the case toISOString gets wrong in any positive offset.
    const midnight = new Date(2026, 8, 9, 0, 0, 0, 0);
    expect(dayKey(midnight)).toBe("2026-09-09");
    expect(dayKey(new Date(2026, 8, 9, 23, 59))).toBe("2026-09-09");
    expect(dayKey(new Date(2026, 0, 1))).toBe("2026-01-01");
  });

  it("round-trips through a key", () => {
    const day = new Date(2026, 8, 9, 12);
    const back = dayFromKey(dayKey(day))!;
    expect(sameDay(back, day)).toBe(true);
  });

  it("refuses a key that is not one", () => {
    expect(dayFromKey("nope")).toBeNull();
    expect(dayFromKey("2026-9-9")).toBeNull();
  });
});

describe("dropping onto the calendar", () => {
  /** End of the day, like every other due date this system writes. */
  it("writes the end of the day it was dropped on", () => {
    const due = dueDateForDay(d(2026, 9, 9, 3));
    expect(due.getDate()).toBe(9);
    expect(due.getHours()).toBe(23);
    expect(due.getMinutes()).toBe(59);
  });

  it("spans a start and a due date when dragged across days", () => {
    const span = spanForDrop(d(2026, 9, 9), d(2026, 9, 11));
    expect(span.startAt.getDate()).toBe(9);
    expect(span.dueAt.getDate()).toBe(11);
    expect(span.startAt.getTime()).toBeLessThan(span.dueAt.getTime());
  });

  /** Dragged right-to-left means the same thing; refusing it would feel broken. */
  it("orders the span whichever way it was dragged", () => {
    const forwards = spanForDrop(d(2026, 9, 9), d(2026, 9, 11));
    const backwards = spanForDrop(d(2026, 9, 11), d(2026, 9, 9));
    expect(backwards.startAt.getTime()).toBe(forwards.startAt.getTime());
    expect(backwards.dueAt.getTime()).toBe(forwards.dueAt.getTime());
  });

  it("spans a single day when dropped on one", () => {
    const span = spanForDrop(d(2026, 9, 9), d(2026, 9, 9));
    expect(span.startAt.getDate()).toBe(9);
    expect(span.dueAt.getDate()).toBe(9);
  });
});
