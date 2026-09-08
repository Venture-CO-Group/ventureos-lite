"use server";

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireOwner } from "@/lib/authz";
import { hashPassword, validatePassword, NO_PASSWORD } from "@/lib/auth/password";
import { revokeAllUserSessions } from "@/lib/auth/sessions";
import { appLink } from "@/lib/public-links";
import { describeDevice, isLastLiveOwner, statusOf, type UserStatus } from "./status";

/**
 * Owner-side user administration (Settings → Users).
 *
 * Every mutation here:
 *   - is Owner-only, checked server-side on entry (CLAUDE.md hard rule #7);
 *   - only ever touches a user who is a MEMBER OF THE ACTIVE WORKSPACE, so an
 *     Owner of workspace A cannot rename or reset someone who only belongs to
 *     workspace B (hard rule #1 applied to a global table);
 *   - is audit-logged with actor, subject, action and time (hard rule #8);
 *   - revokes the subject's sessions when it changes how they authenticate.
 */

const RESET_LINK_TTL_MINUTES = 60;

/**
 * What state an account is actually in.
 *
 * The panel used to render four independent chips — "no password", "must
 * change", "2FA off", "locked" — and leave the reader to work out what they
 * added up to. They do not add up to four things; they add up to ONE, and it is
 * the answer to the only question an Owner is asking: can this person get in
 * right now, and if not, why not.
 */


export interface UserSessionView {
  id: string;
  /** A readable device line, e.g. "Chrome on macOS". */
  device: string;
  ip: string | null;
  lastSeenAt: string;
  createdAt: string;
  /** True for the session making this request — never offer to sign it out. */
  isCurrent: boolean;
}

export interface ManagedUser {
  userId: string;
  name: string;
  email: string;
  role: string;
  grants: string[];
  status: UserStatus;
  totpEnabled: boolean;
  mustEnrollTotp: boolean;
  mustChangePassword: boolean;
  hasPassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  suspendedAt: string | null;
  joinedAt: string;
  activeSessions: number;
  sessions: UserSessionView[];
  isSelf: boolean;
  /**
   * Removing or suspending the last Owner would leave a workspace nobody can
   * administer, so the panel needs to know before it offers the button.
   */
  isLastOwner: boolean;
}

export async function listWorkspaceUsers(): Promise<ManagedUser[]> {
  await requireOwner();
  const { workspaceId, userId: actorId, sessionId } = await getActiveContext();
  const now = new Date();

  const memberships = await prismaUnsafe.membership.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          passwordHash: true,
          totpEnabled: true,
          mustEnrollTotp: true,
          mustChangePassword: true,
          lockedUntil: true,
          lastLoginAt: true,
          sessions: {
            where: { revokedAt: null, expiresAt: { gt: now } },
            orderBy: { lastSeenAt: "desc" },
            select: {
              id: true,
              ip: true,
              userAgent: true,
              lastSeenAt: true,
              createdAt: true,
            },
          },
        },
      },
    },
  });

  // Counted once rather than per row: the answer is the same for everybody, and
  // it decides whether the panel offers to remove or suspend an Owner at all.
  const liveOwners = memberships.filter((m) => m.role === "OWNER" && !m.suspendedAt).length;

  return memberships.map((m) => {
    const hasPassword =
      m.user.passwordHash !== NO_PASSWORD && m.user.passwordHash.length > 1;
    return {
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      grants: Array.isArray(m.grants) ? (m.grants as string[]) : [],
      status: statusOf(
        {
          suspendedAt: m.suspendedAt,
          lockedUntil: m.user.lockedUntil,
          hasPassword,
          lastLoginAt: m.user.lastLoginAt,
        },
        now,
      ),
      totpEnabled: m.user.totpEnabled,
      mustEnrollTotp: m.user.mustEnrollTotp,
      mustChangePassword: m.user.mustChangePassword,
      hasPassword,
      lockedUntil: m.user.lockedUntil?.toISOString() ?? null,
      lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
      suspendedAt: m.suspendedAt?.toISOString() ?? null,
      joinedAt: m.createdAt.toISOString(),
      activeSessions: m.user.sessions.length,
      sessions: m.user.sessions.map((sess) => ({
        id: sess.id,
        device: describeDevice(sess.userAgent),
        ip: sess.ip,
        lastSeenAt: sess.lastSeenAt.toISOString(),
        createdAt: sess.createdAt.toISOString(),
        isCurrent: sess.id === sessionId,
      })),
      isSelf: m.user.id === actorId,
      isLastOwner: isLastLiveOwner(m, liveOwners),
    };
  });
}

