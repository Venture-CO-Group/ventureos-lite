import { describe, it, expect } from "vitest";
import {
  DAY_WIDTH,
  ZOOMS,
  ZOOM_LABEL,
  addDays,
  applyDrag,
  barFor,
  barGeometry,
  brokenDependents,
  daysBetween,
  isZoom,
  planDependentShift,
  snapDays,
  timelineRange,
  timelineRows,
  todayOffset,
  visibleRowRange,
  weekendDays,
  type TimelineTask,
} from "../../src/modules/tasks/timeline";

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day, 12, 0, 0, 0);
/** Wednesday 9 September 2026. */
const NOW = d(2026, 9, 9);

let n = 0;
function task(over: Partial<TimelineTask> = {}): TimelineTask {
  n += 1;
  return {
    id: `t${n}`,
    title: `Task ${n}`,
    startAt: null,
    dueAt: null,
    doneAt: null,
    parentId: null,
    priority: "none",
    ...over,
  };
}

describe("the scale", () => {
  it("names every zoom and widens the day as it goes in", () => {
    for (const z of ZOOMS) expect(ZOOM_LABEL[z]).toBeTruthy();
    expect(DAY_WIDTH.day).toBeGreaterThan(DAY_WIDTH.week);
    expect(DAY_WIDTH.week).toBeGreaterThan(DAY_WIDTH.month);
    expect(isZoom("day")).toBe(true);
    expect(isZoom("hour")).toBe(false);
  });

  it("counts whole days across a month boundary", () => {
    expect(daysBetween(d(2026, 8, 30), d(2026, 9, 2))).toBe(3);
    expect(daysBetween(d(2026, 9, 9), d(2026, 9, 9))).toBe(0);
    expect(daysBetween(d(2026, 9, 10), d(2026, 9, 9))).toBe(-1);
  });

  /**
   * Rounded rather than floored, so an hour of daylight-saving drift cannot
   * eat a day — the classic Gantt off-by-one.
   */
  it("is not fooled by a clock change", () => {
    // Europe/Budapest springs forward on the last Sunday of March.
    expect(daysBetween(d(2026, 3, 28), d(2026, 3, 30))).toBe(2);
    expect(daysBetween(d(2026, 10, 24), d(2026, 10, 26))).toBe(2);
  });

  it("always includes today, even for a board dated years ago", () => {
    const range = timelineRange([task({ dueAt: d(2020, 1, 1) })], NOW);
    expect(todayOffset(range.from, range.days, NOW)).not.toBeNull();
  });

  it("never produces an empty window", () => {
    const range = timelineRange([], NOW);
    expect(range.days).toBeGreaterThan(0);
    const oneDay = timelineRange([task({ startAt: NOW, dueAt: NOW })], NOW);
    expect(oneDay.days).toBeGreaterThan(1);
  });

  it("shades weekends", () => {
    // From Saturday 5 September 2026, a fortnight.
    const weekends = weekendDays(d(2026, 9, 5), 14);
    expect(weekends).toContain(0);
    expect(weekends).toContain(1);
    expect(weekends).toContain(7);
    expect(weekends).not.toContain(2);
  });

  it("hides the today marker when today is off the chart", () => {
    expect(todayOffset(d(2026, 1, 1), 10, NOW)).toBeNull();
  });
});

/**
 * THE RULE THE PLAYBOOK IS EMPHATIC ABOUT: a task with only a due date is a
 * milestone. Inventing a start date so the chart looks fuller would be the
 * product making up a fact about somebody's work.
 */
