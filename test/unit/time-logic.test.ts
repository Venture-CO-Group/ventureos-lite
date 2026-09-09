import { describe, it, expect } from "vitest";
import {
  DEFAULT_TASKS_PER_DAY,
  MAX_ESTIMATE_MINUTES,
  MINUTES_PER_DAY,
  RUNAWAY_TIMER_MINUTES,
  formatHours,
  isOverloaded,
  isRunaway,
  loadAssumption,
  loadByDay,
  localDayKey,
  parseHours,
  resolveEstimate,
  runningMinutes,
  varianceLabel,
  varianceOf,
} from "../../src/modules/tasks/time-logic";

/**
 * Minutes in, hours out (playbook-v5 P20/1).
 *
 * Stored as whole minutes for the same reason money is integer forints: 1.5h
 * is exactly 90 minutes, while 0.1h is not exactly six of anything and a sum
 * of forty is wrong by an amount nobody can explain.
 */
describe("reading what somebody typed", () => {
  it("takes plain hours, with either decimal separator", () => {
    expect(parseHours("2")).toBe(120);
    expect(parseHours("1.5")).toBe(90);
    expect(parseHours("1,5")).toBe(90);
    expect(parseHours("0.25")).toBe(15);
  });

  it("takes minutes and the h/m shorthand", () => {
    expect(parseHours("90m")).toBe(90);
    expect(parseHours("45 min")).toBe(45);
    expect(parseHours("1h")).toBe(60);
    expect(parseHours("1h30")).toBe(90);
    expect(parseHours("2h 15m")).toBe(135);
  });

  it("refuses nonsense rather than guessing", () => {
    expect(parseHours("")).toBeNull();
    expect(parseHours("soon")).toBeNull();
    expect(parseHours("-3")).toBeNull();
    expect(parseHours("1h2h")).toBeNull();
  });

  /** A four-figure estimate is a typo, and it would dominate every total. */
  it("refuses an estimate past the cap", () => {
    expect(parseHours("9999")).toBeNull();
    expect(parseHours(String(MAX_ESTIMATE_MINUTES / 60))).toBe(MAX_ESTIMATE_MINUTES);
  });

  it("prints hours without pretending to precision", () => {
    expect(formatHours(120)).toBe("2h");
    expect(formatHours(90)).toBe("1.5h");
    expect(formatHours(0)).toBe("0h");
    expect(formatHours(null)).toBe("—");
  });
});

/**
 * A parent's estimate can be typed OR summed from its subtasks, and the
 * playbook asks to show BOTH and mark which is in use. They will disagree, and
 * the disagreement is information: four hours whose subtasks add to eleven is
 * a plan worth another look.
 */
describe("a parent's estimate", () => {
  it("prefers what somebody typed, and still reports the sum", () => {
    const e = resolveEstimate({ own: 240, fromSubtasks: 660 });
    expect(e.minutes).toBe(240);
    expect(e.mode).toBe("own");
    expect(e.fromSubtasks).toBe(660);
  });

  it("falls back to the subtasks when nobody typed one", () => {
    const e = resolveEstimate({ own: null, fromSubtasks: 660 });
    expect(e.minutes).toBe(660);
    expect(e.mode).toBe("subtasks");
  });

  it("says there is none when there is none", () => {
    const e = resolveEstimate({ own: null, fromSubtasks: null });
    expect(e.minutes).toBeNull();
    expect(e.mode).toBe("none");
  });
});

describe("variance", () => {
  it("reports over, under and on", () => {
    expect(varianceLabel(varianceOf(120, 200))).toBe("over");
    expect(varianceLabel(varianceOf(120, 60))).toBe("under");
    expect(varianceLabel(varianceOf(120, 125))).toBe("on");
  });

  /**
   * Unestimated work has no variance. Reporting it as infinitely over would
   * drown the rows that were actually estimated, which are the point.
   */
  it("says nothing about work nobody estimated", () => {
    const v = varianceOf(null, 300);
    expect(v.ratio).toBeNull();
    expect(varianceLabel(v)).toBe("unknown");
    expect(v.deltaMinutes).toBe(300);
  });

  it("handles a zero estimate the same way", () => {
    expect(varianceOf(0, 60).ratio).toBeNull();
  });
});