/**
 * Resolve a target user, refusing anyone outside the active workspace.
 * This is the tenancy check for a table that has no workspace_id of its own.
 */
async function requireMember(userId: string, workspaceId: string) {
  const membership = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  return membership?.user ?? null;
}

async function audit(input: {
  workspaceId: string;
  actorUserId: string;
  action: string;
  subjectId: string;
  /** Prisma's Json input type — plain serialisable values only. */
  meta?: Prisma.InputJsonValue;
}): Promise<void> {
  // audit_logs is a tenant table — guarded client, not the raw one.
  await getWorkspaceClient(input.workspaceId).auditLog.create({
    data: {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: "User",
      entityId: input.subjectId,
      meta: input.meta ?? {},
    },
  });
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

const identitySchema = z.object({
  userId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
});

export async function updateUserIdentity(
  raw: unknown,
): Promise<{ ok: true; emailChanged: boolean } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can edit users." };
  }
  const parsed = identitySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Enter a valid name and email address." };

  const { workspaceId, userId: actorId } = await getActiveContext();
  const target = await requireMember(parsed.data.userId, workspaceId);
  if (!target) return { ok: false, error: "That user is not a member of this workspace." };

  const emailChanged = target.email !== parsed.data.email;
  if (emailChanged) {
    const clash = await prismaUnsafe.user.findUnique({
      where: { email: parsed.data.email },
      select: { id: true },
    });
    if (clash && clash.id !== target.id) {
      return { ok: false, error: "Another account already uses that email address." };
    }
  }

  await prismaUnsafe.user.update({
    where: { id: target.id },
    data: { name: parsed.data.name, email: parsed.data.email },
  });

  // The email IS the login identifier — an open session would keep working
  // under the old identity, so it goes.
  if (emailChanged) await revokeAllUserSessions(target.id);

  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.identity_updated",
    subjectId: target.id,
    meta: {
      from: { name: target.name, email: target.email },
      to: { name: parsed.data.name, email: parsed.data.email },
    },
  });
  revalidatePath("/settings");
  return { ok: true, emailChanged };
}

// ---------------------------------------------------------------------------
// password
// ---------------------------------------------------------------------------

const setPasswordSchema = z.object({
  userId: z.string().min(1),
  password: z.string().min(1).max(200),
  requireChange: z.boolean().default(true),
});

/** Set a password directly. Use when handing it over in person. */
export async function setUserPassword(
  raw: unknown,
): Promise<{ ok: true; revoked: number } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can set passwords." };
  }
  const parsed = setPasswordSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the password." };

  const problems = validatePassword(parsed.data.password);
  if (problems.length > 0) {
    return { ok: false, error: `Password ${problems.map((p) => p.message).join("; ")}.` };
  }

  const { workspaceId, userId: actorId } = await getActiveContext();
  const target = await requireMember(parsed.data.userId, workspaceId);
  if (!target) return { ok: false, error: "That user is not a member of this workspace." };

  await prismaUnsafe.user.update({
    where: { id: target.id },
    data: {
      passwordHash: await hashPassword(parsed.data.password),
      mustChangePassword: parsed.data.requireChange,
      lockedUntil: null,
    },
  });
  const revoked = await revokeAllUserSessions(target.id);

  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.password_set",
    subjectId: target.id,
    // Never the password, obviously — only that it happened.
    meta: { email: target.email, requireChange: parsed.data.requireChange, revokedSessions: revoked },
  });
  revalidatePath("/settings");
  return { ok: true, revoked };
}

