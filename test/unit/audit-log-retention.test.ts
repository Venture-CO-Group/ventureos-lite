import { describe, it, expect } from "vitest";
import {
  DEFAULT_AUDIT_RETENTION_DAYS,
  MAX_AUDIT_RETENTION_DAYS,
  MIN_AUDIT_RETENTION_DAYS,
  auditRetentionCutoff,
  auditRetentionDaysFrom,
  describeAuditRetention,
} from "../../src/modules/auditlog/retention";

/**
 * Hard rule #8 is honoured in fifty-one places, and until now nothing ever
 * removed a row. Two problems in one: GDPR asks for a defined retention period
 * rather than "indefinitely", and a table that only grows is a table that
 * eventually cannot be read.
 */
describe("reading the retention period off the feature-flag bag", () => {
  it("keeps everything when nothing is set", () => {
    // Deliberately not a number by default: silently deleting somebody's audit
    // history because a default said so is the exact surprise a log prevents.
    expect(auditRetentionDaysFrom(null)).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(auditRetentionDaysFrom({})).toBe(0);
    expect(auditRetentionDaysFrom({ auditLogRetentionDays: 0 })).toBe(0);
  });

  it("reads a real value", () => {
    expect(auditRetentionDaysFrom({ auditLogRetentionDays: 365 })).toBe(365);
  });

  it("shares the bag with the other flags", () => {
    const flags = {
      hiddenNav: ["cold"],
      security: { require2fa: true },
      auditLogRetentionDays: 730,
    };
    expect(auditRetentionDaysFrom(flags)).toBe(730);
  });

  it("clamps a hand-edited value instead of obeying it", () => {
    // A stored 1 must not shred a workspace's history overnight.
    expect(auditRetentionDaysFrom({ auditLogRetentionDays: 1 })).toBe(MIN_AUDIT_RETENTION_DAYS);
    expect(auditRetentionDaysFrom({ auditLogRetentionDays: 89 })).toBe(MIN_AUDIT_RETENTION_DAYS);
    expect(auditRetentionDaysFrom({ auditLogRetentionDays: 99_999 })).toBe(
      MAX_AUDIT_RETENTION_DAYS,
    );
  });

  it("treats a negative period as keep-for-ever, not as a cut-off in the future", () => {
    // Otherwise the cut-off lands ahead of now and the sweep deletes the lot.
    expect(auditRetentionDaysFrom({ auditLogRetentionDays: -30 })).toBe(0);
  });

  it("ignores anything that is not a finite number", () => {
    expect(auditRetentionDaysFrom({ auditLogRetentionDays: "365" })).toBe(0);
    expect(auditRetentionDaysFrom({ auditLogRetentionDays: NaN })).toBe(0);
    expect(auditRetentionDaysFrom({ auditLogRetentionDays: Infinity })).toBe(0);
    expect(auditRetentionDaysFrom({ auditLogRetentionDays: null })).toBe(0);
    expect(auditRetentionDaysFrom([{ auditLogRetentionDays: 365 }])).toBe(0);
  });

  it("rounds a fractional period", () => {
    expect(auditRetentionDaysFrom({ auditLogRetentionDays: 365.4 })).toBe(365);
  });
});

describe("the cut-off the sweep deletes below", () => {
  const now = new Date("2026-09-08T03:40:00.000Z");

  it("is null for keep-for-ever, so the caller cannot run a delete by accident", () => {
    expect(auditRetentionCutoff(0, now)).toBeNull();
    expect(auditRetentionCutoff(-1, now)).toBeNull();
  });

  it("sits exactly the period back", () => {
    expect(auditRetentionCutoff(90, now)!.toISOString()).toBe("2026-06-10T03:40:00.000Z");
    expect(auditRetentionCutoff(365, now)!.toISOString()).toBe("2025-09-08T03:40:00.000Z");
  });

  it("never lands in the future", () => {
    for (const days of [90, 180, 365, 3650]) {
      expect(auditRetentionCutoff(days, now)!.getTime()).toBeLessThan(now.getTime());
    }
  });
});

describe("saying the period back in words", () => {
  it("names the years where they are whole", () => {
    expect(describeAuditRetention(365)).toBe("Kept for 1 year");
    expect(describeAuditRetention(730)).toBe("Kept for 2 years");
  });

  it("falls back to days", () => {
    expect(describeAuditRetention(90)).toBe("Kept for 90 days");
  });

  it("says so when nothing is ever removed", () => {
    expect(describeAuditRetention(0)).toBe("Kept indefinitely");
  });
});
