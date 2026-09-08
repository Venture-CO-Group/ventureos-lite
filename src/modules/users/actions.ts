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
import { getMailProvider } from "../mail/provider";
import { brandEmail, brandEmailText } from "../mail/layout";
import { resolveSendingIdentity } from "../mail/identity";
import { brandFrom } from "../workspaces/brand";
import { describeDevice, isLastLiveOwner, statusOf, type UserStatus } from "./status";
import { LIVE_STATES } from "../members/lifecycle";

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
  /** INVITED | ACTIVE | SUSPENDED | REMOVED — the authority (§1). */
  state: string;
  /** Their own photo, for the table (§3). */
  avatarUrl: string | null;
  /** The teams they are on, and whether they lead one (§3, §5). */
  teams: { id: string; name: string; color: string | null; isLead: boolean }[];
  /**
   * What they are carrying, for the impact report and the drawer's summary
   * (§3, §4). Counted per member in one grouped query rather than N.
   */
  activity: { leads: number; openDeals: number; openTasks: number; meetings: number };
  /** Which company a CLIENT may see, and its name for the panel (P6/6.3). */
  clientCompanyId: string | null;
  clientCompanyName: string | null;
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
    // Ended memberships are excluded by default (§1): a list that grows for
    // ever with people who left is a list nobody reads. Their rows survive so
    // that "created by" and the timeline stay readable.
    where: { workspaceId, state: { in: LIVE_STATES } },
    orderBy: { createdAt: "asc" },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          passwordHash: true,
          avatarPath: true,
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
  // The state, not `suspendedAt` (§1): an Owner whose membership is INVITED
  // or REMOVED cannot administer anything, and counting them would let the
  // last real Owner suspend themselves.
  const liveOwners = memberships.filter((m) => m.role === "OWNER" && m.state === "ACTIVE").length;

  /**
   * The names of the companies client accounts are pointed at (P6/6.3).
   *
   * One query for all of them. Through the GUARDED client, so an id left on a
   * membership after the company was merged away or deleted resolves to nothing
   * rather than to a stale name — and could never resolve into another tenant.
   */
  /**
   * Teams, and what each member is carrying — two grouped queries, not 2N.
   *
   * The obvious shape is a count per member inside the map below, which is
   * five queries per row and forty rows on a real workspace. Grouped once and
   * looked up in a Map instead.
   */
  const [teamRows, leadCounts, dealCounts, taskCounts, meetingCounts] = await Promise.all([
    prismaUnsafe.teamMember.findMany({
      where: { workspaceId },
      include: { team: { select: { id: true, name: true, color: true, archivedAt: true } } },
    }),
    getWorkspaceClient(workspaceId).lead.groupBy({ by: ["ownerId"], _count: { _all: true } }),
    getWorkspaceClient(workspaceId).deal.groupBy({
      where: { status: "OPEN" },
      by: ["ownerId"],
      _count: { _all: true },
    }),
    getWorkspaceClient(workspaceId).task.groupBy({
      where: { doneAt: null },
      by: ["assigneeId"],
      _count: { _all: true },
    }),
    getWorkspaceClient(workspaceId).meeting.groupBy({
      where: { scheduledAt: { gte: now } },
      by: ["hostUserId"],
      _count: { _all: true },
    }),
  ]);
  const teamsByUser = new Map<string, ManagedUser["teams"]>();
  for (const row of teamRows) {
    // An archived team is not a team somebody is on.
    if (row.team.archivedAt) continue;
    const list = teamsByUser.get(row.userId) ?? [];
    list.push({
      id: row.team.id,
      name: row.team.name,
      color: row.team.color,
      isLead: row.isLead,
    });
    teamsByUser.set(row.userId, list);
  }
  const countMap = (rows: { _count: { _all: number } }[], key: string) =>
    new Map(
      rows
        .map((r) => [(r as unknown as Record<string, string | null>)[key], r._count._all] as const)
        .filter((e): e is readonly [string, number] => typeof e[0] === "string"),
    );
  const leadsBy = countMap(leadCounts, "ownerId");
  const dealsBy = countMap(dealCounts, "ownerId");
  const tasksBy = countMap(taskCounts, "assigneeId");
  const meetingsBy = countMap(meetingCounts, "hostUserId");

  const clientCompanyIds = [
    ...new Set(
      memberships.map((m) => m.clientCompanyId).filter((v): v is string => typeof v === "string"),
    ),
  ];
  const companies = clientCompanyIds.length
    ? await getWorkspaceClient(workspaceId).company.findMany({
        where: { id: { in: clientCompanyIds } },
        select: { id: true, name: true },
      })
    : [];
  const companyName = new Map(companies.map((c) => [c.id, c.name]));

  return memberships.map((m) => {
    const hasPassword =
      m.user.passwordHash !== NO_PASSWORD && m.user.passwordHash.length > 1;
    return {
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      state: m.state,
      avatarUrl: m.user.avatarPath ? `/api/files/${m.user.avatarPath}` : null,
      teams: teamsByUser.get(m.user.id) ?? [],
      activity: {
        leads: leadsBy.get(m.user.id) ?? 0,
        openDeals: dealsBy.get(m.user.id) ?? 0,
        openTasks: tasksBy.get(m.user.id) ?? 0,
        meetings: meetingsBy.get(m.user.id) ?? 0,
      },
      clientCompanyId: m.clientCompanyId,
      clientCompanyName: m.clientCompanyId
        ? (companyName.get(m.clientCompanyId) ?? null)
        : null,
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

/**
 * The roles an Owner may assign.
 *
 * CLIENT is read-only client access (P6/6.3) and is not a smaller BDR: it sees
 * one company's delivery and nothing else. It carries a company id, which is
 * why the two mutations below take one.
 */
const ROLES = ["OWNER", "ADMIN", "BDR", "CLIENT"] as const;

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
    .object({
      userId: z.string().min(1),
      role: z.enum(ROLES),
      /** Which company a CLIENT may see. Ignored for every other role. */
      clientCompanyId: z.string().trim().optional(),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown user or role." };

  if (parsed.data.role === "CLIENT" && !parsed.data.clientCompanyId) {
    // Refused rather than allowed-and-empty. A client account with no company
    // is an account that logs in to a page saying nothing, and the Owner would
    // read that as the feature being broken.
    return { ok: false, error: "Pick the company this client may see." };
  }

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
    data: {
      role: parsed.data.role,
      // Cleared when the role is anything else, so a person promoted out of
      // client access does not leave a stale company id behind on their row.
      clientCompanyId:
        parsed.data.role === "CLIENT" ? (parsed.data.clientCompanyId ?? null) : null,
      // And a client carries no capabilities at all. `grantAllowed` already
      // refuses them, but leaving the array populated would make the grants
      // panel show ticks that mean nothing.
      ...(parsed.data.role === "CLIENT" ? { grants: [] } : {}),
    },
  });
  /**
   * Every session they have open is revoked.
   *
   * A role change has to bite now, in both directions. Somebody demoted to
   * client access at 14:00 with the pipeline open would otherwise keep reading
   * it — the shell resolves the role per request, so the next navigation would
   * catch it, but "the next navigation" is not a guarantee.
   */
  const revoked = await revokeAllUserSessions(target.id);
  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.role_changed",
    subjectId: target.id,
    meta: {
      email: target.email,
      role: parsed.data.role,
      clientCompanyId: parsed.data.clientCompanyId ?? null,
      sessionsRevoked: revoked,
    },
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
      state: parsed.data.suspended ? "SUSPENDED" : "ACTIVE",
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
  /** Required when the role is CLIENT (P6/6.3). */
  clientCompanyId: z.string().trim().optional(),
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
  | { ok: true; userId: string; url: string; expiresAt: string; existing: boolean }
  | { ok: false; error: string }
> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can invite people." };
  }
  const parsed = inviteSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the name, email and role." };
  const { email, name, role, clientCompanyId } = parsed.data;
  if (role === "CLIENT" && !clientCompanyId) {
    return { ok: false, error: "Pick the company this client may see." };
  }
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
    select: { id: true, state: true },
  });
  if (already) {
    // Re-inviting somebody who is already here restores them rather than
    // erroring — that is almost always what was meant.
    await prismaUnsafe.membership.update({
      where: { id: already.id },
      data: {
        role,
        state: "ACTIVE",
        suspendedAt: null,
        suspendedBy: null,
        clientCompanyId: role === "CLIENT" ? (clientCompanyId ?? null) : null,
      },
    });
  } else {
    await prismaUnsafe.membership.create({
      data: {
        userId: user.id,
        workspaceId,
        role,
        grants: [],
        clientCompanyId: role === "CLIENT" ? (clientCompanyId ?? null) : null,
      },
    });
  }

  const link = await issueResetLink(user.id, actorId);
  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.invited",
    subjectId: user.id,
    meta: {
      email: normalized,
      role,
      clientCompanyId: clientCompanyId ?? null,
      existingAccount: !!existingUser,
    },
  });
  revalidatePath("/settings");
  // The user id travels back so the panel can offer to EMAIL the link (P6/6.4)
  // — the token is stored hashed, so nothing can re-derive the URL later.
  return { ok: true, userId: user.id, ...link, existing: !!existingUser };
}