/**
 * Issue a single-use reset link instead of choosing a password for someone.
 * The raw token is returned ONCE, here, and never stored — only its hash is.
 */
export async function createPasswordResetLink(
  raw: unknown,
): Promise<{ ok: true; url: string; expiresAt: string } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can issue reset links." };
  }
  const parsed = z.object({ userId: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown user." };

  const { workspaceId, userId: actorId } = await getActiveContext();
  const target = await requireMember(parsed.data.userId, workspaceId);
  if (!target) return { ok: false, error: "That user is not a member of this workspace." };

  const { url, expiresAt } = await issueResetLink(target.id, actorId);

  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.reset_link_issued",
    subjectId: target.id,
    meta: { email: target.email, expiresAt },
  });
  revalidatePath("/settings");
  return { ok: true, url, expiresAt };
}

/**
 * Mint a single-use, one-hour link that lets somebody set their own password.
 *
 * Shared by the reset button and by an invitation, because they are the same
 * act: the difference is only whether the account existed a moment ago.
 *
 * Any earlier unused link for this user stops working the instant a new one is
 * issued, so only the most recent link is ever live.
 */
async function issueResetLink(
  userId: string,
  actorId?: string,
): Promise<{ url: string; expiresAt: string }> {
  await prismaUnsafe.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_LINK_TTL_MINUTES * 60_000);
  await prismaUnsafe.passwordResetToken.create({
    data: {
      userId,
      token: createHash("sha256").update(token).digest("hex"),
      expiresAt,
      createdByUserId: actorId ?? null,
    },
  });
  return { url: appLink(`/reset/${token}`), expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// two-factor
// ---------------------------------------------------------------------------

/**
 * Reset someone's second factor: delete the secret and require a fresh
 * enrollment before they can use the app again. This is the lost-phone path.
 */
export async function resetUserTotp(
  raw: unknown,
): Promise<{ ok: true; revoked: number } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can reset two-factor authentication." };
  }
  const parsed = z.object({ userId: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown user." };

  const { workspaceId, userId: actorId } = await getActiveContext();
  const target = await requireMember(parsed.data.userId, workspaceId);
  if (!target) return { ok: false, error: "That user is not a member of this workspace." };

  await prismaUnsafe.user.update({
    where: { id: target.id },
    data: {
      totpSecret: null,
      totpEnabled: false,
      totpLastStep: null,
      // They cannot get back in without scanning a new QR.
      mustEnrollTotp: true,
    },
  });
  const revoked = await revokeAllUserSessions(target.id);

  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.totp_reset",
    subjectId: target.id,
    meta: { email: target.email, revokedSessions: revoked },
  });
  revalidatePath("/settings");
  return { ok: true, revoked };
}

/** Clear a lockout without touching the password. */
export async function unlockUser(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can unlock accounts." };
  }
  const parsed = z.object({ userId: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown user." };

  const { workspaceId, userId: actorId } = await getActiveContext();
  const target = await requireMember(parsed.data.userId, workspaceId);
  if (!target) return { ok: false, error: "That user is not a member of this workspace." };

  await prismaUnsafe.user.update({ where: { id: target.id }, data: { lockedUntil: null } });
  await prismaUnsafe.loginAttempt.deleteMany({ where: { email: target.email } });
  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.unlocked",
    subjectId: target.id,
    meta: { email: target.email },
  });
  revalidatePath("/settings");
  return { ok: true };
}

/** Sign a user out of every device. */
export async function revokeUserSessions(
  raw: unknown,
): Promise<{ ok: true; revoked: number } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can sign other users out." };
  }
  const parsed = z.object({ userId: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown user." };

  const { workspaceId, userId: actorId } = await getActiveContext();
  const target = await requireMember(parsed.data.userId, workspaceId);
  if (!target) return { ok: false, error: "That user is not a member of this workspace." };

  const revoked = await revokeAllUserSessions(target.id);
  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.sessions_revoked",
    subjectId: target.id,
    meta: { email: target.email, count: revoked },
  });
  revalidatePath("/settings");
  return { ok: true, revoked };
}

