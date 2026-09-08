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
  step: "password" | "totp" | "done";
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

  const hasAccount = !!user && !user.deletedAt && user.passwordHash !== NO_PASSWORD && user.passwordHash.length > 1;
  return {
    ok: true,
    state: {
      // Somebody who already has a login goes straight to the authenticator
      // step if they have not set one up, and straight to done if they have.
      step: hasAccount && user?.totpEnabled ? "done" : hasAccount ? "totp" : "password",
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

    await tx.user.update({
      where: { id: user.id },
      data: { totpEnabled: true, totpLastStep: result.step, mustEnrollTotp: false },
    });

    await tx.membership.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId: invitation.workspaceId } },
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
        userId: user.id,
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
    userId: user.id,
    actorUserId: user.id,
    kind: "accepted",
    after: { role: invitation.role, grants },
  });
  // The Owner who invited them finds out without having to check.
  await notifyInvitationAccepted({
    workspaceId: invitation.workspaceId,
    userId: user.id,
    inviterId: invitation.invitedBy,
  });

  return { ok: true, email: invitation.email };
}
