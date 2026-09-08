/**
 * Invitations, decided without a database (§2).
 *
 * ── WHY SO MUCH OF THIS IS PURE ─────────────────────────────────────────────
 *
 * Almost every requirement in the invitation section is a rule about a STATE
 * rather than a query: how long a link lives, what an expired one may offer,
 * what a revoked one may say, how often it can be resent, and which of a
 * pasted list of fifty addresses is usable. Every one of those is a place to
 * be subtly wrong, and none of them needs Postgres to be tested.
 *
 * The two that matter most are the ones about leaking. An expired link should
 * say so and offer a resend, because that is a real person who clicked a real
 * link too late. A REVOKED link must say nothing at all beyond "not valid" —
 * "this invitation was withdrawn" tells whoever holds it that the address is
 * real and that somebody changed their mind about them.
 */

/** Seven days. Long enough for a holiday, short enough to be a credential. */
export const INVITE_TTL_DAYS = 7;

/** How many times one invitation may be sent again before somebody talks. */
export const MAX_RESENDS = 5;

/** No more than one resend every ten minutes to the same address. */
export const RESEND_COOLDOWN_MS = 10 * 60_000;

/** A pasted list is bounded: fifty is a team, five hundred is a mistake. */
export const MAX_BULK_INVITES = 50;

export function inviteExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 86_400_000);
}

export type InvitationState = "pending" | "accepted" | "revoked" | "expired";

export interface InvitationRowState {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}

/**
 * Which state one invitation is in.
 *
 * Order matters and is not arbitrary. Accepted wins over everything, because
 * an accepted invitation whose window has since passed is still accepted.
 * Revoked beats expired, because "we withdrew it" is the more specific truth
 * and the one an Owner needs to see on the members screen.
 */
export function invitationState(
  row: InvitationRowState,
  now: Date = new Date(),
): InvitationState {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

export function isLive(row: InvitationRowState, now: Date = new Date()): boolean {
  return invitationState(row, now) === "pending";
}

/**
 * What the public accept page is allowed to say (§2).
 *
 * ── THE ONE PLACE INFORMATION LEAKS ─────────────────────────────────────────
 *
 * A token that does not resolve, and a token that was deliberately revoked,
 * must be indistinguishable. If a revoked link said "this invitation was
 * withdrawn", anybody holding one would learn two things they should not: that
 * the address is a real account here, and that somebody decided against them.
 * A token nobody ever issued says the same sentence.
 *
 * Expired is different and is told the truth, because that is a real person
 * who clicked a real link a day late, and a generic refusal would send them to
 * support instead of to the resend button.
 */
export type AcceptVerdict =
  | { ok: true }
  | { ok: false; reason: "expired"; canResend: true; message: string }
  | { ok: false; reason: "invalid"; canResend: false; message: string }
  | { ok: false; reason: "accepted"; canResend: false; message: string };

const GENERIC = "This invitation link is not valid.";

export function acceptVerdict(
  row: InvitationRowState | null,
  now: Date = new Date(),
): AcceptVerdict {
  // No row and a revoked row give the SAME answer. That is the whole rule.
  if (!row) return { ok: false, reason: "invalid", canResend: false, message: GENERIC };
  const state = invitationState(row, now);
  if (state === "pending") return { ok: true };
  if (state === "accepted") {
    return {
      ok: false,
      reason: "accepted",
      canResend: false,
      // Safe to say: whoever holds the link already used it, so they know.
      message: "This invitation has already been used. Sign in instead.",
    };
  }
  if (state === "expired") {
    return {
      ok: false,
      reason: "expired",
      canResend: true,
      message: `This invitation expired. Invitations last ${INVITE_TTL_DAYS} days — ask for a new one.`,
    };
  }
  return { ok: false, reason: "invalid", canResend: false, message: GENERIC };
}

/**
 * May this invitation be sent again, right now?
 *
 * Two limits, for two different problems. The cooldown stops an impatient
 * Owner mailing somebody four times in a minute — which is how a sending
 * domain earns a spam complaint. The count is a conversation: five
 * invitations to one address that nobody has accepted is not a delivery
 * problem, and a sixth will not fix it.
 */
export type ResendVerdict = { ok: true } | { ok: false; error: string };

export function canResend(
  row: { resendCount: number; lastSentAt: Date } & InvitationRowState,
  now: Date = new Date(),
): ResendVerdict {
  const state = invitationState(row, now);
  if (state === "accepted") return { ok: false, error: "They have already accepted." };
  if (state === "revoked") {
    return { ok: false, error: "This invitation was revoked. Invite them again instead." };
  }
  if (row.resendCount >= MAX_RESENDS) {
    return {
      ok: false,
      error: `Sent ${row.resendCount} times already. Check the address with them rather than sending a ${
        row.resendCount + 1
      }th.`,
    };
  }
  const since = now.getTime() - row.lastSentAt.getTime();
  if (since < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - since) / 60_000);
    return { ok: false, error: `Sent a moment ago. Try again in ${wait} minute(s).` };
  }
  return { ok: true };
}

/**
 * Turn pasted text into addresses, and say what is wrong with each line (§2).
 *
 * ── WHY PER-ROW AND NOT ALL-OR-NOTHING ──────────────────────────────────────
 *
 * Somebody pastes a column out of a spreadsheet. One row has a trailing
 * semicolon, one is a name rather than an address, one is already a member.
 * Refusing the whole paste means they hunt for the bad line by bisection;
 * accepting it silently means three people never get invited and nobody knows
 * which three. So every row comes back with its own verdict and the caller
 * sends the good ones.
 */
export interface BulkRow {
  raw: string;
  email: string | null;
  problem: string | null;
}

/** Deliberately simple. The address is verified by an email arriving at it. */
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

export function parseBulkInvites(text: string): BulkRow[] {
  const seen = new Set<string>();
  const rows: BulkRow[] = [];
  // Split on every separator a paste can carry: newlines, commas, semicolons
  // and tabs. A spreadsheet column arrives with at least two of those.
  for (const raw of text.split(/[\n\r,;\t]+/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (rows.length >= MAX_BULK_INVITES) {
      rows.push({
        raw: trimmed,
        email: null,
        problem: `Over the limit of ${MAX_BULK_INVITES} per paste.`,
      });
      continue;
    }
    // "Anna Kovács <anna@example.hu>" is what a mail client copies.
    const angled = trimmed.match(/<([^>]+)>/);
    const candidate = (angled ? angled[1]! : trimmed).trim().toLowerCase();

    if (!EMAIL_RE.test(candidate)) {
      rows.push({ raw: trimmed, email: null, problem: "Not an email address." });
      continue;
    }
    if (seen.has(candidate)) {
      rows.push({ raw: trimmed, email: candidate, problem: "Listed twice." });
      continue;
    }
    seen.add(candidate);
    rows.push({ raw: trimmed, email: candidate, problem: null });
  }
  return rows;
}

/** A display name from an address, for an invitation with no name given. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return (
    local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") || email
  );
}
