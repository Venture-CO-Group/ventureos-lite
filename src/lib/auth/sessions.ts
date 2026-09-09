import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prismaUnsafe } from "../db";
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_IDLE_REFRESH_MS,
  SESSION_TTL_MS,
} from "./session-policy";

/**
 * Server-side session store (CLAUDE.md → Auth: "server sessions in DB").
 *
 * Auth.js carries an opaque token in a signed cookie; this module owns what
 * that token MEANS. The database row is authoritative, so:
 *   - an Owner can revoke a session and the next request is logged out,
 *   - the active workspace lives server-side and cannot be tampered with,
 *   - only a SHA-256 hash is stored, so a dump of `sessions` yields nothing
 *     usable.
 *
 * `sessions` is a global auth table, not tenant data — `prismaUnsafe` is
 * correct here and carries no workspace scope by design.
 */
/**
 * Session lifetime lives in `session-policy.ts` — inert numbers a client
 * component can read without dragging Prisma into the browser bundle. Re-
 * exported here because this is the name the rest of the code imports.
 */
export {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_TTL_MS,
  SESSION_IDLE_REFRESH_MS,
} from "./session-policy";

export interface SessionUser {
  sessionId: string;
  userId: string;
  workspaceId: string | null;
}

/** Hash used for storage and lookup. Tokens are high-entropy, so a plain
 *  SHA-256 is right — no salt/stretching needed, and lookup stays indexable. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Create a session row and return the raw token (shown to the client once). */
export async function createSession(input: {
  userId: string;
  workspaceId: string | null;
  ip?: string | null;
  userAgent?: string | null;
  nowMs?: number;
}): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const now = input.nowMs ?? Date.now();
  const token = generateSessionToken();
  const expiresAt = new Date(now + SESSION_TTL_MS);
  const row = await prismaUnsafe.session.create({
    data: {
      userId: input.userId,
      token: hashToken(token),
      workspaceId: input.workspaceId,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 500) ?? null,
      expiresAt,
    },
    select: { id: true },
  });
  return { token, sessionId: row.id, expiresAt };
}

/**
 * Resolve a raw token to a live session, or null.
 *
 * Rejects expired and revoked rows. Refreshes `lastSeenAt` at most every
 * SESSION_IDLE_REFRESH_MS so an active session does not write on every request.
 */
export async function resolveSession(
  token: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await prismaUnsafe.session.findUnique({
    where: { token: hashToken(token) },
    select: {
      id: true,
      userId: true,
      workspaceId: true,
      expiresAt: true,
      revokedAt: true,
      lastSeenAt: true,
      token: true,
    },
  });
  if (!row) return null;
  // Belt and braces against a hypothetical index/collision oddity.
  if (!constantTimeEquals(row.token, hashToken(token))) return null;
  if (row.revokedAt) return null;
  // Absolute limb.
  if (row.expiresAt.getTime() <= nowMs) return null;
  // Idle limb. Checked here rather than by a sweep so a dormant session is dead
  // the moment it is used, not the next time a cron happens to run.
  if (nowMs - row.lastSeenAt.getTime() > SESSION_IDLE_TTL_MS) return null;

  if (nowMs - row.lastSeenAt.getTime() > SESSION_IDLE_REFRESH_MS) {
    await prismaUnsafe.session
      .update({ where: { id: row.id }, data: { lastSeenAt: new Date(nowMs) } })
      .catch(() => {
        /* liveness bookkeeping only — never fail a request over it */
      });
  }
  return { sessionId: row.id, userId: row.userId, workspaceId: row.workspaceId };
}

/** Persist the active workspace on the session (server-side, untamperable). */
export async function setSessionWorkspace(
  sessionId: string,
  workspaceId: string,
): Promise<void> {
  await prismaUnsafe.session.update({
    where: { id: sessionId },
    data: { workspaceId },
  });
}

export async function revokeSession(sessionId: string, nowMs = Date.now()): Promise<void> {
  await prismaUnsafe.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(nowMs) },
  });
}

/** Revoke every session for a user — password change, 2FA change, or lockout. */
export async function revokeAllUserSessions(
  userId: string,
  opts: { exceptSessionId?: string; nowMs?: number } = {},
): Promise<number> {
  const { count } = await prismaUnsafe.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(opts.exceptSessionId ? { id: { not: opts.exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date(opts.nowMs ?? Date.now()) },
  });
  return count;
}

/** Housekeeping: drop rows that can never authenticate again. */
export async function pruneExpiredSessions(nowMs = Date.now()): Promise<number> {
  const cutoff = new Date(nowMs - 7 * 86_400_000);
  const { count } = await prismaUnsafe.session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date(nowMs) } },
        { revokedAt: { lt: cutoff } },
        // Idle-expired sessions can never resolve again either (see
        // resolveSession), so there is no reason to keep the row.
        { lastSeenAt: { lt: new Date(nowMs - SESSION_IDLE_TTL_MS) } },
      ],
    },
  });
  return count;
}

/**
 * A human label for a session row.
 *
 * Deliberately coarse. The point of the list is "is one of these not me?", and
 * a full user-agent string answers that worse than "Chrome on macOS" does —
 * nobody reads 180 characters of version numbers looking for an intruder.
 */
export function describeDevice(userAgent: string | null): string {
  const ua = userAgent ?? "";
  if (!ua) return "Unknown device";

  const browser =
    /\bEdg\//.test(ua) ? "Edge"
    : /\bOPR\//.test(ua) ? "Opera"
    : /Chrome\//.test(ua) && !/Chromium/.test(ua) ? "Chrome"
    : /Chromium\//.test(ua) ? "Chromium"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";

  const os =
    /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : null;

  return os ? `${browser} on ${os}` : browser;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
