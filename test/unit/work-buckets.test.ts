import { describe, it, expect } from "vitest";
import {
  WORK_BUCKETS,
  WORK_BUCKET_LABEL,
  WORK_BUCKET_RULE,
  bucketOf,
  bucketWork,
  dueDateForBucket,
  endOfWeek,
  workBucketOf,
  type TaskLike,
} from "../../src/modules/tasks/logic";

/**
 * LOCAL dates, not UTC instants.
 *
 * `bucketOf` decides "today" from the local calendar day, which is correct —
 * a person's today is their today, not UTC's. Writing these fixtures as
 * `2026-09-09T23:00:00Z` therefore failed in CEST, where that instant is
 * already the 10th: three tests reported the code wrong when the fixtures
 * were.
 */
const local = (y: number, m: number, d: number, h = 10, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0);

/** Wednesday 9 September 2026, mid-morning, wherever this runs. */
const NOW = local(2026, 9, 9);

function task(over: Partial<TaskLike> = {}): TaskLike {
  return { dueAt: null, doneAt: null, priority: "none", ...over } as TaskLike;
}
const due = (d: Date) => task({ dueAt: d });

describe("My Work's five buckets", () => {
  it("names and explains every one", () => {
    for (const b of WORK_BUCKETS) {
      expect(WORK_BUCKET_LABEL[b]).toBeTruthy();
      expect(WORK_BUCKET_RULE[b].length).toBeGreaterThan(10);
    }
  });

  it("puts a past date in overdue and today's in today", () => {
    expect(workBucketOf(due(local(2026, 9, 8)), NOW)).toBe("overdue");
    expect(workBucketOf(due(local(2026, 9, 9, 23)), NOW)).toBe("today");
  });

  it("splits the rest by whether it lands inside this week", () => {
    // Wednesday the 9th → the week ends Sunday the 13th.
    expect(workBucketOf(due(local(2026, 9, 11)), NOW)).toBe("week");
    expect(workBucketOf(due(local(2026, 9, 13, 23)), NOW)).toBe("week");
    expect(workBucketOf(due(local(2026, 9, 14)), NOW)).toBe("later");
  });

  /**
   * A reminder somebody wrote without a date is not LATE. Treating it as
   * overdue trains people to ignore the overdue count, which is the one number
   * that has to stay trustworthy — the same reasoning `bucketOf` carries.
   */
  it("keeps undated work out of overdue", () => {
    expect(workBucketOf(task(), NOW)).toBe("undated");
  });

  it("says done is done", () => {
    expect(workBucketOf(task({ doneAt: NOW, dueAt: local(2020, 1, 1) }), NOW)).toBe("done");
  });
});

/**
 * THE REQUIREMENT WITH TEETH: "Today Queue and My Work agree on what is due".
 *
 * The only way to guarantee that is one function, so this asserts the finer
 * reading can never contradict the coarse one — for every bucket, across a
 * spread of dates.
 */
describe("the two views cannot disagree", () => {
  const cases: [string, Date][] = [
    ["long past", local(2026, 8, 1)],
    ["yesterday, late", local(2026, 9, 8, 23, 59)],
    ["today, first minute", local(2026, 9, 9, 0, 1)],
    ["today, last minute", local(2026, 9, 9, 23, 59)],
    ["tomorrow", local(2026, 9, 10)],
    ["end of this week", local(2026, 9, 13, 23, 59)],
    ["just past this week", local(2026, 9, 14, 0, 1)],
    ["next year", local(2027, 1, 1)],
  ];

  it.each(cases)("%s lands in matching buckets", (_label, when) => {
    const t = due(when);
    const coarse = bucketOf(t, NOW);
    const fine = workBucketOf(t, NOW);
    const expected: Record<string, string[]> = {
      overdue: ["overdue"],
      today: ["today"],
      upcoming: ["week", "later"],
      someday: ["undated"],
      done: ["done"],
    };
    expect(expected[coarse]).toContain(fine);
  });

  it("agrees about undated and completed work too", () => {
    expect(bucketOf(task(), NOW)).toBe("someday");
    expect(workBucketOf(task(), NOW)).toBe("undated");
    const finished = task({ doneAt: NOW });
    expect(bucketOf(finished, NOW)).toBe("done");
    expect(workBucketOf(finished, NOW)).toBe("done");
  });
});

describe("what dragging into a bucket means", () => {
  it("today is the end of today", () => {
    const d = dueDateForBucket("today", NOW) as Date;
    expect(d.getDate()).toBe(9);
    expect(d.getMonth()).toBe(8);
    expect(d.getHours()).toBe(23);
  });

  it("this week is the coming Sunday", () => {
    const d = dueDateForBucket("week", NOW) as Date;
    expect(d.getTime()).toBe(endOfWeek(NOW).getTime());
    expect(d.getDay()).toBe(0);
  });

  it("later is a week out", () => {
    const d = dueDateForBucket("later", NOW) as Date;
    expect(d.getDate()).toBe(16);
  });

  it("no date clears it", () => {
    expect(dueDateForBucket("undated", NOW)).toBeNull();
  });

  /** Nobody means "make this late". */
  it("refuses overdue as a destination", () => {
    expect(dueDateForBucket("overdue", NOW)).toBeUndefined();
  });

  /** And every drop lands back in the bucket it was dropped into. */
  it.each(["today", "week", "later", "undated"] as const)(
    "a task dropped into %s reads back as %s",
    (bucket) => {
      const dueAt = dueDateForBucket(bucket, NOW);
      expect(workBucketOf(task({ dueAt: dueAt ?? null }), NOW)).toBe(bucket);
    },
  );
});

describe("arranging a list", () => {
  it("fills the buckets and drops completed work", () => {
    const buckets = bucketWork(
      [
        due(local(2026, 9, 1)),
        due(local(2026, 9, 9, 12)),
        due(local(2026, 9, 11, 12)),
        due(local(2026, 10, 1, 12)),
        task(),
        task({ doneAt: NOW }),
      ],
      NOW,
    );
    expect(buckets.overdue).toHaveLength(1);
    expect(buckets.today).toHaveLength(1);
    expect(buckets.week).toHaveLength(1);
    expect(buckets.later).toHaveLength(1);
    expect(buckets.undated).toHaveLength(1);
  });

  it("is all-empty for nothing", () => {
    const buckets = bucketWork([], NOW);
    expect(WORK_BUCKETS.every((b) => buckets[b].length === 0)).toBe(true);
  });
});