describe("what a task looks like on the chart", () => {
  const from = d(2026, 9, 1);

  it("draws a bar when both dates are real", () => {
    const bar = barFor(task({ startAt: d(2026, 9, 3), dueAt: d(2026, 9, 5) }), from);
    expect(bar.kind).toBe("bar");
    expect(bar.offsetDays).toBe(2);
    // Inclusive: the 3rd to the 5th is three days, not two.
    expect(bar.lengthDays).toBe(3);
  });

  it("occupies one day when it starts and ends on the same day", () => {
    const bar = barFor(task({ startAt: d(2026, 9, 3), dueAt: d(2026, 9, 3) }), from);
    expect(bar.lengthDays).toBe(1);
  });

  it("draws a MILESTONE for a due date with no start, and invents nothing", () => {
    const bar = barFor(task({ dueAt: d(2026, 9, 4) }), from);
    expect(bar.kind).toBe("milestone");
    expect(bar.lengthDays).toBe(0);
    expect(bar.offsetDays).toBe(3);
  });

  /** A start with no end has no length to draw, so it is listed, not guessed. */
  it("calls a start date with no due date unscheduled", () => {
    expect(barFor(task({ startAt: d(2026, 9, 4) }), from).kind).toBe("unscheduled");
    expect(barFor(task(), from).kind).toBe("unscheduled");
  });

  it("gives a milestone a grabbable width", () => {
    const bar = barFor(task({ dueAt: d(2026, 9, 4) }), from);
    expect(barGeometry(bar, "day").width).toBe(DAY_WIDTH.day);
    expect(barGeometry(bar, "month").width).toBe(DAY_WIDTH.month);
  });

  it("scales a bar with the zoom", () => {
    const bar = barFor(task({ startAt: d(2026, 9, 3), dueAt: d(2026, 9, 5) }), from);
    expect(barGeometry(bar, "day").left).toBe(2 * DAY_WIDTH.day);
    expect(barGeometry(bar, "day").width).toBe(3 * DAY_WIDTH.day);
    expect(barGeometry(bar, "week").width).toBe(3 * DAY_WIDTH.week);
  });
});

describe("dragging", () => {
  it("snaps to whole days at every zoom", () => {
    expect(snapDays(DAY_WIDTH.day * 2 + 5, "day")).toBe(2);
    expect(snapDays(DAY_WIDTH.day * 2 - 5, "day")).toBe(2);
    expect(snapDays(3, "month")).toBe(1);
    expect(snapDays(0, "day")).toBe(0);
  });

  it("moving a bar keeps its length", () => {
    const t = task({ startAt: d(2026, 9, 3), dueAt: d(2026, 9, 6) });
    const res = applyDrag(t, "move", 2)!;
    expect(daysBetween(res.startAt!, res.dueAt!)).toBe(3);
    expect(res.startAt!.getDate()).toBe(5);
    expect(res.dueAt!.getDate()).toBe(8);
  });

  it("resizing moves only the edge dragged", () => {
    const t = task({ startAt: d(2026, 9, 3), dueAt: d(2026, 9, 6) });
    const start = applyDrag(t, "resize-start", 1)!;
    expect(start.startAt!.getDate()).toBe(4);
    expect(start.dueAt!.getDate()).toBe(6);
    const end = applyDrag(t, "resize-end", 2)!;
    expect(end.startAt!.getDate()).toBe(3);
    expect(end.dueAt!.getDate()).toBe(8);
  });

  /** A bar cannot be dragged inside out; the far edge is a floor. */
  it("will not resize a bar past its other end", () => {
    const t = task({ startAt: d(2026, 9, 3), dueAt: d(2026, 9, 6) });
    const collapsed = applyDrag(t, "resize-start", 10)!;
    expect(daysBetween(collapsed.startAt!, collapsed.dueAt!)).toBe(0);
    const other = applyDrag(t, "resize-end", -10)!;
    expect(daysBetween(other.startAt!, other.dueAt!)).toBe(0);
  });

  it("moves the one date a milestone has", () => {
    const res = applyDrag(task({ dueAt: d(2026, 9, 4) }), "move", 3)!;
    expect(res.startAt).toBeNull();
    expect(res.dueAt!.getDate()).toBe(7);
  });

  it("does nothing for a drag of zero days, or for unscheduled work", () => {
    expect(applyDrag(task({ dueAt: NOW }), "move", 0)).toBeNull();
    expect(applyDrag(task(), "move", 3)).toBeNull();
  });
});

/**
 * NEVER CASCADE SILENTLY — the playbook's words. Moving a blocker computes who
 * it broke so the UI can highlight them and OFFER a shift; it does not rewrite
 * dates nobody asked about.
 */