// Reset-link consumption lives in ./reset-tokens — it is reached WITHOUT a
// session (the token is the credential), so it must not import the auth stack.
// Import it from there directly; a "use server" module cannot re-export.

// ---------------------------------------------------------------------------
// membership: role, suspension, removal, invitation
// ---------------------------------------------------------------------------

const ROLES = ["OWNER", "ADMIN", "BDR"] as const;

/**
 * How many Owners this workspace still has who can actually sign in.
 *
 * Guards every path that could reduce that number to zero. A workspace with no
 * live Owner cannot grant a role, provision anything, or restore itself —
 * recovering one needs shell access to the server, which is not a support
 * process, it is an outage.
 */
async function liveOwnerCount(workspaceId: string, excludeUserId?: string): Promise<number> {
  return prismaUnsafe.membership.count({
    where: {
      workspaceId,
      role: "OWNER",
      suspendedAt: null,
      ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
    },
  });
}

export async function setUserRole(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can change roles." };
  }
  const parsed = z
    .object({ userId: z.string().min(1), role: z.enum(ROLES) })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown user or role." };

  const { workspaceId, userId: actorId } = await getActiveContext();
  const target = await requireMember(parsed.data.userId, workspaceId);
  if (!target) return { ok: false, error: "That user is not a member of this workspace." };

  // Demoting the last Owner locks everybody out of their own workspace.
  if (parsed.data.role !== "OWNER" && (await liveOwnerCount(workspaceId, target.id)) === 0) {
    return {
      ok: false,
      error: "This is the last Owner. Promote somebody else first, then change this role.",
    };
  }

  await prismaUnsafe.membership.update({
    where: { userId_workspaceId: { userId: target.id, workspaceId } },
    data: { role: parsed.data.role },
  });
  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.role_changed",
    subjectId: target.id,
    meta: { email: target.email, role: parsed.data.role },
  });
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Stand somebody down, or bring them back.
 *
 * The honest middle ground between doing nothing and deleting an account.
 * Removing a member takes the authorship of their history with them, and "who
 * wrote this note" is a question people ask months later — but a person who has
 * left today must stop reading the workspace today.
 *
 * Suspension bites immediately: their sessions are revoked, and
 * `tryGetActiveContext` refuses to resolve a suspended membership, so an open
 * browser is stopped rather than left running until its token expires.
 */
export async function setUserSuspended(
  raw: unknown,
): Promise<{ ok: true; revoked: number } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can suspend a member." };
  }
  const parsed = z
    .object({ userId: z.string().min(1), suspended: z.boolean() })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown user." };

  const { workspaceId, userId: actorId } = await getActiveContext();
  const target = await requireMember(parsed.data.userId, workspaceId);
  if (!target) return { ok: false, error: "That user is not a member of this workspace." };
  if (target.id === actorId) {
    // Not paternalism: the next request would fail to resolve a context and
    // drop them at the login form with no way back in.
    return { ok: false, error: "You cannot suspend yourself." };
  }
  if (parsed.data.suspended && (await liveOwnerCount(workspaceId, target.id)) === 0) {
    return {
      ok: false,
      error: "This is the last Owner. Promote somebody else first.",
    };
  }

  await prismaUnsafe.membership.update({
    where: { userId_workspaceId: { userId: target.id, workspaceId } },
    data: {
      suspendedAt: parsed.data.suspended ? new Date() : null,
      suspendedBy: parsed.data.suspended ? actorId : null,
    },
  });

  // Only on the way in. Restoring somebody should not also sign out the other
  // workspaces they were never suspended from.
  const revoked = parsed.data.suspended ? await revokeAllUserSessions(target.id) : 0;

  await audit({
    workspaceId,
    actorUserId: actorId,
    action: parsed.data.suspended ? "user.suspended" : "user.restored",
    subjectId: target.id,
    meta: { email: target.email, sessionsRevoked: revoked },
  });
  revalidatePath("/settings");
  return { ok: true, revoked };
}

