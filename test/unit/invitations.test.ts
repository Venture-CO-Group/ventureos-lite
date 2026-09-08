import { describe, it, expect } from "vitest";
import {
  INVITE_TTL_DAYS,
  MAX_BULK_INVITES,
  MAX_RESENDS,
  RESEND_COOLDOWN_MS,
  acceptVerdict,
  canResend,
  invitationState,
  inviteExpiry,
  isLive,
  nameFromEmail,
  parseBulkInvites,
} from "../../src/modules/members/invitation-logic";

/**
 * Invitations (§2).
 *
 * Almost every requirement here is a rule about a STATE rather than a query,
 * and the two that matter most are about what a refusal is allowed to say.
 */
const NOW = new Date("2026-09-10T12:00:00Z");
const row = (o: Partial<Parameters<typeof invitationState>[0]> = {}) => ({
  acceptedAt: null,
  revokedAt: null,
  expiresAt: new Date("2026-09-15T12:00:00Z"),
  ...o,
});

describe("how long an invitation lives", () => {
  it("is seven days out", () => {
    expect(INVITE_TTL_DAYS).toBe(7);
    expect(inviteExpiry(NOW).toISOString()).toBe("2026-09-17T12:00:00.000Z");
  });
});

describe("which state an invitation is in", () => {
  it("is pending inside its window", () => {
    expect(invitationState(row(), NOW)).toBe("pending");
    expect(isLive(row(), NOW)).toBe(true);
  });

  it("is expired once the window closes", () => {
    expect(invitationState(row({ expiresAt: new Date("2026-09-09T12:00:00Z") }), NOW)).toBe(
      "expired",
    );
  });

  it("expires exactly at the boundary, not a moment after", () => {
    // A link that works "just this once" past its expiry is a link with no
    // expiry, as far as anybody holding one is concerned.
    expect(invitationState(row({ expiresAt: NOW }), NOW)).toBe("expired");
    expect(
      invitationState(row({ expiresAt: new Date(NOW.getTime() + 1) }), NOW),
    ).toBe("pending");
  });

  it("counts accepted above everything", () => {
    // An accepted invitation whose window has since passed is still accepted.
    expect(
      invitationState(
        row({ acceptedAt: new Date("2026-09-11T00:00:00Z"), expiresAt: new Date("2026-09-01T00:00:00Z") }),
        NOW,
      ),
    ).toBe("accepted");
    // And above revoked, if a race ever produced both.
    expect(
      invitationState(row({ acceptedAt: NOW, revokedAt: NOW }), NOW),
    ).toBe("accepted");
  });

  it("counts revoked above expired", () => {
    /**
     * "We withdrew it" is the more specific truth, and the one an Owner needs
     * to see on the members screen. Reporting it as merely expired would
     * suggest a resend is the fix.
     */
    expect(
      invitationState(
        row({ revokedAt: new Date("2026-09-05T00:00:00Z"), expiresAt: new Date("2026-09-08T00:00:00Z") }),
        NOW,
      ),
    ).toBe("revoked");
  });
});

describe("what the public accept page may say", () => {
  it("lets a live invitation through", () => {
    expect(acceptVerdict(row(), NOW)).toEqual({ ok: true });
  });

  it("gives a REVOKED link exactly the same answer as one nobody issued", () => {
    /**
     * The one place information leaks, and the reason this function exists.
     *
     * If a revoked link said "this invitation was withdrawn", whoever holds it
     * learns two things they should not: that the address is a real account
     * here, and that somebody decided against them.
     */
    const revoked = acceptVerdict(row({ revokedAt: new Date("2026-09-09T00:00:00Z") }), NOW);
    const unknown = acceptVerdict(null, NOW);
    expect(revoked).toEqual(unknown);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) {
      expect(revoked.reason).toBe("invalid");
      expect(revoked.canResend).toBe(false);
      // And it must not hint at revocation in the words either.
      expect(revoked.message).not.toMatch(/revok|withdraw|cancel/i);
    }
  });

  it("tells an expired link the truth, and offers a resend", () => {
    // A real person who clicked a real link a day late. A generic refusal
    // sends them to support instead of to the button that fixes it.
    const v = acceptVerdict(row({ expiresAt: new Date("2026-09-01T00:00:00Z") }), NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("expired");
      expect(v.canResend).toBe(true);
      expect(v.message).toContain(String(INVITE_TTL_DAYS));
    }
  });

  it("does not silently extend an expired link", () => {
    // Asserted as a property of the verdict: expiry is never `ok: true`.
    for (const days of [1, 8, 400]) {
      const past = new Date(NOW.getTime() - days * 86_400_000);
      expect(acceptVerdict(row({ expiresAt: past }), NOW).ok).toBe(false);
    }
  });

  it("sends somebody who already accepted to the sign-in page", () => {
    const v = acceptVerdict(row({ acceptedAt: new Date("2026-09-09T00:00:00Z") }), NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("accepted");
      expect(v.message).toMatch(/sign in/i);
    }
  });
});