// ---------------------------------------------------------------------------
// client access: which companies a client account can be pointed at (P6/6.3)
// ---------------------------------------------------------------------------

/**
 * The companies an Owner can hand read-only access to.
 *
 * Only companies with something to show — a project or a finalized document.
 * A client account pointed at a company with neither would log in to an empty
 * page, which reads as a broken feature rather than as "nothing has started
 * yet", and the Owner has no way to tell the difference from the picker.
 */
export async function listClientCompanies(): Promise<
  { id: string; name: string; projects: number; documents: number }[]
> {
  await requireOwner();
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const [projects, documents] = await Promise.all([
    db.project.groupBy({ by: ["companyId"], _count: { _all: true } }),
    db.document.findMany({
      where: { watermark: false, finalizedAt: { not: null } },
      select: { lead: { select: { companyId: true } }, deal: { select: { companyId: true } } },
    }),
  ]);

  const counts = new Map<string, { projects: number; documents: number }>();
  const bump = (id: string | null | undefined, key: "projects" | "documents", n = 1) => {
    if (!id) return;
    const row = counts.get(id) ?? { projects: 0, documents: 0 };
    row[key] += n;
    counts.set(id, row);
  };
  for (const p of projects) bump(p.companyId, "projects", p._count._all);
  // A document reaches its company through the lead or the deal; both are
  // asked, because a chain that predates the deals layer has only the lead.
  for (const d of documents) bump(d.deal?.companyId ?? d.lead?.companyId, "documents");

  if (counts.size === 0) return [];
  const companies = await db.company.findMany({
    where: { id: { in: [...counts.keys()] } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return companies.map((c) => ({
    id: c.id,
    name: c.name,
    projects: counts.get(c.id)?.projects ?? 0,
    documents: counts.get(c.id)?.documents ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// invitations by email (P6/6.4)
// ---------------------------------------------------------------------------

/**
 * Email an invitation link, on an explicit click.
 *
 * ── WHY THIS IS ALLOWED, AND WHY IT IS A SECOND BUTTON ──────────────────────
 *
 * `inviteUser` returns the link for the Owner to paste, and that stays the
 * default: an invitation that silently fails to arrive is worse than one the
 * Owner can see. But pasting a link into a chat window every time is friction
 * for no reason when transactional mail is already configured.
 *
 * CLAUDE.md hard rule #2 forbids the system sending anything on its own. This
 * is a person pressing a button labelled "send it by email", which is exactly
 * the explicit user action the rule carves out — so the send happens HERE, in
 * a separate action, and never as a side effect of creating the invitation.
 *
 * The link itself is not re-derivable: a reset token is stored hashed. So the
 * caller passes back the URL it was just handed, and this action verifies it
 * belongs to the person being invited before sending it anywhere.
 */
export async function emailInviteLink(
  raw: unknown,
): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can send an invitation." };
  }
  const parsed = z
    .object({ userId: z.string().min(1), url: z.string().trim().min(10).max(500) })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Missing the invitation link." };

  const { workspaceId, userId: actorId } = await getActiveContext();
  const target = await requireMember(parsed.data.userId, workspaceId);
  if (!target) return { ok: false, error: "That user is not a member of this workspace." };

  /**
   * The URL must be one of ours, and must be a reset link.
   *
   * Without this the action would send arbitrary text to a member's address on
   * an Owner's say-so — a small open relay with our sending reputation behind
   * it. Checked against the app's own base URL rather than a substring.
   */
  if (!parsed.data.url.startsWith(appLink("/reset/"))) {
    return { ok: false, error: "That does not look like an invitation link from this app." };
  }

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, mailgunConfig: true, brand: true },
  });
  const brand = brandFrom(ws?.brand);
  const identity = resolveSendingIdentity(ws?.mailgunConfig, brand);
  /**
   * The workspace's own name, never the product's.
   *
   * A literal "Venture OS" in a subject line is the white-label leak the brand
   * work exists to prevent: on a white-labelled deployment the operator's
   * invitee would get mail from a company they have never heard of. The brand
   * module is the fallback, not a string in this file — and a unit test over
   * every sender enforces it.
   */
  const senderName = ws?.name?.trim() || brand.name;
  const body = {
    preheader: `Meghívó a ${senderName} munkaterületre`,
    heading: "Meghívtak egy munkaterületre",
    paragraphs: [
      `Szia ${target.name}!`,
      `Hozzáférést kaptál a ${senderName} munkaterülethez. Az alábbi linken tudsz saját jelszót választani.`,
      "A link egy órán belül lejár, és csak egyszer használható. Ha lejárt, kérj újat attól, aki meghívott.",
    ],
    button: { label: "Jelszó beállítása", url: parsed.data.url },
    footNote: "Ha nem te kértél hozzáférést, hagyd figyelmen kívül ezt a levelet.",
    brand,
  };

  try {
    await getMailProvider().send({
      domain: identity.domain,
      to: target.email,
      from: identity.from,
      ...(identity.replyTo ? { replyTo: identity.replyTo } : {}),
      subject: `Meghívó — ${senderName}`,
      html: brandEmail(body),
      text: brandEmailText(body),
    });
  } catch (e) {
    // Reported, never swallowed: the Owner still has the link on screen and
    // needs to know that pasting it is now the only way through.
    return { ok: false, error: `A levél nem ment ki: ${(e as Error).message}` };
  }

  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.invite_emailed",
    subjectId: target.id,
    meta: { email: target.email },
  });
  return { ok: true, to: target.email };
}
