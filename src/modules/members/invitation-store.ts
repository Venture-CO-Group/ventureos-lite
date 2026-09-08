import { createHash, randomBytes } from "node:crypto";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { appLink } from "@/lib/public-links";
import { getMailProvider } from "../mail/provider";
import { brandEmail, brandEmailText } from "../mail/layout";
import { resolveSendingIdentity } from "../mail/identity";
import { brandFrom } from "../workspaces/brand";
import { recordMemberEvent } from "./timeline";
import { LIVE_STATES } from "./lifecycle";
import {
  INVITE_TTL_DAYS,
  acceptVerdict,
  canResend,
  invitationState,
  inviteExpiry,
  nameFromEmail,
  type AcceptVerdict,
} from "./invitation-logic";

/**
 * Issuing, sending, resending, revoking and accepting invitations (§2).
 *
 * Not `"use server"`: the actions module wraps these. Keeping the work here
 * means the accept path — which runs unauthenticated on a public route — can
 * call it without importing a file full of Owner-gated actions.
 */

/** sha256, never the token. The token is the credential. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function inviteLink(token: string): string {
  return appLink(`/invite/${token}`);
}

export interface IssueResult {
  ok: true;
  invitationId: string;
  url: string;
  expiresAt: string;
  /** The invitee already had an account here, on this or another workspace. */
  existingAccount: boolean;
}

export type IssueOutcome = IssueResult | { ok: false; error: string };

/**
 * Create an invitation, or refuse for a reason worth reading.
 *
 * ── THE EDGE CASES, AND WHY EACH ANSWERS AS IT DOES ─────────────────────────
 *
 * ALREADY A MEMBER (active, invited or suspended) → refused. The spec asks for
 * a clear message and it is right: silently "re-inviting" an active colleague
 * would either do nothing or, worse, reset their role to whatever the form
 * happened to have selected.
 *
 * A MEMBERSHIP THAT ENDED → allowed, and it is the documented way back. The
 * lifecycle refuses REMOVED → ACTIVE directly on purpose, so somebody
 * returning accepts the terms again and the timeline reads as a return.
 *
 * AN ACCOUNT ON ANOTHER WORKSPACE → allowed, and the accept page will skip the
 * password step. One person, one login, however many workspaces.
 *
 * A LIVE INVITATION ALREADY OUT → refused, pointing at resend. Two live
 * invitations to one address means two working tokens, and revoking one would
 * leave the other alive.
 */
