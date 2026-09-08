import { prismaUnsafe } from "../db";
import { hashPassword, needsRehash, verifyPassword } from "./password";
import { evaluateThrottle, lockAfterFailure, retryAfterLabel, ACCOUNT_WINDOW_MS, IP_WINDOW_MS } from "./throttle";
import { verifyTotp } from "./totp";
import { createSession } from "./sessions";

/**
 * The one place a password is ever checked.
 *
 * Order matters and is deliberate:
 *   1. throttle  — before any expensive work, so brute force costs the attacker
 *                  a round trip and us nothing.
 *   2. password  — bcrypt.
 *   3. TOTP      — only when enrolled, and replay-checked.
 *   4. session   — created only after every factor passes.
 *
 * The failure surface is deliberately flat: bad email, bad password and bad
 * code all return the same "Incorrect email, password or code" so the form
 * cannot be used to enumerate accounts or to discover whether 2FA is on. The
 * one exception is `totp_required`, which the UI genuinely needs in order to
 * show the code field — and which is only reachable AFTER the password checks
 * out, so it reveals nothing to someone without valid credentials.
 */
export type LoginOutcome =
  | { ok: true; token: string; userId: string; workspaceId: string | null; mustChangePassword: boolean }
  | { ok: false; code: "totp_required" }
  | { ok: false; code: "invalid"; message: string }
  | { ok: false; code: "throttled"; message: string }
  | { ok: false; code: "no_workspace"; message: string };

const GENERIC = "Incorrect email, password or code.";

export interface LoginInput {
  email: string;
  password: string;
  totpCode?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  nowMs?: number;
}

export async function attemptLogin(input: LoginInput): Promise<LoginOutcome> {
  const nowMs = input.nowMs ?? Date.now();
  const email = input.email.trim().toLowerCase();
  const ip = input.ip ?? null;

  const user = await prismaUnsafe.user.findUnique({
    where: { email },
    select: {
      id: true,
      passwordHash: true,
      totpSecret: true,
      totpEnabled: true,
      totpLastStep: true,
      lockedUntil: true,
      lockCount: true,
      mustChangePassword: true,
    },
  });

  const since = new Date(nowMs - Math.max(ACCOUNT_WINDOW_MS, IP_WINDOW_MS));
  const [accountAttempts, ipAttempts] = await Promise.all([
    prismaUnsafe.loginAttempt.findMany({
      where: { email, createdAt: { gte: since } },
      select: { ok: true, createdAt: true },
    }),
    ip
      ? prismaUnsafe.loginAttempt.findMany({
          where: { ip, createdAt: { gte: since } },
          select: { ok: true, createdAt: true },
        })
      : Promise.resolve([]),
  ]);

  const verdict = evaluateThrottle({
    nowMs,
    lockedUntil: user?.lockedUntil ?? null,
    accountAttempts,
    ipAttempts,
  });
  if (!verdict.allowed) {
    await record(email, ip, false, nowMs);
    return {
      ok: false,
      code: "throttled",
      message: `Too many attempts. Try again ${retryAfterLabel(verdict.retryAfterMs)}.`,
    };
  }

  // Always run a bcrypt comparison, even for an unknown email, so response time
  // does not reveal whether the account exists.
  const hash = user?.passwordHash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
  const passwordOk = await verifyPassword(input.password, hash);

  if (!user || !passwordOk) {
    await fail(email, ip, nowMs, accountAttempts, user?.id ?? null, user?.lockCount ?? 0);
    return { ok: false, code: "invalid", message: GENERIC };
  }

  // ---- second factor -------------------------------------------------------
  let consumedStep: number | null = null;
  if (user.totpEnabled) {
    if (!user.totpSecret) {
      // Enrolled flag without a secret is a broken account, not a valid login.
      await fail(email, ip, nowMs, accountAttempts, user.id, user.lockCount);
      return { ok: false, code: "invalid", message: GENERIC };
    }
    if (!input.totpCode) {
      // Not a failed attempt — the password was right; the form needs a second
      // step. Recording this as a failure would lock out honest two-step logins.
      return { ok: false, code: "totp_required" };
    }
    const result = verifyTotp(input.totpCode, user.totpSecret, nowMs, user.totpLastStep ?? null);
    if (!result.ok) {
      await fail(email, ip, nowMs, accountAttempts, user.id, user.lockCount);
      return { ok: false, code: "invalid", message: GENERIC };
    }
    consumedStep = result.step;
  }

  // ---- success -------------------------------------------------------------
  // A suspended membership is not one you can sign into. Somebody stood down
  // everywhere is refused here rather than admitted to a session that
  // `tryGetActiveContext` would then refuse to resolve — which would have
  // looked, from the login form, like a successful sign-in that bounced.
  const membership = await prismaUnsafe.membership.findFirst({
    where: { userId: user.id, suspendedAt: null },
    orderBy: { createdAt: "asc" },
    select: { workspaceId: true },
  });
  if (!membership) {
    return {
      ok: false,
      code: "no_workspace",
      message: "Your account has no active workspace. Ask an Owner to add you to one.",
    };
  }

  const session = await createSession({
    userId: user.id,
    workspaceId: membership.workspaceId,
    ip,
    userAgent: input.userAgent,
    nowMs,
  });

  await prismaUnsafe.user.update({
    where: { id: user.id },
    data: {
      lockedUntil: null,
      // The run of failures is over; the next lock starts from the first step.
      lockCount: 0,
      lastLoginAt: new Date(nowMs),
      ...(consumedStep !== null ? { totpLastStep: consumedStep } : {}),
      // Opportunistically upgrade a hash made with an older cost factor.
      ...(needsRehash(user.passwordHash)
        ? { passwordHash: await hashPassword(input.password) }
        : {}),
    },
  });
  await record(email, ip, true, nowMs);

  // A sign-in on a device you did not use is the single most useful security
  // signal there is, so it goes out the moment it happens (P6/2).
  await onNewLogin?.({
    userId: user.id,
    workspaceId: membership.workspaceId,
    ip,
    userAgent: input.userAgent ?? null,
    at: new Date(nowMs),
  }).catch(() => {
    /* a notification must never be the reason a login fails */
  });

  return {
    ok: true,
    token: session.token,
    userId: user.id,
    workspaceId: membership.workspaceId,
    mustChangePassword: user.mustChangePassword,
  };
}

