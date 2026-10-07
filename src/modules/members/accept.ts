import { prismaUnsafe } from "@/lib/db";
import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  validatePassword,
  NO_PASSWORD,
} from "@/lib/auth/password";
import { generateTotpSecret, totpQrDataUrl, verifyTotp } from "@/lib/auth/totp";
import { OWNER_GRANTS } from "@/lib/grants";
import { brandFrom } from "../workspaces/brand";
import { recordMemberEvent } from "./timeline";
import { notifyInvitationAccepted } from "./notify";
import { acceptVerdict, nameFromEmail } from "./invitation-logic";
import { findByToken } from "./invitation-store";

/**
 * Accepting an invitation (§2).
 *
 * ── TWO-FACTOR IS NOT OPTIONAL HERE ─────────────────────────────────────────
 *
 * The spec says the invitee enrols immediately and must not be allowed a first
 * sign-in without it, and that is the right shape: 2FA that is offered later
 * is 2FA that half a team never turns on. So acceptance is a two-step form —
 * password, then an authenticator — and the membership only becomes ACTIVE
 * when the second step verifies. Until then the invitation stays open, so a
 * closed tab is a resumable interruption rather than a locked-out person.
 *
 * ── WHY IT RUNS UNAUTHENTICATED, AND WHAT PROTECTS IT ───────────────────────
 *
 * There is no session: the whole point is that this is somebody's first
 * contact with the product. The token is the credential — 256 bits, hashed at
 * rest, single-use, seven days — which is the same contract as a password
 * reset link. Nothing here reads a workspace id from the request; the
 * invitation decides it.
 */

export interface AcceptState {
  /**
   * `signin` is somebody who already has a login: they join by signing in and
   * pressing one button, never by choosing a second password. (It used to be
   * `done`, which told them "sign in and you will be in" — and then nothing
   * ever made the membership ACTIVE, so they never were.)
   */
  step: "password" | "totp" | "signin";
  email: string;
  workspaceName: string;
  /**
   * The workspace's own wordmark (§2).
   *
   * The other pre-authentication screens — login, password reset, 2FA
   * enrolment — show the PRODUCT's name, and correctly: nobody has signed in,
   * so there is no workspace to brand with. This screen is the exception,
   * because the invitation names the workspace. Somebody invited to a
   * white-labelled installation should see the company that invited them, not
   * the software it happens to run on.
   */
  markBold: string;
  markLight: string;
  /** They already had an account: no password step. */
  hasAccount: boolean;
  /** Only on the totp step. */
  qr?: string;
  secret?: string;
  minPasswordLength: number;
}

/**
 * Whether this address can already sign in.
 *
 * One rule for both the form and the actions behind it: the page deciding to
 * show a password step and the action deciding to accept a password must not
 * be able to disagree.
 */
function hasUsableLogin(
  user: { passwordHash: string; deletedAt: Date | null } | null,
): boolean {
  return !!user && !user.deletedAt && user.passwordHash !== NO_PASSWORD && user.passwordHash.length > 1;
}

/** A first look, for rendering the form. */
export async function beginAccept(
  token: string,
  now: Date = new Date(),
): Promise<{ ok: true; state: AcceptState } | { ok: false; message: string; canResend: boolean }> {
  const row = await findByToken(token);
  const verdict = acceptVerdict(row, now);
  if (!verdict.ok) {
    return { ok: false, message: verdict.message, canResend: verdict.canResend };
  }
  const invitation = row!;

  const [ws, user] = await Promise.all([
    prismaUnsafe.workspace.findUnique({
      where: { id: invitation.workspaceId },
      select: { name: true, brand: true },
    }),
    prismaUnsafe.user.findUnique({
      where: { email: invitation.email },
      select: { id: true, passwordHash: true, totpEnabled: true, deletedAt: true },
    }),
  ]);
  const brand = brandFrom(ws?.brand);

  const hasAccount = hasUsableLogin(user);
  return {
    ok: true,
    state: {
      // Somebody who already has a login joins from a signed-in session. The
      // old branch sent a 2FA-less account to a "totp" step with no QR code to
      // scan — a dead end — and a 2FA account to "done", which activated
      // nothing.
      step: hasAccount ? "signin" : "password",
      email: invitation.email,
      workspaceName: ws?.name ?? "the workspace",
      markBold: brand.markBold,
      markLight: brand.markLight,
      hasAccount,
      minPasswordLength: MIN_PASSWORD_LENGTH,
    },
  };
}

