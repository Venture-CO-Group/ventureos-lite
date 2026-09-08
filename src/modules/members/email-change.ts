import { createHash } from "node:crypto";
import { prismaUnsafe } from "@/lib/db";
import { revokeAllUserSessions } from "@/lib/auth/sessions";
import { recordMemberEvent } from "./timeline";

/**
 * Confirming a staged email change (§4).
 *
 * A plain module, not `"use server"`, for the same reason `invitation-store`
 * is: this runs on a PUBLIC route with no session, and importing it from the
 * Owner-gated actions file would drag Auth.js into every caller — including
 * the tests, which cannot load it.
 */
export function hashEmailToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Confirm it. Public — the token is the credential.
 *
 * Every session is revoked on success: the sign-in identity has changed, and a
 * session minted against the old one is a session whose subject no longer
 * exists in the form it was issued for.
 */
export async function confirmEmailChangeToken(
  token: string,
): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  if (!token || token.length < 16) return { ok: false, error: "This link is not valid." };
  const row = await prismaUnsafe.emailChange.findUnique({
    where: { tokenHash: hashEmailToken(token) },
  });
  // A cancelled link and one nobody issued give the same answer, for the same
  // reason a revoked invitation does.
  if (!row || row.cancelledAt || row.confirmedAt) {
    return { ok: false, error: "This link is not valid." };
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "This link has expired. Ask for a new one." };
  }
  const clash = await prismaUnsafe.user.findUnique({
    where: { email: row.newEmail },
    select: { id: true },
  });
  if (clash) return { ok: false, error: "Another account has taken that address since." };

  const user = await prismaUnsafe.user.findUnique({
    where: { id: row.userId },
    select: { email: true },
  });
  await prismaUnsafe.$transaction([
    prismaUnsafe.user.update({ where: { id: row.userId }, data: { email: row.newEmail } }),
    prismaUnsafe.emailChange.update({
      where: { id: row.id },
      data: { confirmedAt: new Date() },
    }),
  ]);
  await revokeAllUserSessions(row.userId);

  const memberships = await prismaUnsafe.membership.findMany({
    where: { userId: row.userId },
    select: { workspaceId: true },
  });
  for (const m of memberships) {
    await recordMemberEvent({
      workspaceId: m.workspaceId,
      userId: row.userId,
      actorUserId: null,
      kind: "email_changed",
      before: { email: user?.email ?? null },
      after: { email: row.newEmail },
    });
  }
  return { ok: true, email: row.newEmail };
}