export async function issueInvitation(input: {
  workspaceId: string;
  actorUserId: string;
  email: string;
  name?: string;
  role: string;
  grants?: string[];
  clientCompanyId?: string | null;
  now?: Date;
}): Promise<IssueOutcome> {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  const db = getWorkspaceClient(input.workspaceId);

  const existingUser = await prismaUnsafe.user.findUnique({
    where: { email },
    select: { id: true, deletedAt: true },
  });

  if (existingUser) {
    if (existingUser.deletedAt) {
      return {
        ok: false,
        error:
          "That account is scheduled for deletion. Restore it first, then invite them.",
      };
    }
    const membership = await prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId: existingUser.id, workspaceId: input.workspaceId } },
      select: { state: true },
    });
    if (membership && LIVE_STATES.includes(membership.state as never)) {
      return {
        ok: false,
        error:
          membership.state === "INVITED"
            ? "They already have an invitation out. Resend it rather than issuing a second."
            : membership.state === "SUSPENDED"
              ? "They are already a member, currently suspended. Reinstate them instead."
              : "They are already a member of this workspace.",
      };
    }
  }

  const live = await db.invitation.findFirst({
    where: { email, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    select: { id: true },
  });
  if (live) {
    return {
      ok: false,
      error: "An invitation to that address is already out. Resend or revoke it first.",
    };
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = inviteExpiry(now);
  const invitation = await db.invitation.create({
    data: {
      workspaceId: input.workspaceId,
      email,
      role: input.role as never,
      grants: (input.grants ?? []) as never,
      clientCompanyId: input.clientCompanyId ?? null,
      tokenHash: hashToken(token),
      expiresAt,
      invitedBy: input.actorUserId,
      lastSentAt: now,
    },
    select: { id: true },
  });

  /**
   * A placeholder membership in INVITED, so the members screen can show them.
   *
   * Only when there is already a user row to hang it on. Somebody with no
   * account yet exists purely as an invitation until they accept — creating a
   * user for them before they have agreed to anything would put a person in
   * the database who never asked to be there.
   */
  if (existingUser) {
    await prismaUnsafe.membership.upsert({
      where: { userId_workspaceId: { userId: existingUser.id, workspaceId: input.workspaceId } },
      update: {
        state: "INVITED",
        role: input.role as never,
        grants: (input.grants ?? []) as never,
        clientCompanyId: input.clientCompanyId ?? null,
        removedAt: null,
        removedBy: null,
      },
      create: {
        userId: existingUser.id,
        workspaceId: input.workspaceId,
        state: "INVITED",
        role: input.role as never,
        grants: (input.grants ?? []) as never,
        clientCompanyId: input.clientCompanyId ?? null,
      },
    });
    await recordMemberEvent({
      workspaceId: input.workspaceId,
      userId: existingUser.id,
      actorUserId: input.actorUserId,
      kind: "invited",
      after: { role: input.role, email },
    });
  }

  await sendInvitationEmail({
    workspaceId: input.workspaceId,
    email,
    name: input.name?.trim() || nameFromEmail(email),
    token,
    expiresAt,
    inviterId: input.actorUserId,
  });

  return {
    ok: true,
    invitationId: invitation.id,
    url: inviteLink(token),
    expiresAt: expiresAt.toISOString(),
    existingAccount: !!existingUser,
  };
}

/**
 * The invitation email.
 *
 * On the transactional domain, and this is the one send in the product that
 * happens without the recipient having asked for anything — which is why it
 * is an invitation from a named person to join a named workspace and nothing
 * else. CLAUDE.md's rule is about unsolicited OUTREACH; an Owner adding a
 * colleague is an explicit user action with a named actor.
 *
 * Failures are reported, never swallowed: the Owner still has the link on
 * screen and needs to know that pasting it is now the only way through.
 */
export async function sendInvitationEmail(input: {
  workspaceId: string;
  email: string;
  name: string;
  token: string;
  expiresAt: Date;
  inviterId: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const [ws, inviter] = await Promise.all([
    prismaUnsafe.workspace.findUnique({
      where: { id: input.workspaceId },
      select: { name: true, mailgunConfig: true, brand: true },
    }),
    input.inviterId
      ? prismaUnsafe.user.findUnique({
          where: { id: input.inviterId },
          select: { name: true },
        })
      : Promise.resolve(null),
  ]);

  const brand = brandFrom(ws?.brand);
  const identity = resolveSendingIdentity(ws?.mailgunConfig, brand);
  // The workspace's name, never the product's — the white-label rule.
  const senderName = ws?.name?.trim() || brand.name;
  const who = inviter?.name ? `${inviter.name} ` : "";

  const content = {
    preheader: `Meghívó a ${senderName} munkaterületre`,
    heading: `Meghívtak: ${senderName}`,
    paragraphs: [
      `Szia ${input.name}!`,
      `${who}meghívott a ${senderName} munkaterületre. Az alábbi linken tudsz csatlakozni: beállítod a jelszavad, és beállítod a kétlépcsős azonosítást.`,
      `A link ${INVITE_TTL_DAYS} napig érvényes, és csak egyszer használható.`,
    ],
    button: { label: "Csatlakozom", url: inviteLink(input.token) },
    footNote:
      "Ha nem számítottál erre a meghívóra, hagyd figyelmen kívül ezt a levelet — a link magától lejár.",
    brand,
  };

  try {
    await getMailProvider().send({
      domain: identity.domain,
      to: input.email,
      from: identity.from,
      ...(identity.replyTo ? { replyTo: identity.replyTo } : {}),
      subject: `Meghívó — ${senderName}`,
      html: brandEmail(content),
      text: brandEmailText(content),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `A meghívó nem ment ki: ${(e as Error).message}` };
  }
}

/** What the public accept page is allowed to know. */
export interface InviteInspection {
  verdict: AcceptVerdict;
  /** Only when the verdict is ok. */
  email?: string;
  workspaceName?: string;
  /** True when they already have an account — the accept page skips the password. */
  hasAccount?: boolean;
  invitationId?: string;
}

export async function inspectInvitation(
  token: string,
  now: Date = new Date(),
): Promise<InviteInspection> {
  if (!token || token.length < 16) return { verdict: acceptVerdict(null, now) };

  /**
   * `prismaUnsafe`, and it has to be.
   *
   * This runs on a public route with no session, so there is no workspace to
   * scope a guarded client to — the invitation is what will decide the
   * workspace. The lookup is by a 256-bit token HASH, which is narrower than
   * any tenancy filter could be: an attacker who can guess it does not need
   * this route.
   */
  const row = await prismaUnsafe.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      email: true,
      workspaceId: true,
      acceptedAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  });

  const verdict = acceptVerdict(row, now);
  if (!verdict.ok || !row) return { verdict };

  const [ws, user] = await Promise.all([
    prismaUnsafe.workspace.findUnique({
      where: { id: row.workspaceId },
      select: { name: true },
    }),
    prismaUnsafe.user.findUnique({
      where: { email: row.email },
      select: { id: true, passwordHash: true, deletedAt: true },
    }),
  ]);

  return {
    verdict,
    email: row.email,
    workspaceName: ws?.name ?? "the workspace",
    // An account with a real password already: they authenticate rather than
    // choosing a new one. One person, one login, however many workspaces.
    hasAccount: !!user && !user.deletedAt && user.passwordHash.length > 1,
    invitationId: row.id,
  };
}

export async function findByToken(token: string) {
  if (!token || token.length < 16) return null;
  return prismaUnsafe.invitation.findUnique({ where: { tokenHash: hashToken(token) } });
}

/** Pending, expired and revoked invitations, for the members screen. */
export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  state: string;
  invitedByName: string | null;
  resendCount: number;
  lastSentAt: string;
  expiresAt: string;
  /** Older than the invitation window — the list an auditor asks for (§7). */
  stale: boolean;
}

