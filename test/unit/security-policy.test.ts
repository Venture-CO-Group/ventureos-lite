import { describe, it, expect } from "vitest";
import {
  DEFAULT_SECURITY_POLICY,
  enrolmentRequired,
  pendingEnrolments,
  securityPolicyFrom,
} from "../../src/modules/workspaces/security-policy";

/**
 * TOTP was already built — enrolment, QR code, an Owner-triggered reset — and
 * was entirely optional per person. There was no way to say "in this workspace,
 * everybody", which for a system holding other people's client data is the
 * usual expectation.
 */
describe("reading the policy off the feature-flag bag", () => {
  it("defaults to off when there is nothing there", () => {
    expect(securityPolicyFrom(null)).toEqual(DEFAULT_SECURITY_POLICY);
    expect(securityPolicyFrom(undefined)).toEqual({ require2fa: false });
    expect(securityPolicyFrom({})).toEqual({ require2fa: false });
  });

  it("reads a real value", () => {
    expect(securityPolicyFrom({ security: { require2fa: true } })).toEqual({ require2fa: true });
  });

  it("shares the bag with the other flags without disturbing them", () => {
    // featureFlags also carries retention, the cold-email domain and hiddenNav.
    const flags = { hiddenNav: ["cold"], security: { require2fa: true }, retentionDays: 400 };
    expect(securityPolicyFrom(flags).require2fa).toBe(true);
  });

  it("treats anything that is not literally true as off", () => {
    // A hand-edited row must not turn the whole workspace's login into a maybe.
    expect(securityPolicyFrom({ security: { require2fa: "yes" } }).require2fa).toBe(false);
    expect(securityPolicyFrom({ security: { require2fa: 1 } }).require2fa).toBe(false);
    expect(securityPolicyFrom({ security: [] }).require2fa).toBe(false);
    expect(securityPolicyFrom({ security: "on" }).require2fa).toBe(false);
    expect(securityPolicyFrom([{ security: { require2fa: true } }]).require2fa).toBe(false);
  });
});

describe("who has to enrol, and why", () => {
  const off = { require2fa: false };
  const on = { require2fa: true };

  it("leaves an enrolled person alone under either policy", () => {
    const user = { totpEnabled: true, mustEnrollTotp: false };
    expect(enrolmentRequired(user, off)).toBeNull();
    expect(enrolmentRequired(user, on)).toBeNull();
  });

  it("asks an unenrolled person only when the workspace requires it", () => {
    const user = { totpEnabled: false, mustEnrollTotp: false };
    expect(enrolmentRequired(user, off)).toBeNull();
    expect(enrolmentRequired(user, on)).toBe("workspace_policy");
  });

  it("reports the personal reset first, because it is the more specific fact", () => {
    // An Owner reset THIS person's authenticator. True even where no policy is
    // set, and it calls for different words on the enrolment screen.
    expect(enrolmentRequired({ totpEnabled: false, mustEnrollTotp: true }, off)).toBe(
      "reset_by_owner",
    );
    expect(enrolmentRequired({ totpEnabled: false, mustEnrollTotp: true }, on)).toBe(
      "reset_by_owner",
    );
  });

  it("still asks somebody whose reset flag is set even though a secret survives", () => {
    // The reset clears totpEnabled in practice; if a row ever disagrees, the
    // explicit reset wins rather than being silently ignored.
    expect(enrolmentRequired({ totpEnabled: true, mustEnrollTotp: true }, off)).toBe(
      "reset_by_owner",
    );
  });
});

describe("counting who is about to be asked", () => {
  it("counts the unenrolled", () => {
    expect(
      pendingEnrolments([
        { totpEnabled: true },
        { totpEnabled: false },
        { totpEnabled: false },
      ]),
    ).toBe(2);
  });

  it("is zero for an empty or fully enrolled team", () => {
    expect(pendingEnrolments([])).toBe(0);
    expect(pendingEnrolments([{ totpEnabled: true }])).toBe(0);
  });
});