describe("resending", () => {
  const base = { ...row(), resendCount: 0, lastSentAt: new Date("2026-09-10T11:00:00Z") };

  it("allows a resend after the cooldown", () => {
    expect(canResend(base, NOW)).toEqual({ ok: true });
  });

  it("refuses one inside the cooldown, and says how long to wait", () => {
    // Four mails in a minute is how a sending domain earns a complaint.
    const justSent = { ...base, lastSentAt: new Date(NOW.getTime() - 60_000) };
    const v = canResend(justSent, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/9 minute/);
    expect(RESEND_COOLDOWN_MS).toBe(600_000);
  });

  it("stops at the resend limit and says why a sixth will not help", () => {
    const v = canResend({ ...base, resendCount: MAX_RESENDS }, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/Check the address/);
  });

  it("refuses to resend an accepted or a revoked one", () => {
    expect(canResend({ ...base, acceptedAt: NOW }, NOW).ok).toBe(false);
    const revoked = canResend({ ...base, revokedAt: NOW }, NOW);
    expect(revoked.ok).toBe(false);
    // An Owner may be told the truth here — they are the one who revoked it.
    if (!revoked.ok) expect(revoked.error).toMatch(/revoked/i);
  });

  it("allows resending an EXPIRED one, which is the whole point", () => {
    // The accept page offers it; refusing here would make that button a lie.
    expect(canResend({ ...base, expiresAt: new Date("2026-09-01T00:00:00Z") }, NOW).ok).toBe(true);
  });
});

describe("pasting a list of addresses", () => {
  it("takes a spreadsheet column", () => {
    const rows = parseBulkInvites("anna@example.hu\nbela@example.hu\n\ncecil@example.hu");
    expect(rows.map((r) => r.email)).toEqual([
      "anna@example.hu",
      "bela@example.hu",
      "cecil@example.hu",
    ]);
    expect(rows.every((r) => r.problem === null)).toBe(true);
  });

  it("takes every separator a paste can carry", () => {
    const rows = parseBulkInvites("a@x.hu, b@x.hu; c@x.hu\td@x.hu");
    expect(rows.filter((r) => !r.problem)).toHaveLength(4);
  });

  it("unwraps what a mail client copies", () => {
    const rows = parseBulkInvites("Anna Kovács <anna@example.hu>");
    expect(rows[0]!.email).toBe("anna@example.hu");
    expect(rows[0]!.problem).toBeNull();
  });

  it("lower-cases, so two spellings are one address", () => {
    const rows = parseBulkInvites("Anna@Example.HU\nanna@example.hu");
    expect(rows[0]!.email).toBe("anna@example.hu");
    expect(rows[1]!.problem).toBe("Listed twice.");
  });

  it("reports a bad row without losing the good ones", () => {
    /**
     * Refusing the whole paste means somebody hunts for the bad line by
     * bisection; accepting it silently means three people never get invited
     * and nobody knows which three.
     */
    const rows = parseBulkInvites("anna@example.hu\nBéla Kovács\ncecil@example.hu");
    expect(rows).toHaveLength(3);
    expect(rows[1]!.problem).toBe("Not an email address.");
    expect(rows.filter((r) => !r.problem).map((r) => r.email)).toEqual([
      "anna@example.hu",
      "cecil@example.hu",
    ]);
  });

  it("keeps the raw line, so a report can point at what was pasted", () => {
    const rows = parseBulkInvites("  Béla Kovács  ");
    expect(rows[0]!.raw).toBe("Béla Kovács");
  });

  it("stops at the limit rather than accepting five hundred", () => {
    const many = Array.from({ length: 60 }, (_, i) => `p${i}@example.hu`).join("\n");
    const rows = parseBulkInvites(many);
    expect(rows.filter((r) => !r.problem)).toHaveLength(MAX_BULK_INVITES);
    expect(rows.filter((r) => r.problem?.includes("limit"))).toHaveLength(10);
  });

  it("returns nothing for nothing", () => {
    expect(parseBulkInvites("")).toEqual([]);
    expect(parseBulkInvites("   \n \n ")).toEqual([]);
  });
});

describe("a name from an address", () => {
  it("makes something readable out of the local part", () => {
    // Better than an empty name field on a members list.
    expect(nameFromEmail("anna.kovacs@example.hu")).toBe("Anna Kovacs");
    expect(nameFromEmail("bela_szabo@example.hu")).toBe("Bela Szabo");
    expect(nameFromEmail("info@example.hu")).toBe("Info");
  });

  it("falls back to the address rather than an empty string", () => {
    expect(nameFromEmail("@example.hu")).toBe("@example.hu");
  });
});
