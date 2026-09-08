import { describe, it, expect } from "vitest";
import {
  POSITION_STEP,
  TASK_PRIORITIES,
  PRIORITY_LABEL,
  boardProgress,
  extractMentions,
  needsRebalance,
  nextPosition,
  positionBetween,
  priorityRank,
  rebalance,
  subtaskProgress,
} from "../../src/modules/tasks/board-logic";

/**
 * Reordering is the operation most likely to look right in a demo and be wrong
 * on the fifteenth drag, which is why it lives in a tested function rather than
 * inline in a server action.
 */
describe("where a dragged card lands", () => {
  it("puts the first card somewhere, not at zero", () => {
    // Zero would leave no room to drop anything above it.
    expect(nextPosition([])).toBe(POSITION_STEP);
  });

  it("appends after the highest rank, not after the last one it happened to see", () => {
    expect(nextPosition([3072, 1024, 2048])).toBe(4096);
  });

  it("takes the midpoint between two neighbours", () => {
    expect(positionBetween(1024, 2048)).toBe(1536);
  });

  it("handles the two ends of a column", () => {
    expect(positionBetween(null, 1024)).toBe(0);
    expect(positionBetween(2048, null)).toBe(3072);
    expect(positionBetween(null, null)).toBe(POSITION_STEP);
  });

  it("refuses rather than colliding when the gap is used up", () => {
    // Two cards with the same rank order arbitrarily, and a board that
    // reshuffles itself on refresh is a board nobody trusts. Null tells the
    // caller to respace and retry.
    expect(positionBetween(1024, 1025)).toBeNull();
    expect(positionBetween(1024, 1024)).toBeNull();
    expect(positionBetween(1024, 1026)).toBe(1025);
  });

  it("survives ten consecutive drops into the same gap before needing a respace", () => {
    // The claim the 1024 step is chosen for.
    let before = 0;
    const after = 1024;
    let drops = 0;
    for (;;) {
      const p = positionBetween(before, after);
      if (p === null) break;
      before = p;
      drops += 1;
      if (drops > 50) throw new Error("unreachable");
    }
    expect(drops).toBeGreaterThanOrEqual(9);
  });

  it("notices a collapsed column and respaces it evenly", () => {
    expect(needsRebalance([1024, 2048, 3072])).toBe(false);
    expect(needsRebalance([1024, 1025, 3072])).toBe(true);
    expect(rebalance(3)).toEqual([1024, 2048, 3072]);
    expect(needsRebalance(rebalance(8))).toBe(false);
  });

  it("respacing an empty or single-card column is not an error", () => {
    expect(rebalance(0)).toEqual([]);
    expect(needsRebalance([])).toBe(false);
    expect(needsRebalance([5])).toBe(false);
  });
});

describe("board progress", () => {
  const d = (s: string) => new Date(s);

  it("counts done, overdue and a percentage", () => {
    const now = d("2026-09-08T12:00:00Z");
    const p = boardProgress(
      [
        { doneAt: d("2026-09-01"), dueAt: d("2026-09-01") },
        { doneAt: null, dueAt: d("2026-09-01") }, // overdue
        { doneAt: null, dueAt: d("2026-09-30") },
        { doneAt: null, dueAt: null },
      ],
      now,
    );
    expect(p).toEqual({ total: 4, done: 1, overdue: 1, pct: 25 });
  });

  it("does not call a task due earlier today overdue", () => {
    const now = d("2026-09-08T18:00:00Z");
    const p = boardProgress([{ doneAt: null, dueAt: d("2026-09-08T09:00:00Z") }], now);
    // Colouring a 09:00 task red at 09:01 is how a board becomes noise by
    // lunchtime.
    expect(p.overdue).toBe(0);
  });

  it("never counts a completed task as overdue", () => {
    const now = d("2026-09-08T12:00:00Z");
    const p = boardProgress([{ doneAt: d("2026-09-07"), dueAt: d("2026-01-01") }], now);
    expect(p.overdue).toBe(0);
  });

  it("reports an empty board as 0%, not 100%", () => {
    // "Complete" is a claim, and an empty board has not earned it. It also
    // must not be NaN.
    expect(boardProgress([])).toEqual({ total: 0, done: 0, overdue: 0, pct: 0 });
  });
});

describe("subtask progress is reported, never enforced", () => {
  it("counts what is finished", () => {
    expect(subtaskProgress([{ doneAt: new Date() }, { doneAt: null }])).toEqual({
      done: 1,
      total: 2,
    });
  });

  it("says nothing at all when there are no subtasks", () => {
    // null rather than 0/0, so a card with no steps renders no counter.
    expect(subtaskProgress([])).toBeNull();
  });
});

describe("priority", () => {
  it("has a label for every value", () => {
    for (const p of TASK_PRIORITIES) expect(PRIORITY_LABEL[p]).toBeTruthy();
  });

  it("sorts urgent first and unset last", () => {
    const sorted = [...TASK_PRIORITIES].sort((a, b) => priorityRank(a) - priorityRank(b));
    expect(sorted[0]).toBe("urgent");
    expect(sorted[sorted.length - 1]).toBe("none");
  });

  it("treats an unrecognised value as no priority rather than throwing", () => {
    expect(priorityRank("banana")).toBe(priorityRank("none"));
  });
});

describe("who a comment names", () => {
  const members = [
    { id: "u1", name: "Tamás" },
    { id: "u2", name: "Fanni Virágh" },
    { id: "u3", name: "Fanni" },
  ];

  it("finds a mention", () => {
    expect(extractMentions("can you look at this @Tamás", members)).toEqual(["u1"]);
  });

  it("prefers the longest matching name", () => {
    // Otherwise "@Fanni Virágh" matches "Fanni" and the wrong person is
    // notified — with a stray surname left in the text to prove it.
    expect(extractMentions("@Fanni Virágh please", members)).toContain("u2");
  });

  it("is case-insensitive, because nobody types accents consistently", () => {
    expect(extractMentions("@tamás", members)).toEqual(["u1"]);
  });

  it("names nobody when nobody is named", () => {
    expect(extractMentions("email tamás about this", members)).toEqual([]);
    expect(extractMentions("", members)).toEqual([]);
  });

  it("never returns the same person twice", () => {
    expect(extractMentions("@Tamás and again @Tamás", members)).toEqual(["u1"]);
  });

  it("ignores a member with a blank name rather than matching every @", () => {
    expect(extractMentions("@anything", [{ id: "x", name: "   " }])).toEqual([]);
  });
});
