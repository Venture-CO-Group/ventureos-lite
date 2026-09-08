import { describe, it, expect } from "vitest";
import {
  SOON_DAYS,
  bucketTasks,
  describeDue,
  digestSubject,
  isWorthSending,
  sortForDigest,
  startOfLocalDay,
  type DigestTask,
} from "../../src/modules/tasks/digest-logic";

/**
 * The start-of-day task email (P8/2).
 *
 * Every edge here is a date edge, and every one of them is a real bug waiting
 * to happen: a task due at 23:00 tonight is due TODAY, not overdue and not
 * "soon"; one due at 00:30 tomorrow is not due today even though it is eight
 * hours away; and "overdue" must never include something due this afternoon.
 * Bucketing in SQL would put those three decisions in three `where` clauses
 * and they would drift.
 */
const CET = 60; // UTC+1, Budapest in winter

function task(id: string, dueAt: string | null, priority = "normal"): DigestTask {
  return {
    id,
    title: `Task ${id}`,
    dueAt: dueAt ? new Date(dueAt) : null,
    priority,
    boardName: "Board",
    entityLabel: null,
    blocked: false,
  };
}

describe("local midnight", () => {
  it("is the midnight of the day the moment falls in, in that offset", () => {
    // 07:00 UTC on the 8th, in UTC+1, is 08:00 local on the 8th — so the day
    // started at 23:00 UTC on the 7th.
    const at = new Date("2026-09-08T07:00:00Z");
    expect(startOfLocalDay(at, CET).toISOString()).toBe("2026-09-07T23:00:00.000Z");
  });

  it("handles a moment that is already the previous day in UTC", () => {
    // 23:30 UTC on the 7th is 00:30 local on the 8th.
    const at = new Date("2026-09-07T23:30:00Z");
    expect(startOfLocalDay(at, CET).toISOString()).toBe("2026-09-07T23:00:00.000Z");
  });

  it("is plain UTC midnight at offset zero", () => {
    expect(startOfLocalDay(new Date("2026-09-08T07:00:00Z"), 0).toISOString()).toBe(
      "2026-09-08T00:00:00.000Z",
    );
  });
});