/**
 * Remove somebody from THIS workspace.
 *
 * The membership goes; the user account does not. They keep any other
 * workspace they belong to, and everything they authored here keeps its author
 * — an audit log whose actor has been deleted answers "somebody" to every
 * question worth asking.
 */
export async function removeMember(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can remove a member." };
  }
  const parsed = z.object({ userId: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown user." };

  const { workspaceId, userId: actorId } = await getActiveContext();
  const target = await requireMember(parsed.data.userId, workspaceId);
  if (!target) return { ok: false, error: "That user is not a member of this workspace." };
  if (target.id === actorId) {
    return { ok: false, error: "You cannot remove yourself from a workspace you administer." };
  }
  if ((await liveOwnerCount(workspaceId, target.id)) === 0) {
    return { ok: false, error: "This is the last Owner. Promote somebody else first." };
  }

  await prismaUnsafe.membership.delete({
    where: { userId_workspaceId: { userId: target.id, workspaceId } },
  });
  // Their session may be pointing at this workspace; revoking is the only way
  // to be sure the next request does not resolve back into it.
  await revokeAllUserSessions(target.id);

  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.removed",
    subjectId: target.id,
    meta: { email: target.email },
  });
  revalidatePath("/settings");
  return { ok: true };
}

const inviteSchema = z.object({
  email: z.string().trim().email().max(200),
  name: z.string().trim().min(1).max(120),
  role: z.enum(ROLES),
});

/**
 * Invite somebody, and hand back the link that lets them in.
 *
 * ── WHY A LINK RATHER THAN A PASSWORD ───────────────────────────────────────
 *
 * The previous flow created the account with an unusable password hash and left
 * the Owner to set one and tell them what it was — a password travelling
 * through a chat window, known to two people, and never changed. The invite now
 * produces the same single-use, one-hour reset link the "send a reset" button
 * produces, so the person chooses their own password and nobody else ever knows
 * it.
 *
 * The link is RETURNED rather than emailed. Transactional mail exists here, but
 * an invitation that silently fails to arrive is worse than one the Owner can
 * see and paste — and CLAUDE.md's rule about sending only on explicit user
 * action points the same way.
 */
export async function inviteUser(
  raw: unknown,
): Promise<
  | { ok: true; url: string; expiresAt: string; existing: boolean }
  | { ok: false; error: string }
> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can invite people." };
  }
  const parsed = inviteSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the name, email and role." };
  const { email, name, role } = parsed.data;
  const { workspaceId, userId: actorId } = await getActiveContext();

  const normalized = email.toLowerCase();
  const existingUser = await prismaUnsafe.user.findUnique({
    where: { email: normalized },
    select: { id: true },
  });

  // An account may already exist from another workspace. Reuse it rather than
  // refusing: one person, one login, however many workspaces.
  const user = existingUser
    ? existingUser
    : await prismaUnsafe.user.create({
        data: {
          email: normalized,
          name,
          passwordHash: NO_PASSWORD,
          mustChangePassword: true,
        },
        select: { id: true },
      });

  const already = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId: user.id, workspaceId } },
    select: { id: true, suspendedAt: true },
  });
  if (already) {
    // Re-inviting somebody who is already here restores them rather than
    // erroring — that is almost always what was meant.
    await prismaUnsafe.membership.update({
      where: { id: already.id },
      data: { role, suspendedAt: null, suspendedBy: null },
    });
  } else {
    await prismaUnsafe.membership.create({
      data: { userId: user.id, workspaceId, role, grants: [] },
    });
  }

  const link = await issueResetLink(user.id, actorId);
  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.invited",
    subjectId: user.id,
    meta: { email: normalized, role, existingAccount: !!existingUser },
  });
  revalidatePath("/settings");
  return { ok: true, ...link, existing: !!existingUser };
}