/**
 * Step one: choose a password, and get an authenticator to set up.
 *
 * The user row is created HERE and not when the invitation was issued. Before
 * this moment nobody has agreed to anything, and putting a person in the
 * database because somebody typed their address is putting a person there who
 * never asked to be.
 */
export async function acceptSetPassword(input: {
  token: string;
  name: string;
  password: string;
  now?: Date;
}): Promise<
  | { ok: true; qr: string; secret: string }
  | { ok: false; error: string }
> {
  const now = input.now ?? new Date();
  const row = await findByToken(input.token);
  const verdict = acceptVerdict(row, now);
  if (!verdict.ok) return { ok: false, error: verdict.message };
  const invitation = row!;

  const problems = validatePassword(input.password);
  if (problems.length > 0) {
    // Every problem at once. A password form that reports one rule at a time
    // is a form somebody submits four times.
    return { ok: false, error: `The password ${problems.map((p) => p.message).join(", and ")}.` };
  }

  /**
   * Never for an account that can already sign in.
   *
   * The invitation URL is shown to the Owner who issued it. Without this check
   * that Owner could post the token here and set a new password — and a new
   * authenticator — on somebody else's existing account: an account takeover
   * by anybody who owns ANY workspace. The form never offers this step to an
   * existing account; the action must not accept it either.
   */
  const existing = await prismaUnsafe.user.findUnique({
    where: { email: invitation.email },
    select: { passwordHash: true, deletedAt: true },
  });
  if (hasUsableLogin(existing)) {
    return { ok: false, error: "You already have an account. Sign in, then accept the invitation." };
  }

  const name = input.name.trim() || nameFromEmail(invitation.email);
  const passwordHash = await hashPassword(input.password);
  const secret = generateTotpSecret();

  const user = await prismaUnsafe.user.upsert({
    where: { email: invitation.email },
    update: {
      name,
      passwordHash,
      mustChangePassword: false,
      // Staged, not enabled: it becomes real when a code verifies below.
      totpSecret: secret,
      totpEnabled: false,
      mustEnrollTotp: false,
    },
    create: {
      email: invitation.email,
      name,
      passwordHash,
      totpSecret: secret,
      totpEnabled: false,
    },
    select: { id: true },
  });

  void user;
  return { ok: true, qr: await totpQrDataUrl(invitation.email, secret), secret };
}

/**
 * Step two: verify a code, and the membership becomes real.
 *
 * The invitation is consumed in the SAME transaction as the membership, so a
 * token cannot be used twice by two tabs racing each other — and a membership
 * cannot exist for an invitation that is still open.
 */
export async function acceptVerifyTotp(input: {
  token: string;
  code: string;
  now?: Date;
}): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  const now = input.now ?? new Date();
  const row = await findByToken(input.token);
  const verdict = acceptVerdict(row, now);
  if (!verdict.ok) return { ok: false, error: verdict.message };
  const invitation = row!;

  const user = await prismaUnsafe.user.findUnique({
    where: { email: invitation.email },
    select: { id: true, totpSecret: true, totpLastStep: true },
  });
  if (!user?.totpSecret) {
    return { ok: false, error: "Start again — no authenticator was set up." };
  }

  const result = verifyTotp(input.code, user.totpSecret, now.getTime(), user.totpLastStep);
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === "replayed"
          ? "That code was already used. Wait for the next one."
          : "That code is not right. Check your authenticator and try again.",
    };
  }

  await activateFromInvitation(invitation, user.id, now, {
    totpEnabled: true,
    totpLastStep: result.step,
    mustEnrollTotp: false,
  });

  return { ok: true, email: invitation.email };
}

type OpenInvitation = NonNullable<Awaited<ReturnType<typeof findByToken>>>;

