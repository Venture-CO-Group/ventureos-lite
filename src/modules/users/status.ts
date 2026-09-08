/**
 * How an account's several flags add up to one state, and how a session's
 * user-agent reads as a device.
 *
 * Pure, and in their own module rather than beside the actions, for two
 * reasons. A `"use server"` file may only export async functions, so a sync
 * helper living there is a build error waiting for the next `next build`. And a
 * test that wants to check what "invited" means should not have to load
 * Auth.js to find out.
 */

/**
 * What state an account is actually in.
 *
 * The users panel used to render four independent chips — "no password", "must
 * change", "2FA off", "locked" — and leave the reader to work out what they
 * added up to. They do not add up to four things; they add up to ONE, and it is
 * the answer to the only question an Owner is asking: can this person get in
 * right now, and if not, why not.
 */
export type UserStatus = "active" | "invited" | "suspended" | "locked";

/** Chrome-on-macOS, from a user-agent string. Best effort, never throws. */
export function describeDevice(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  const os =
    /iPhone|iPad/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return os ? `${browser} on ${os}` : browser;
}

/** One state from the several flags that produce it. */
export function statusOf(u: {
  suspendedAt: Date | null;
  lockedUntil: Date | null;
  hasPassword: boolean;
  lastLoginAt: Date | null;
}, now: Date = new Date()): UserStatus {
  // Order matters: a suspended account that is also locked is suspended — that
  // is the fact an Owner needs, and unlocking it would change nothing.
  if (u.suspendedAt) return "suspended";
  if (u.lockedUntil && u.lockedUntil > now) return "locked";
  // No usable password and never signed in: invited, not broken. The old panel
  // showed this as "no password", which reads like a fault rather than a step
  // somebody has not taken yet.
  if (!u.hasPassword && !u.lastLoginAt) return "invited";
  return "active";
}

/** Members of the active workspace. Never the whole user table. */

/**
 * May this membership be demoted, suspended or removed?
 *
 * A workspace with no Owner who can sign in cannot grant a role, provision
 * anything, or restore itself. Recovering one needs shell access to the
 * server — that is not a support process, it is an outage.
 *
 * Pure, and used by BOTH the server actions and the panel, so the button that
 * is hidden and the mutation that refuses cannot disagree about who the last
 * Owner is.
 */
export function isLastLiveOwner(
  member: { role: string; suspendedAt: Date | string | null },
  liveOwnerCount: number,
): boolean {
  return member.role === "OWNER" && !member.suspendedAt && liveOwnerCount <= 1;
}
