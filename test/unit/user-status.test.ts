import { describe, it, expect } from "vitest";
import { describeDevice, isLastLiveOwner, statusOf } from "../../src/modules/users/status";

/**
 * The panel used to render four independent chips — "no password", "must
 * change", "2FA off", "locked" — and leave the reader to add them up. They do
 * not add up to four things. They add up to one, and it is the only question
 * being asked: can this person get in right now, and if not, why not.
 */
const NOW = new Date("2026-09-08T12:00:00Z");

describe("what state an account is actually in", () => {
  const base = {
    suspendedAt: null,
    lockedUntil: null,
    hasPassword: true,
    lastLoginAt: new Date("2026-09-01"),
  };

  it("is active for somebody who can simply sign in", () => {
    expect(statusOf(base, NOW)).toBe("active");
  });

  it("calls a never-signed-in account invited, not broken", () => {
    // "No password" reads like a fault. It is a step somebody has not taken.
    expect(statusOf({ ...base, hasPassword: false, lastLoginAt: null }, NOW)).toBe("invited");
  });

  it("is active once they have signed in, even mid password reset", () => {
    // Somebody whose password was cleared but who HAS used the account before
    // is not a fresh invitation, and showing them as one would lose the
    // distinction the Owner cares about.
    expect(statusOf({ ...base, hasPassword: false }, NOW)).toBe("active");
  });

  it("is locked while the lockout is still running", () => {
    expect(statusOf({ ...base, lockedUntil: new Date("2026-09-08T13:00:00Z") }, NOW)).toBe("locked");
  });

  it("is not locked once the lockout has expired", () => {
    // A stale lockedUntil in the past must not show a red chip for ever.
    expect(statusOf({ ...base, lockedUntil: new Date("2026-09-08T11:00:00Z") }, NOW)).toBe("active");
  });

  it("reports suspended above everything else", () => {
    // A suspended account that is also locked is SUSPENDED. That is the fact an
    // Owner needs; unlocking it would change nothing.
    const suspended = { ...base, suspendedAt: new Date("2026-09-05") };
    expect(statusOf(suspended, NOW)).toBe("suspended");
    expect(statusOf({ ...suspended, lockedUntil: new Date("2026-09-08T13:00:00Z") }, NOW)).toBe(
      "suspended",
    );
    expect(statusOf({ ...suspended, hasPassword: false, lastLoginAt: null }, NOW)).toBe(
      "suspended",
    );
  });
});

describe("naming the device a session is on", () => {
  it("reads the common browsers and platforms", () => {
    expect(
      describeDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      ),
    ).toBe("Chrome on macOS");
    expect(
      describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1"),
    ).toBe("Safari on iOS");
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0) Firefox/121.0")).toBe("Firefox on Windows");
  });

  it("does not mistake Edge or Opera for Chrome", () => {
    // Both ship "Chrome/" in their user-agent, so order matters.
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/120 Edg/120")).toBe(
      "Edge on Windows",
    );
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/120 OPR/106")).toBe(
      "Opera on Windows",
    );
  });

  it("says something rather than nothing for an agent it cannot read", () => {
    expect(describeDevice(null)).toBe("Unknown device");
    expect(describeDevice("curl/8.4.0")).toBe("Browser");
  });
});


/**
 * A workspace with no Owner who can sign in cannot grant a role, provision
 * anything, or restore itself. Recovering one needs shell access to the
 * server — that is not a support process, it is an outage.
 *
 * The same predicate decides whether the button is rendered and whether the
 * mutation refuses, so the two cannot disagree about who the last Owner is.
 */
describe("protecting the last Owner", () => {
  const owner = { role: "OWNER", suspendedAt: null };

  it("protects the only live Owner", () => {
    expect(isLastLiveOwner(owner, 1)).toBe(true);
  });

  it("stops protecting once there are two", () => {
    expect(isLastLiveOwner(owner, 2)).toBe(false);
  });

  it("never protects a non-Owner", () => {
    expect(isLastLiveOwner({ role: "ADMIN", suspendedAt: null }, 1)).toBe(false);
    expect(isLastLiveOwner({ role: "BDR", suspendedAt: null }, 1)).toBe(false);
  });

  it("does not count an already-suspended Owner as the one holding the door", () => {
    // Otherwise a workspace whose only Owner is suspended would refuse to let
    // anybody restore or replace them — locked out by its own safety rail.
    expect(isLastLiveOwner({ role: "OWNER", suspendedAt: new Date() }, 1)).toBe(false);
  });

  it("treats zero live Owners as nothing left to protect", () => {
    expect(isLastLiveOwner({ role: "OWNER", suspendedAt: new Date() }, 0)).toBe(false);
  });
});
