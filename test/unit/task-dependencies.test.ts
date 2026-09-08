import { describe, it, expect } from "vitest";
import {
  blockedBy,
  describeRecurrence,
  readRecurrence,
  wouldCycle,
  type DependencyEdge,
} from "../../src/modules/tasks/board-logic";

/**
 * Dependencies were deliberately left out of the first version of the board,
 * and the reason was exactly this: a badly drawn graph is worse than no graph.
 * "A waits for B, B waits for A" is a pair of tasks that can never be started,
 * and once three or four are involved nobody looking at the board can see why
 * nothing is startable.
 */
const edge = (taskId: string, blockedById: string): DependencyEdge => ({ taskId, blockedById });

describe("refusing a dependency that would make a cycle", () => {
  it("refuses a task waiting for itself", () => {
    expect(wouldCycle([], "a", "a")).toBe(true);
  });

  it("allows an ordinary edge", () => {
    expect(wouldCycle([], "a", "b")).toBe(false);
  });

  it("refuses the direct two-task loop", () => {
    // a already waits for b; b waiting for a closes it.
    expect(wouldCycle([edge("a", "b")], "b", "a")).toBe(true);
  });

  it("refuses a loop three tasks long", () => {
    const edges = [edge("a", "b"), edge("b", "c")];
    expect(wouldCycle(edges, "c", "a")).toBe(true);
  });

  it("refuses a loop five tasks long", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e")];
    expect(wouldCycle(edges, "e", "a")).toBe(true);
  });

  it("allows a diamond, which is not a cycle", () => {
    // a waits for b and c; both wait for d. Perfectly startable.
    const edges = [edge("a", "b"), edge("a", "c"), edge("b", "d")];
    expect(wouldCycle(edges, "c", "d")).toBe(false);
  });

  it("allows a second edge in the same direction", () => {
    expect(wouldCycle([edge("a", "b")], "a", "c")).toBe(false);
  });

  it("terminates on a graph that already contains a cycle", () => {
    // Should be impossible, but a hand-edited row must not hang the walk.
    const edges = [edge("a", "b"), edge("b", "a")];
    expect(wouldCycle(edges, "c", "a")).toBe(false);
    expect(wouldCycle(edges, "a", "b")).toBe(true);
  });

  it("is unaffected by edges in an unrelated component", () => {
    const edges = [edge("x", "y"), edge("y", "z")];
    expect(wouldCycle(edges, "a", "b")).toBe(false);
  });
});

describe("what a task is waiting for", () => {
  const edges = [edge("a", "b"), edge("a", "c")];

  it("lists only the unfinished blockers", () => {
    const done = new Map([
      ["b", true],
      ["c", false],
    ]);
    expect(blockedBy({ id: "a" }, edges, done)).toEqual(["c"]);
  });

  it("says nothing when every blocker is finished", () => {
    const done = new Map([
      ["b", true],
      ["c", true],
    ]);
    expect(blockedBy({ id: "a" }, edges, done)).toEqual([]);
  });

  it("says nothing for a task with no dependencies", () => {
    expect(blockedBy({ id: "z" }, edges, new Map())).toEqual([]);
  });

  it("ignores a blocker whose state is unknown rather than assuming it is open", () => {
    // A blocker that has been deleted is not a reason to mark work blocked for
    // ever — the row would be gone and nobody could clear it.
    expect(blockedBy({ id: "a" }, edges, new Map())).toEqual([]);
  });
});

describe("recurrence read off a JSON column", () => {
  it("reads a well-formed value", () => {
    expect(readRecurrence({ cadence: "weekly", dayOfWeek: 3 })).toEqual({
      cadence: "weekly",
      dayOfWeek: 3,
    });
  });

  it("refuses anything that is not a recurrence", () => {
    // A hand-edited row must degrade to "happens once" rather than throwing on
    // every board render.
    expect(readRecurrence(null)).toBeNull();
    expect(readRecurrence("weekly")).toBeNull();
    expect(readRecurrence([])).toBeNull();
    expect(readRecurrence({})).toBeNull();
    expect(readRecurrence({ cadence: "fortnightly" })).toBeNull();
  });

  it("drops an out-of-range day rather than trusting it", () => {
    expect(readRecurrence({ cadence: "weekly", dayOfWeek: 9 })).toEqual({ cadence: "weekly" });
    expect(readRecurrence({ cadence: "monthly", dayOfMonth: 31 })).toEqual({ cadence: "monthly" });
    // 28 is the highest day that exists in every month.
    expect(readRecurrence({ cadence: "monthly", dayOfMonth: 28 })).toEqual({
      cadence: "monthly",
      dayOfMonth: 28,
    });
  });

  it("says it back in words", () => {
    expect(describeRecurrence({ cadence: "daily" })).toBe("Repeats every day");
    expect(describeRecurrence({ cadence: "weekly", dayOfWeek: 5 })).toBe("Repeats every Friday");
    expect(describeRecurrence({ cadence: "monthly", dayOfMonth: 3 })).toBe(
      "Repeats on the 3rd of every month",
    );
  });
});