describe("a running timer", () => {
  const start = new Date(2026, 8, 9, 9, 0, 0, 0);

  it("counts whole minutes so far", () => {
    expect(runningMinutes(start, new Date(2026, 8, 9, 10, 30))).toBe(90);
    expect(runningMinutes(start, start)).toBe(0);
  });

  /** A clock that went backwards must not produce negative work. */
  it("never goes negative", () => {
    expect(runningMinutes(start, new Date(2026, 8, 9, 8, 0))).toBe(0);
  });

  /**
   * The product cannot know whether somebody worked fourteen hours or went
   * home, so it flags rather than guessing — and never truncates to something
   * plausible, which would be inventing the answer.
   */
  it("flags a timer nobody stopped", () => {
    expect(isRunaway(start, new Date(2026, 8, 9, 15, 0))).toBe(false);
    expect(isRunaway(start, new Date(2026, 8, 10, 9, 0))).toBe(true);
    expect(RUNAWAY_TIMER_MINUTES).toBeGreaterThan(8 * 60);
  });
});

/**
 * THE RULE THE PLAYBOOK IS EMPHATIC ABOUT: a count-based load must not be
 * presented as if it were hours.
 */
describe("workload", () => {
  const days = ["2026-09-09", "2026-09-10", "2026-09-11"];
  const on = (day: string, estimateMinutes: number | null, id = day + estimateMinutes) => ({
    id,
    dueAt: new Date(`${day}T12:00:00`),
    estimateMinutes,
  });

  it("uses hours when every task that day is estimated", () => {
    const load = loadByDay([on("2026-09-09", 180), on("2026-09-09", 180, "b")], days);
    expect(load[0]!.mode).toBe("estimates");
    // Six hours against a six-hour day is exactly full.
    expect(load[0]!.load).toBeCloseTo(1);
    expect(load[0]!.estimatedMinutes).toBe(360);
  });

  /**
   * A PARTIAL sum would understate the day and read as capacity that is not
   * there, so one unestimated task drops the day to a count.
   */
  it("falls back to a count when even one task is unestimated", () => {
    const load = loadByDay([on("2026-09-09", 180), on("2026-09-09", null, "b")], days);
    expect(load[0]!.mode).toBe("count");
    expect(load[0]!.taskCount).toBe(2);
    expect(load[0]!.load).toBeCloseTo(2 / DEFAULT_TASKS_PER_DAY);
  });

  /**
   * Per DAY, not per person: one unestimated task must not turn a whole week
   * into a count, and an estimated day must not be reported as "4 tasks" when
   * the real answer was known.
   */
  it("decides the mode a day at a time", () => {
    const load = loadByDay(
      [on("2026-09-09", 180), on("2026-09-10", null)],
      days,
    );
    expect(load[0]!.mode).toBe("estimates");
    expect(load[1]!.mode).toBe("count");
  });

  it("marks a day over capacity", () => {
    const heavy = loadByDay([on("2026-09-09", 600)], days)[0]!;
    expect(isOverloaded(heavy)).toBe(true);
    const light = loadByDay([on("2026-09-09", 60)], days)[0]!;
    expect(isOverloaded(light)).toBe(false);
  });

  it("leaves a day with nothing on it empty rather than absent", () => {
    const load = loadByDay([], days);
    expect(load).toHaveLength(3);
    expect(load.every((d) => d.load === 0 && d.taskCount === 0)).toBe(true);
  });

  it("ignores work with no due date, which belongs to no day", () => {
    const load = loadByDay([{ id: "x", dueAt: null, estimateMinutes: 120 }], days);
    expect(load.every((d) => d.taskCount === 0)).toBe(true);
  });

  /** The sentence the header must carry, and it must say "not hours". */
  it("states its assumption, differently for each mode", () => {
    expect(loadAssumption("estimates", 4)).toMatch(/hours a day/i);
    const counted = loadAssumption("count", 4);
    expect(counted).toMatch(/count/i);
    expect(counted).toMatch(/not hours/i);
    expect(counted).toContain("4");
  });

  it("assumes a working day shorter than the clock", () => {
    // Nobody spends eight hours on scheduled tasks.
    expect(MINUTES_PER_DAY).toBeLessThan(8 * 60);
  });

  it("keys days on the local calendar", () => {
    expect(localDayKey(new Date(2026, 8, 9, 0, 0))).toBe("2026-09-09");
    expect(localDayKey(new Date(2026, 8, 9, 23, 59))).toBe("2026-09-09");
  });
});