export async function listInvitations(
  workspaceId: string,
  now: Date = new Date(),
): Promise<PendingInvitation[]> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.invitation.findMany({
    where: { acceptedAt: null },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const inviterIds = [...new Set(rows.map((r) => r.invitedBy).filter((v): v is string => !!v))];
  const inviters = inviterIds.length
    ? await prismaUnsafe.user.findMany({
        where: { id: { in: inviterIds } },
        select: { id: true, name: true },
      })
    : [];
  const byId = new Map(inviters.map((i) => [i.id, i.name]));

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    state: invitationState(r, now),
    invitedByName: r.invitedBy ? (byId.get(r.invitedBy) ?? null) : null,
    resendCount: r.resendCount,
    lastSentAt: r.lastSentAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    stale: r.createdAt.getTime() < now.getTime() - INVITE_TTL_DAYS * 86_400_000,
  }));
}

/**
 * Send it again, with a fresh token and a fresh window.
 *
 * A NEW token, not the old one re-sent. Two reasons: an expired invitation
 * cannot be revived by mailing the same dead string, and a token that has been
 * in somebody's inbox for a fortnight has had a fortnight of exposure.
 */
export async function resendInvitation(input: {
  workspaceId: string;
  actorUserId: string;
  invitationId: string;
  now?: Date;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = input.now ?? new Date();
  const db = getWorkspaceClient(input.workspaceId);
  const row = await db.invitation.findUnique({ where: { id: input.invitationId } });
  if (!row) return { ok: false, error: "That invitation does not exist." };

  const verdict = canResend(row, now);
  if (!verdict.ok) return verdict;

  const token = randomBytes(32).toString("base64url");
  const expiresAt = inviteExpiry(now);
  await db.invitation.update({
    where: { id: row.id },
    data: {
      tokenHash: hashToken(token),
      expiresAt,
      resendCount: { increment: 1 },
      lastSentAt: now,
    },
  });

  const sent = await sendInvitationEmail({
    workspaceId: input.workspaceId,
    email: row.email,
    name: nameFromEmail(row.email),
    token,
    expiresAt,
    inviterId: input.actorUserId,
  });
  if (!sent.ok) return sent;

  const user = await prismaUnsafe.user.findUnique({
    where: { email: row.email },
    select: { id: true },
  });
  if (user) {
    await recordMemberEvent({
      workspaceId: input.workspaceId,
      userId: user.id,
      actorUserId: input.actorUserId,
      kind: "invitation_resent",
      after: { resendCount: row.resendCount + 1 },
    });
  }
  return { ok: true };
}

/**
 * Withdraw it.
 *
 * The token stops working immediately. The row survives, so the members screen
 * can say an invitation was withdrawn rather than having it silently vanish —
 * and so a second invitation to the same address is a new row with its own
 * history rather than an edit of this one.
 */
export async function revokeInvitation(input: {
  workspaceId: string;
  actorUserId: string;
  invitationId: string;
  now?: Date;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = input.now ?? new Date();
  const db = getWorkspaceClient(input.workspaceId);
  const row = await db.invitation.findUnique({ where: { id: input.invitationId } });
  if (!row) return { ok: false, error: "That invitation does not exist." };
  if (row.acceptedAt) {
    return {
      ok: false,
      error: "They have already accepted. Suspend or remove the membership instead.",
    };
  }
  if (row.revokedAt) return { ok: true };

  await db.invitation.update({
    where: { id: row.id },
    data: { revokedAt: now, revokedBy: input.actorUserId },
  });

  // A placeholder membership goes with it, or the members screen would show a
  // pending person whose invitation is dead.
  const user = await prismaUnsafe.user.findUnique({
    where: { email: row.email },
    select: { id: true },
  });
  if (user) {
    const membership = await prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId: input.workspaceId } },
      select: { state: true },
    });
    if (membership?.state === "INVITED") {
      await prismaUnsafe.membership.update({
        where: { userId_workspaceId: { userId: user.id, workspaceId: input.workspaceId } },
        data: { state: "REMOVED", removedAt: now, removedBy: input.actorUserId },
      });
    }
    await recordMemberEvent({
      workspaceId: input.workspaceId,
      userId: user.id,
      actorUserId: input.actorUserId,
      kind: "invitation_revoked",
      before: { email: row.email, role: row.role },
    });
  }
  return { ok: true };
}
