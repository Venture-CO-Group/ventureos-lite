import { describe, it, expect } from "vitest";
import {
  MAX_CHECKLIST_ITEMS,
  MAX_ITEM_LENGTH,
  CHECKLIST_VS_SUBTASK,
  groupProgress,
  nextPosition,
  progressLabel,
  progressOf,
} from "../../src/modules/tasks/checklist-logic";

/**
 * Checklist arithmetic (playbook-v5 P20/3).
 *
 * The database guarantees are in test/integration/task-checklist.test.ts —
 * above all the one the playbook names, that 7/7 does not complete the task.
 */
const done = (n: number) => Array.from({ length: n }, () => ({ doneAt: new Date() }));
const open = (n: number) => Array.from({ length: n }, () => ({ doneAt: null }));

describe("checklist progress", () => {
  it("counts the ticked ones", () => {
    expect(progressOf([...done(3), ...open(4)])).toEqual({ done: 3, total: 7 });
  });

  it("reads as 3/7", () => {
    expect(progressLabel({ done: 3, total: 7 })).toBe("3/7");
  });

  it("says nothing at all when there is no checklist", () => {
    // The card must not carry an empty "0/0" chip on every task that has
    // never had a step — that is most tasks.
    expect(progressLabel({ done: 0, total: 0 })).toBeNull();
    expect(progressOf([])).toEqual({ done: 0, total: 0 });
  });

  it("shows 0/4 rather than nothing when the steps exist but none is ticked", () => {
    expect(progressLabel(progressOf(open(4)))).toBe("0/4");
  });
});

describe("groupProgress", () => {
  it("splits rows by task and counts each separately", () => {
    const map = groupProgress([
      { taskId: "a", doneAt: new Date() },
      { taskId: "a", doneAt: null },
      { taskId: "b", doneAt: new Date() },
      { taskId: "b", doneAt: new Date() },
    ]);
    expect(map.get("a")).toEqual({ done: 1, total: 2 });
    expect(map.get("b")).toEqual({ done: 2, total: 2 });
    // A task with no steps must be absent, not { done: 0, total: 0 } — the
    // card decides whether to draw the chip on exactly that difference.
    expect(map.has("c")).toBe(false);
  });

  it("returns an empty map for no rows", () => {
    expect(groupProgress([]).size).toBe(0);
  });
});

describe("positions", () => {
  it("starts at the step and appends past the highest", () => {
    expect(nextPosition([])).toBe(1024);
    expect(nextPosition([1024, 2048])).toBe(3072);
    // Sparse, and out of order: appending must look at the maximum, not the
    // length, or two steps land on one position.
    expect(nextPosition([5000, 1024])).toBe(6024);
  });
});

describe("the limits are stated, not implied", () => {
  it("caps the list and the step", () => {
    expect(MAX_CHECKLIST_ITEMS).toBe(50);
    expect(MAX_ITEM_LENGTH).toBe(200);
  });

  it("names both tools in the sentence the UI prints", () => {
    // The distinction is the whole point of shipping a second, lighter tool
    // beside subtasks; if the sentence stops saying which is which, nobody
    // can tell them apart in the panel.
    expect(CHECKLIST_VS_SUBTASK).toMatch(/checklist/i);
    expect(CHECKLIST_VS_SUBTASK).toMatch(/subtask/i);
  });
});