describe("scheduling intelligence", () => {
  it("names the dependents a move has broken, and by how much", () => {
    const blocker = task({ id: "a", startAt: d(2026, 9, 1), dueAt: d(2026, 9, 10) });
    const dependent = task({ id: "b", startAt: d(2026, 9, 5), dueAt: d(2026, 9, 8) });
    const broken = brokenDependents(
      [blocker, dependent],
      [{ taskId: "b", blockedById: "a" }],
      "a",
    );
    expect(broken).toHaveLength(1);
    // It starts on the 5th; the blocker ends the 10th; it must start the 11th.
    expect(broken[0]!.shiftDays).toBe(6);
  });

  it("says nothing when the dependent already starts late enough", () => {
    const blocker = task({ id: "a", startAt: d(2026, 9, 1), dueAt: d(2026, 9, 5) });
    const dependent = task({ id: "b", startAt: d(2026, 9, 6), dueAt: d(2026, 9, 9) });
    expect(
      brokenDependents([blocker, dependent], [{ taskId: "b", blockedById: "a" }], "a"),
    ).toEqual([]);
  });

  /** A milestone has no start to be too early. */
  it("cannot break a dependent that has no start date", () => {
    const blocker = task({ id: "a", startAt: d(2026, 9, 1), dueAt: d(2026, 9, 10) });
    const milestone = task({ id: "b", dueAt: d(2026, 9, 2) });
    expect(
      brokenDependents([blocker, milestone], [{ taskId: "b", blockedById: "a" }], "a"),
    ).toEqual([]);
  });

  it("walks the whole chain when a shift is confirmed", () => {
    const a = task({ id: "a", startAt: d(2026, 9, 1), dueAt: d(2026, 9, 10) });
    const b = task({ id: "b", startAt: d(2026, 9, 5), dueAt: d(2026, 9, 8) });
    const c = task({ id: "c", startAt: d(2026, 9, 9), dueAt: d(2026, 9, 12) });
    const plan = planDependentShift(
      [a, b, c],
      [
        { taskId: "b", blockedById: "a" },
        { taskId: "c", blockedById: "b" },
      ],
      "a",
    );
    expect([...plan.keys()].sort()).toEqual(["b", "c"]);
    // b moves to start the 11th; c must then start after b's new end.
    expect(plan.get("b")!.startAt.getDate()).toBe(11);
    expect(plan.get("c")!.startAt.getTime()).toBeGreaterThan(plan.get("b")!.dueAt.getTime());
  });

  /** Bounded, so a cycle that slipped past the guard cannot spin here. */
  it("terminates on a cyclic graph", () => {
    const a = task({ id: "a", startAt: d(2026, 9, 1), dueAt: d(2026, 9, 5) });
    const b = task({ id: "b", startAt: d(2026, 9, 2), dueAt: d(2026, 9, 6) });
    const plan = planDependentShift(
      [a, b],
      [
        { taskId: "b", blockedById: "a" },
        { taskId: "a", blockedById: "b" },
      ],
      "a",
    );
    expect(plan.size).toBeGreaterThan(0);
  });
});

describe("rows", () => {
  it("puts subtasks under their parent, indented", () => {
    const parent = task({ id: "p", title: "Parent" });
    const kid = task({ id: "k", title: "Kid", parentId: "p" });
    const rows = timelineRows([parent, kid]);
    expect(rows.map((r) => r.task.id)).toEqual(["p", "k"]);
    expect(rows[1]!.depth).toBe(1);
    expect(rows[0]!.childCount).toBe(1);
  });

  it("collapses a parent's children away", () => {
    const parent = task({ id: "p" });
    const kid = task({ id: "k", parentId: "p" });
    const rows = timelineRows([parent, kid], new Set(["p"]));
    expect(rows.map((r) => r.task.id)).toEqual(["p"]);
  });

  /**
   * A filter can hide a parent while keeping its child. Dropping the child
   * would mean the chart quietly showed less work than the board did.
   */
  it("still shows a subtask whose parent is not in the list", () => {
    const orphan = task({ id: "k", parentId: "missing" });
    expect(timelineRows([orphan]).map((r) => r.task.id)).toEqual(["k"]);
  });
});

describe("virtualization", () => {
  it("renders a window with overscan, not the whole board", () => {
    const { start, end } = visibleRowRange(500, 1000, 400, 40);
    expect(start).toBeLessThan(25);
    expect(end - start).toBeLessThan(40);
    expect(end).toBeLessThanOrEqual(500);
  });

  it("never runs past the end, or before the start", () => {
    expect(visibleRowRange(10, 0, 400, 40).start).toBe(0);
    expect(visibleRowRange(10, 100_000, 400, 40).end).toBeLessThanOrEqual(10);
    expect(visibleRowRange(0, 0, 400, 40)).toEqual({ start: 0, end: 0 });
  });
});
