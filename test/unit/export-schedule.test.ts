import { describe, it, expect } from "vitest";
import {
  CADENCE_LABEL,
  EXPORT_CADENCES,
  describeSchedule,
  isoWeekday,
  nextRunAt,
} from "../../src/modules/leads/schedule-logic";

/**
 * "Next Monday at 08:00" is the kind of arithmetic that looks obviously right
 * and is wrong on the day itself, at a month boundary, and in February. All
 * three are pinned here rather than discovered by somebody noticing a report
 * never arrived.
 */
const at = (iso: string) => new Date(iso);

describe("ISO weekdays", () => {
  it("counts Monday as 1 and Sunday as 7", () => {
    // JS says Sunday is 0, which puts the weekend at both ends of the week.
    expect(isoWeekday(at("2026-09-07T10:00:00"))).toBe(1); // Monday
    expect(isoWeekday(at("2026-09-13T10:00:00"))).toBe(7); // Sunday
  });
});

describe("daily", () => {
  const spec = { cadence: "daily" as const, dayOfWeek: 1, dayOfMonth: 1, hour: 8 };

  it("fires later today when the hour has not passed", () => {
    // A schedule created at 07:00 for 08:00 should run in an hour, not
    // tomorrow — "at or after", not "strictly after".
    expect(nextRunAt(spec, at("2026-09-08T07:00:00")).toISOString()).toBe(
      at("2026-09-08T08:00:00").toISOString(),
    );
  });

  it("fires tomorrow once the hour has passed", () => {
    expect(nextRunAt(spec, at("2026-09-08T09:00:00")).toISOString()).toBe(
      at("2026-09-09T08:00:00").toISOString(),
    );
  });

  it("treats the exact minute as due rather than as missed", () => {
    expect(nextRunAt(spec, at("2026-09-08T08:00:00")).toISOString()).toBe(
      at("2026-09-08T08:00:00").toISOString(),
    );
  });
});

describe("weekly", () => {
  const monday8 = { cadence: "weekly" as const, dayOfWeek: 1, dayOfMonth: 1, hour: 8 };

  it("fires today when today is the day and the hour is ahead", () => {
    // 2026-09-07 is a Monday.
    expect(nextRunAt(monday8, at("2026-09-07T06:00:00")).toISOString()).toBe(
      at("2026-09-07T08:00:00").toISOString(),
    );
  });

  it("waits a whole week when the hour has already passed today", () => {
    // The off-by-one that would otherwise fire twice on the same morning.
    expect(nextRunAt(monday8, at("2026-09-07T09:00:00")).toISOString()).toBe(
      at("2026-09-14T08:00:00").toISOString(),
    );
  });

  it("finds the next occurrence later in the same week", () => {
    const friday = { ...monday8, dayOfWeek: 5 };
    // Tuesday → Friday is three days, not next week.
    expect(nextRunAt(friday, at("2026-09-08T09:00:00")).toISOString()).toBe(
      at("2026-09-11T08:00:00").toISOString(),
    );
  });

  it("wraps into the following week when the day has gone", () => {
    const monday = monday8;
    // Wednesday, asking for Monday.
    expect(nextRunAt(monday, at("2026-09-09T09:00:00")).toISOString()).toBe(
      at("2026-09-14T08:00:00").toISOString(),
    );
  });

  it("handles Sunday, which JS numbers as zero", () => {
    const sunday = { ...monday8, dayOfWeek: 7 };
    expect(nextRunAt(sunday, at("2026-09-07T09:00:00")).toISOString()).toBe(
      at("2026-09-13T08:00:00").toISOString(),
    );
  });
});

describe("monthly", () => {
  const first8 = { cadence: "monthly" as const, dayOfWeek: 1, dayOfMonth: 1, hour: 8 };

  it("fires this month when the day is still ahead", () => {
    const tenth = { ...first8, dayOfMonth: 10 };
    expect(nextRunAt(tenth, at("2026-09-08T09:00:00")).toISOString()).toBe(
      at("2026-09-10T08:00:00").toISOString(),
    );
  });

  it("rolls to next month once the day has gone", () => {
    expect(nextRunAt(first8, at("2026-09-08T09:00:00")).toISOString()).toBe(
      at("2026-10-01T08:00:00").toISOString(),
    );
  });

  it("crosses a year boundary", () => {
    expect(nextRunAt(first8, at("2026-12-15T09:00:00")).toISOString()).toBe(
      at("2027-01-01T08:00:00").toISOString(),
    );
  });

  it("survives February, because the day is clamped to 28", () => {
    // Asking for the 31st in a 28-day month is how a monthly job silently
    // skips a month — or rolls into the one after.
    const thirtyFirst = { ...first8, dayOfMonth: 31 };
    const from = at("2027-01-29T09:00:00");
    const next = nextRunAt(thirtyFirst, from);
    expect(next.getMonth()).toBe(1); // February, not March
    expect(next.getDate()).toBe(28);
  });

  it("rolls from a long month into a short one without skipping", () => {
    const twentyEighth = { ...first8, dayOfMonth: 28 };
    const next = nextRunAt(twentyEighth, at("2027-01-29T09:00:00"));
    expect(next.getMonth()).toBe(1);
    expect(next.getDate()).toBe(28);
  });
});

describe("guarding nonsense", () => {
  it("clamps an hour outside the day", () => {
    const spec = { cadence: "daily" as const, dayOfWeek: 1, dayOfMonth: 1, hour: 99 };
    expect(nextRunAt(spec, at("2026-09-08T01:00:00")).getHours()).toBe(23);
  });

  it("clamps a weekday and a day-of-month outside their range", () => {
    const bad = { cadence: "weekly" as const, dayOfWeek: 0, dayOfMonth: 99, hour: 8 };
    // Never throws, never returns an Invalid Date — a bad row must not stop
    // the sweep for everybody else.
    expect(Number.isFinite(nextRunAt(bad, at("2026-09-08T01:00:00")).getTime())).toBe(true);
    expect(
      Number.isFinite(
        nextRunAt({ ...bad, cadence: "monthly" }, at("2026-09-08T01:00:00")).getTime(),
      ),
    ).toBe(true);
  });
});

describe("saying it back to the person who set it", () => {
  it("describes each cadence in words", () => {
    expect(describeSchedule({ cadence: "daily", dayOfWeek: 1, dayOfMonth: 1, hour: 8 })).toBe(
      "Every day at 08:00",
    );
    expect(describeSchedule({ cadence: "weekly", dayOfWeek: 5, dayOfMonth: 1, hour: 17 })).toBe(
      "Every Friday at 17:00",
    );
    expect(describeSchedule({ cadence: "monthly", dayOfWeek: 1, dayOfMonth: 3, hour: 9 })).toBe(
      "The 3rd of every month at 09:00",
    );
  });

  it("has a label for every cadence", () => {
    for (const c of EXPORT_CADENCES) expect(CADENCE_LABEL[c]).toBeTruthy();
  });
});
