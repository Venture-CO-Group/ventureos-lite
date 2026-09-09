import { describe, it, expect } from "vitest";
import {
  EMPTY_TASK_FILTER,
  GROUP_BYS,
  GROUP_BY_LABEL,
  UNASSIGNED,
  UNTAGGED,
  filterIsEmpty,
  groupTasksBy,
  isGroupBy,
  matchesTaskFilter,
  writeForGroup,
  type GroupableTask,
} from "../../src/modules/tasks/grouping";

const NOW = new Date(2026, 8, 9, 10, 0);
const MEMBERS = [
  { id: "u1", name: "Anna" },
  { id: "u2", name: "Béla" },
];

let n = 0;
function task(over: Partial<GroupableTask> = {}): GroupableTask {
  n += 1;
  return {
    id: `t${n}`,
    type: "todo",
    title: `Task ${n}`,
    dueAt: null,
    doneAt: null,
    sectionId: "s1",
    assigneeId: null,
    assigneeName: null,
    priority: "none",
    tags: [],
    ...over,
  };
}

describe("what a board can be grouped by", () => {
  it("names every option", () => {
    for (const g of GROUP_BYS) expect(GROUP_BY_LABEL[g]).toBeTruthy();
    expect(isGroupBy("section")).toBe(true);
    expect(isGroupBy("sprint")).toBe(false);
  });
});

/**
 * THE RULE THE WHOLE ITEM TURNS ON.
 *
 * A board's columns ARE its sections. Grouping by anything else rearranges
 * what you see and changes nothing about where the work lives — so a drop
 * writes the GROUPED ATTRIBUTE, and `sectionId` is never in the answer.
 * Treating a group as a section would shred a board's columns the first time
 * somebody grouped by priority and dragged a card.
 */
describe("what a drop into a group writes", () => {
  it("never writes sectionId", () => {
    for (const by of GROUP_BYS) {
      for (const key of ["high", "u1", "today", "seo", UNASSIGNED, UNTAGGED]) {
        const write = writeForGroup(by, key);
        if (write) expect(write.field).not.toBe("sectionId");
      }
    }
  });

  /** Section is a MOVE, and the null is the signal to take that path. */
  it("returns nothing for section, so the caller reorders instead", () => {
    expect(writeForGroup("section", "s2")).toBeNull();
  });

  it("sets the priority when grouped by priority", () => {
    expect(writeForGroup("priority", "high")).toEqual({ field: "priority", value: "high" });
  });

  it("refuses a priority that does not exist", () => {
    expect(writeForGroup("priority", "catastrophic")).toBeNull();
  });

  it("assigns, and unassigns for the unassigned column", () => {
    expect(writeForGroup("assignee", "u1")).toEqual({ field: "assigneeId", value: "u1" });
    expect(writeForGroup("assignee", UNASSIGNED)).toEqual({ field: "assigneeId", value: null });
  });

  it("reschedules when grouped by due date", () => {
    expect(writeForGroup("due", "today")).toEqual({ field: "dueBucket", value: "today" });
    expect(writeForGroup("due", "whenever")).toBeNull();
  });

  /** Dropping onto "No tag" would have to mean "remove which tag?". */
  it("adds a tag, but will not act on the untagged column", () => {
    expect(writeForGroup("tag", "seo")).toEqual({ field: "tag", value: "seo" });
    expect(writeForGroup("tag", UNTAGGED)).toBeNull();
  });
});

describe("arranging into groups", () => {
  it("shows every priority, highest first, even when empty", () => {
    const groups = groupTasksBy([task({ priority: "high" })], "priority", MEMBERS, NOW);
    expect(groups[0]!.key).toBe("urgent");
    expect(groups.map((g) => g.key)).toContain("none");
    expect(groups.find((g) => g.key === "high")!.tasks).toHaveLength(1);
    // An empty Urgent column is information, and somewhere to drop.
    expect(groups.find((g) => g.key === "urgent")!.tasks).toHaveLength(0);
  });

  it("gives every member a column and puts unassigned last", () => {
    const groups = groupTasksBy(
      [task({ assigneeId: "u1" }), task()],
      "assignee",
      MEMBERS,
      NOW,
    );
    expect(groups.map((g) => g.key)).toEqual(["u1", "u2", UNASSIGNED]);
    expect(groups.at(-1)!.tasks).toHaveLength(1);
  });

  it("refuses drops into Overdue when grouped by due date", () => {
    const groups = groupTasksBy([task()], "due", MEMBERS, NOW);
    expect(groups.find((g) => g.key === "overdue")!.droppable).toBe(false);
    expect(groups.find((g) => g.key === "today")!.droppable).toBe(true);
  });

  /**
   * A task with two tags appears in both groups. That is the honest rendering
   * of a set — and the reason "No tag" is not a destination.
   */
  it("puts a task with two tags in both, and cannot be dropped into No tag", () => {
    const groups = groupTasksBy([task({ tags: ["seo", "audit"] }), task()], "tag", MEMBERS, NOW);
    expect(groups.find((g) => g.key === "seo")!.tasks).toHaveLength(1);
    expect(groups.find((g) => g.key === "audit")!.tasks).toHaveLength(1);
    expect(groups.find((g) => g.key === UNTAGGED)!.droppable).toBe(false);
  });

  it("keeps tag groups in a stable order", () => {
    const groups = groupTasksBy([task({ tags: ["zeta"] }), task({ tags: ["alpha"] })], "tag", MEMBERS, NOW);
    expect(groups.map((g) => g.key).slice(0, 2)).toEqual(["alpha", "zeta"]);
  });
});