async function record(email: string, ip: string | null, ok: boolean, nowMs: number): Promise<void> {
  await prismaUnsafe.loginAttempt
    .create({ data: { email, ip, ok, createdAt: new Date(nowMs) } })
    .catch(() => {
      /* the ledger is best-effort; never block a login on it */
    });
}

async function fail(
  email: string,
  ip: string | null,
  nowMs: number,
  accountAttempts: Array<{ ok: boolean; createdAt: Date }>,
  userId: string | null,
  priorLocks = 0,
): Promise<void> {
  await record(email, ip, false, nowMs);
  const lock = lockAfterFailure(accountAttempts, nowMs, priorLocks);
  if (lock && userId) {
    await prismaUnsafe.user
      .update({
        where: { id: userId },
        data: { lockedUntil: lock, lockCount: { increment: 1 } },
      })
      .catch(() => {});
    // A lockout is a security event, and CLAUDE.md hard rule #8 wants those on
    // the record. Best-effort and workspace-scoped: a login failure has no
    // workspace of its own, so the entry goes to the account's first one.
    await onLockout?.({ userId, email, ip, until: lock }).catch(() => {});
  }
}

/**
 * Side-effect hooks, injected rather than imported.
 *
 * `login.ts` is the authentication core and is exercised directly by tests with
 * no request context. Importing the notification and audit modules here would
 * drag Redis, the workspace client and `next/cache` into that path; a hook the
 * server action installs keeps the core dependency-free and keeps the test
 * honest about what it is testing.
 */
export interface NewLoginEvent {
  userId: string;
  workspaceId: string;
  ip: string | null;
  userAgent: string | null;
  at: Date;
}
export interface LockoutEvent {
  userId: string;
  email: string;
  ip: string | null;
  until: Date;
}

let onNewLogin: ((e: NewLoginEvent) => Promise<void>) | null = null;
let onLockout: ((e: LockoutEvent) => Promise<void>) | null = null;

export function setAuthEventHooks(hooks: {
  onNewLogin?: (e: NewLoginEvent) => Promise<void>;
  onLockout?: (e: LockoutEvent) => Promise<void>;
}): void {
  if (hooks.onNewLogin) onNewLogin = hooks.onNewLogin;
  if (hooks.onLockout) onLockout = hooks.onLockout;
}

/** Retention sweep for the attempt ledger — it holds emails and IPs. */
export async function pruneLoginAttempts(nowMs = Date.now()): Promise<number> {
  const { count } = await prismaUnsafe.loginAttempt.deleteMany({
    where: { createdAt: { lt: new Date(nowMs - 30 * 86_400_000) } },
  });
  return count;
}