/**
 * Spend the invitation and make the membership real — one transaction.
 *
 * The invitation is consumed in the SAME transaction as the membership, so a
 * token cannot be used twice by two tabs racing each other, and a membership
 * cannot exist for an invitation that is still open. Shared by both ways in:
 * a new account verifying its first code, and an existing account pressing
 * "Join" from a signed-in session.
 */
async function activateFromInvitation(
  invitation: OpenInvitation,
  userId: string,
  now: Date,
  userData: Record<string, unknown>,
): Promise<void> {
  const isOwner = invitation.role === "OWNER";
  const grants = Array.isArray(invitation.grants) ? (invitation.grants as string[]) : [];

  await prismaUnsafe.$transaction(async (tx) => {
    // Consumed first: whichever tab gets here second finds it accepted and is
    // refused by `acceptVerdict` on its own next call.
    const consumed = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: now },
    });
    if (consumed.count === 0) throw new Error("already-accepted");

    if (Object.keys(userData).length > 0) {
      await tx.user.update({ where: { id: userId }, data: userData });
    }

    await tx.membership.upsert({
      where: { userId_workspaceId: { userId, workspaceId: invitation.workspaceId } },
      update: {
        state: "ACTIVE",
        role: invitation.role,
        // An Owner arriving by invitation gets the full set, the same as one
        // created by `createWorkspace`; anybody else gets the preset.
        grants: (isOwner ? OWNER_GRANTS : grants) as never,
        clientCompanyId: invitation.clientCompanyId,
        suspendedAt: null,
        suspendedBy: null,
        removedAt: null,
        removedBy: null,
      },
      create: {
        userId,
        workspaceId: invitation.workspaceId,
        state: "ACTIVE",
        role: invitation.role,
        grants: (isOwner ? OWNER_GRANTS : grants) as never,
        clientCompanyId: invitation.clientCompanyId,
      },
    });
  });

  await recordMemberEvent({
    workspaceId: invitation.workspaceId,
    userId,
    actorUserId: userId,
    kind: "accepted",
    after: { role: invitation.role, grants },
  });
  // The Owner who invited them finds out without having to check.
  await notifyInvitationAccepted({
    workspaceId: invitation.workspaceId,
    userId,
    inviterId: invitation.invitedBy,
  });
}

/**
 * Somebody who already has a login accepts from a signed-in session.
 *
 * ── WHY A SESSION, NOT JUST THE TOKEN ───────────────────────────────────────
 *
 * For a new person the token is enough, because they then prove themselves by
 * choosing a password and enrolling an authenticator. An existing account has
 * already done both, and asking for them again would be a second password for
 * one person. So the proof is the one they already have: a session, signed in
 * with their own password and code, belonging to the invited address. The token
 * alone, in somebody else's browser, joins nobody to anything.
 *
 * An account without an authenticator joins, and is then sent to enrol on its
 * next click — invitees do not get to skip 2FA by arriving through this door.
 */
export async function acceptAsExistingUser(input: {
  token: string;
  sessionUserId: string;
  now?: Date;
}): Promise<{ ok: true; workspaceId: string } | { ok: false; error: string }> {
  const now = input.now ?? new Date();
  const row = await findByToken(input.token);
  const verdict = acceptVerdict(row, now);
  if (!verdict.ok) return { ok: false, error: verdict.message };
  const invitation = row!;

  const user = await prismaUnsafe.user.findUnique({
    where: { id: input.sessionUserId },
    select: { id: true, email: true, totpEnabled: true, deletedAt: true },
  });
  if (!user || user.deletedAt) return { ok: false, error: "Sign in again, then accept." };
  if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
    return {
      ok: false,
      error: `This invitation is for ${invitation.email}. Sign in as that account to accept it.`,
    };
  }

  try {
    await activateFromInvitation(
      invitation,
      user.id,
      now,
      user.totpEnabled ? {} : { mustEnrollTotp: true },
    );
  } catch (e) {
    if ((e as Error).message === "already-accepted") {
      return { ok: false, error: "This invitation was already used." };
    }
    throw e;
  }
  return { ok: true, workspaceId: invitation.workspaceId };
}