describe("filtering a board", () => {
  it("hides completed work by default, and can show only it", () => {
    const open = task();
    const done = task({ doneAt: NOW });
    expect(matchesTaskFilter(open, EMPTY_TASK_FILTER, NOW)).toBe(true);
    expect(matchesTaskFilter(done, EMPTY_TASK_FILTER, NOW)).toBe(false);
    expect(matchesTaskFilter(done, { ...EMPTY_TASK_FILTER, completion: "done" }, NOW)).toBe(true);
    expect(matchesTaskFilter(open, { ...EMPTY_TASK_FILTER, completion: "all" }, NOW)).toBe(true);
    expect(matchesTaskFilter(done, { ...EMPTY_TASK_FILTER, completion: "all" }, NOW)).toBe(true);
  });

  it("filters by assignee, including nobody", () => {
    const mine = task({ assigneeId: "u1" });
    const nobodys = task();
    expect(matchesTaskFilter(mine, { ...EMPTY_TASK_FILTER, assigneeId: "u1" }, NOW)).toBe(true);
    expect(matchesTaskFilter(nobodys, { ...EMPTY_TASK_FILTER, assigneeId: "u1" }, NOW)).toBe(false);
    expect(matchesTaskFilter(nobodys, { ...EMPTY_TASK_FILTER, assigneeId: UNASSIGNED }, NOW)).toBe(
      true,
    );
  });

  it("filters by priority, tag and due bucket", () => {
    const t = task({ priority: "high", tags: ["seo"], dueAt: new Date(2026, 8, 9, 12) });
    expect(matchesTaskFilter(t, { ...EMPTY_TASK_FILTER, priority: "high" }, NOW)).toBe(true);
    expect(matchesTaskFilter(t, { ...EMPTY_TASK_FILTER, priority: "low" }, NOW)).toBe(false);
    expect(matchesTaskFilter(t, { ...EMPTY_TASK_FILTER, tag: "seo" }, NOW)).toBe(true);
    expect(matchesTaskFilter(t, { ...EMPTY_TASK_FILTER, tag: "ads" }, NOW)).toBe(false);
    expect(matchesTaskFilter(t, { ...EMPTY_TASK_FILTER, due: "today" }, NOW)).toBe(true);
    expect(matchesTaskFilter(t, { ...EMPTY_TASK_FILTER, due: "later" }, NOW)).toBe(false);
  });

  it("filters by blocked state in both directions", () => {
    const blocked = { ...task(), blockedCount: 2 };
    const free = { ...task(), blockedCount: 0 };
    expect(matchesTaskFilter(blocked, { ...EMPTY_TASK_FILTER, blocked: true }, NOW)).toBe(true);
    expect(matchesTaskFilter(free, { ...EMPTY_TASK_FILTER, blocked: true }, NOW)).toBe(false);
    expect(matchesTaskFilter(free, { ...EMPTY_TASK_FILTER, blocked: false }, NOW)).toBe(true);
    expect(matchesTaskFilter(blocked, { ...EMPTY_TASK_FILTER, blocked: false }, NOW)).toBe(false);
  });

  it("knows when it is filtering nothing", () => {
    expect(filterIsEmpty(EMPTY_TASK_FILTER)).toBe(true);
    expect(filterIsEmpty({ ...EMPTY_TASK_FILTER, tag: "seo" })).toBe(false);
    // "open" IS the default, so it does not count as a filter.
    expect(filterIsEmpty({ ...EMPTY_TASK_FILTER, completion: "open" })).toBe(true);
    expect(filterIsEmpty({ ...EMPTY_TASK_FILTER, completion: "all" })).toBe(false);
  });
});