describe("bucketing by when it is due", () => {
  // The digest goes out at 06:00 UTC = 07:00 local.
  const now = new Date("2026-09-08T06:00:00Z");

  it("puts a task due later today in TODAY, not overdue", () => {
    // 21:00 local tonight. It is not late yet, and calling it late at 7am is
    // how a digest teaches people to ignore it.
    const b = bucketTasks([task("a", "2026-09-08T20:00:00Z")], now, {
      utcOffsetMinutes: CET,
    });
    expect(b.today.map((t) => t.id)).toEqual(["a"]);
    expect(b.overdue).toEqual([]);
  });

  it("puts a task due at 23:59 local tonight in TODAY", () => {
    const b = bucketTasks([task("a", "2026-09-08T22:58:00Z")], now, {
      utcOffsetMinutes: CET,
    });
    expect(b.today.map((t) => t.id)).toEqual(["a"]);
  });

  it("does NOT put a task due just after local midnight in TODAY", () => {
    // 00:30 local tomorrow — eight hours away, but a different day.
    const b = bucketTasks([task("a", "2026-09-08T23:30:00Z")], now, {
      utcOffsetMinutes: CET,
    });
    expect(b.today).toEqual([]);
    expect(b.soon.map((t) => t.id)).toEqual(["a"]);
  });

  it("puts anything before local midnight in OVERDUE", () => {
    const b = bucketTasks(
      [task("a", "2026-09-07T22:00:00Z"), task("b", "2026-08-01T10:00:00Z")],
      now,
      { utcOffsetMinutes: CET },
    );
    // Oldest first: the thing that has been late longest is the thing to fix.
    expect(b.overdue.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("reaches SOON_DAYS ahead and no further", () => {
    const inside = task("in", "2026-09-11T10:00:00Z"); // 3 days ahead
    const outside = task("out", "2026-09-13T10:00:00Z"); // 5 days ahead
    const b = bucketTasks([inside, outside], now, { utcOffsetMinutes: CET });
    expect(SOON_DAYS).toBe(3);
    expect(b.soon.map((t) => t.id)).toEqual(["in"]);
  });

  it("leaves an undated task out of every dated bucket", () => {
    // It is not late, not due today and not due soon. It belongs on the board,
    // not in a morning email that is about deadlines.
    const b = bucketTasks([task("a", null)], now, { utcOffsetMinutes: CET });
    expect(b.overdue).toEqual([]);
    expect(b.today).toEqual([]);
    expect(b.soon).toEqual([]);
  });

  it("never lists one task in two buckets", () => {
    const tasks = [
      task("late", "2026-09-01T10:00:00Z"),
      task("today", "2026-09-08T15:00:00Z"),
      task("soon", "2026-09-10T09:00:00Z"),
      task("far", "2026-10-01T09:00:00Z"),
      task("none", null),
    ];
    const b = bucketTasks(tasks, now, { utcOffsetMinutes: CET });
    const all = [...b.overdue, ...b.today, ...b.soon].map((t) => t.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(["late", "soon", "today"]);
  });
});

describe("ordering inside a bucket", () => {
  it("sorts by due date, then by priority", () => {
    const out = sortForDigest([
      task("b", "2026-09-08T12:00:00Z", "low"),
      task("a", "2026-09-08T09:00:00Z", "normal"),
      task("c", "2026-09-08T12:00:00Z", "urgent"),
    ]);
    expect(out.map((t) => t.id)).toEqual(["a", "c", "b"]);
  });

  it("puts an undated task last", () => {
    const out = sortForDigest([task("none", null, "urgent"), task("dated", "2026-12-01T09:00:00Z")]);
    expect(out.map((t) => t.id)).toEqual(["dated", "none"]);
  });

  it("does not mutate its input", () => {
    const input = [task("b", "2026-09-09T09:00:00Z"), task("a", "2026-09-08T09:00:00Z")];
    sortForDigest(input);
    expect(input.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("whether to send at all", () => {
  const empty = { overdue: [], today: [], soon: [], justAssigned: [] };

  it("stays quiet when there is nothing", () => {
    // A daily email that says "nothing due" is a daily email people filter.
    expect(isWorthSending(empty)).toBe(false);
  });

  it("sends for any single non-empty bucket", () => {
    expect(isWorthSending({ ...empty, overdue: [task("a", "2026-01-01T00:00:00Z")] })).toBe(true);
    expect(isWorthSending({ ...empty, today: [task("a", "2026-01-01T00:00:00Z")] })).toBe(true);
    expect(isWorthSending({ ...empty, soon: [task("a", "2026-01-01T00:00:00Z")] })).toBe(true);
    // Something handed over yesterday with no date on it is still news.
    expect(isWorthSending({ ...empty, justAssigned: [task("a", null)] })).toBe(true);
  });
});

describe("the subject line", () => {
  const empty = { overdue: [], today: [], soon: [], justAssigned: [] };
  const t = (n: number) => Array.from({ length: n }, (_, i) => task(String(i), null));

  it("leads with the number that decides whether it is opened", () => {
    expect(digestSubject({ ...empty, overdue: t(3), today: t(2) }, "Venture")).toBe(
      "3 késésben · 2 ma — Venture",
    );
  });

  it("falls back through the buckets rather than saying nothing", () => {
    expect(digestSubject({ ...empty, soon: t(4) }, "Venture")).toBe("4 a héten — Venture");
    expect(digestSubject({ ...empty, justAssigned: t(1) }, "Venture")).toBe("1 új — Venture");
  });

  it("names the workspace, never the product", () => {
    // A literal product name in a subject is the white-label leak the brand
    // work exists to prevent.
    const subject = digestSubject({ ...empty, today: t(1) }, "Másik Cég Kft.");
    expect(subject).toContain("Másik Cég Kft.");
    expect(subject).not.toMatch(/Venture\s*OS/i);
  });
});

describe("saying when something is due", () => {
  const now = new Date("2026-09-08T06:00:00Z");

  it("uses the local clock, not UTC", () => {
    // 14:00 UTC is 15:00 in Budapest, and the person reads the local time.
    expect(describeDue(new Date("2026-09-08T14:00:00Z"), now, CET)).toBe("ma 15:00");
  });

  it("counts days late", () => {
    expect(describeDue(new Date("2026-09-07T10:00:00Z"), now, CET)).toBe("tegnap lejárt");
    // Due on the 4th, read on the 8th — four days, counted in whole local
    // days rather than in elapsed hours, which is how a person counts them.
    expect(describeDue(new Date("2026-09-04T10:00:00Z"), now, CET)).toBe("4 napja lejárt");
  });

  it("names tomorrow, then counts", () => {
    expect(describeDue(new Date("2026-09-09T09:00:00Z"), now, CET)).toBe("holnap 10:00");
    expect(describeDue(new Date("2026-09-11T09:00:00Z"), now, CET)).toBe("3 nap múlva");
  });

  it("says so when there is no date", () => {
    expect(describeDue(null, now, CET)).toBe("nincs határidő");
  });
});
