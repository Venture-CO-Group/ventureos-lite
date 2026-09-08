"use server";

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { isOwner } from "@/lib/authz";
import { appLink } from "@/lib/public-links";
import { verifyPassword } from "@/lib/auth/password";
import { verifyTotp } from "@/lib/auth/totp";
import { revokeAllUserSessions } from "@/lib/auth/sessions";
import { OWNER_GRANTS } from "@/lib/grants";
import { getMailProvider } from "../mail/provider";
import { brandEmail, brandEmailText } from "../mail/layout";
import { resolveSendingIdentity } from "../mail/identity";
import { brandFrom } from "../workspaces/brand";
import { recordMemberEvent } from "./timeline";
import { hashEmailToken } from "./email-change";
import { liveOwnerCount } from "./directory";
import { roleDiff } from "./role-diff";
import { canTransition } from "./lifecycle";
import { impactOf, executeRemoval, type ImpactReport } from "./removal";
import type { RemovalPlan } from "./removal";

/**
 * The member administration actions (§4).
 *
 * Owner-only, every one of them, and every one writes to the timeline through
 * `recordMemberEvent` — which cannot write a timeline entry without an audit
 * entry. That is the ground rule for this section, enforced by the shape of
 * the helper rather than by remembering to call two things.
 */
async function gate(): Promise<
  { ok: true; workspaceId: string; userId: string } | { ok: false; error: string }
> {
  if (!(await isOwner())) return { ok: false, error: "Only an Owner can manage members." };
  const { workspaceId, userId } = await getActiveContext();
  return { ok: true, workspaceId, userId };
}

async function memberOf(workspaceId: string, userId: string) {
  return prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    include: {
      user: { select: { id: true, email: true, name: true, jobTitle: true, phone: true, timezone: true, locale: true } },
    },
  });
}

// ---------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------

const profileSchema = z.object({
  userId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  jobTitle: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  timezone: z.string().trim().max(60).nullable().optional(),
  locale: z.string().trim().max(10).nullable().optional(),
});

export async function updateMemberProfile(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const g = await gate();
  if (!g.ok) return g;
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the details." };
  const input = parsed.data;

  const m = await memberOf(g.workspaceId, input.userId);
  if (!m) return { ok: false, error: "Not a member of this workspace." };

  /**
   * An IANA zone, checked rather than trusted.
   *
   * The start-of-day digest reads this to decide when somebody's morning is;
   * an unparseable value there degrades to UTC, which is a digest arriving at
   * the wrong hour every day with nothing to explain it.
   */
  if (input.timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
    } catch {
      return { ok: false, error: "That is not a timezone name (try Europe/Budapest)." };
    }
  }

  const before = {
    name: m.user.name,
    jobTitle: m.user.jobTitle,
    phone: m.user.phone,
    timezone: m.user.timezone,
    locale: m.user.locale,
  };
  const after = {
    name: input.name,
    jobTitle: input.jobTitle ?? null,
    phone: input.phone ?? null,
    timezone: input.timezone ?? null,
    locale: input.locale ?? null,
  };
  await prismaUnsafe.user.update({ where: { id: input.userId }, data: after });

  await recordMemberEvent({
    workspaceId: g.workspaceId,
    userId: input.userId,
    actorUserId: g.userId,
    kind: "profile_changed",
    before,
    after,
  });
  revalidatePath("/settings/admin/members");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// email change — staged, verified, and never silent (§4)
// ---------------------------------------------------------------------------

/**
 * Start an email change.
 *
 * ── WHY IT IS NOT AN UPDATE ─────────────────────────────────────────────────
 *
 * The email IS the sign-in identity, so a typo locks somebody out of their own
 * account — and nobody discovers the typo until they next try to sign in. So
 * the change is staged, a link goes to the NEW address, and `users.email` is
 * untouched until somebody clicks it.
 *
 * Both addresses are told. The new one gets the link; the OLD one gets a
 * warning, which is the only thing that catches an attacker who has a session
 * and is moving the account to an address they control.
 */
export async function requestMemberEmailChange(
  raw: unknown,
): Promise<{ ok: true; sentTo: string } | { ok: false; error: string }> {
  const g = await gate();
  if (!g.ok) return g;
  const parsed = z
    .object({ userId: z.string().min(1), newEmail: z.string().trim().email().max(200) })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the new address." };

  const newEmail = parsed.data.newEmail.toLowerCase();
  const m = await memberOf(g.workspaceId, parsed.data.userId);
  if (!m) return { ok: false, error: "Not a member of this workspace." };
  if (m.user.email === newEmail) return { ok: false, error: "That is already their address." };

  const clash = await prismaUnsafe.user.findUnique({
    where: { email: newEmail },
    select: { id: true },
  });
  if (clash) return { ok: false, error: "Another account already uses that address." };

  // Any earlier pending change is cancelled: two live links to two addresses
  // is an account with two possible futures.
  await prismaUnsafe.emailChange.updateMany({
    where: { userId: m.userId, confirmedAt: null, cancelledAt: null },
    data: { cancelledAt: new Date() },
  });

  const token = randomBytes(32).toString("base64url");
  await prismaUnsafe.emailChange.create({
    data: {
      userId: m.userId,
      newEmail,
      tokenHash: hashEmailToken(token),
      // A day: long enough to find the mail, short enough to be a credential.
      expiresAt: new Date(Date.now() + 86_400_000),
      requestedBy: g.userId,
    },
  });

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: g.workspaceId },
    select: { name: true, mailgunConfig: true, brand: true },
  });
  const brand = brandFrom(ws?.brand);
  const identity = resolveSendingIdentity(ws?.mailgunConfig, brand);
  const senderName = ws?.name?.trim() || brand.name;
  const provider = getMailProvider();
  const link = appLink(`/verify-email/${token}`);

  const toNew = {
    preheader: "Kattints a megerősítéshez",
    heading: "Erősítsd meg az új e-mail-címed",
    paragraphs: [
      `Szia ${m.user.name}!`,
      `A ${senderName} munkaterületen valaki erre a címre állítja át a belépési e-mail-címedet. A megerősítésig a régi cím működik.`,
      "A link 24 órán belül lejár.",
    ],
    button: { label: "Megerősítem", url: link },
    footNote: "Ha nem te kérted, hagyd figyelmen kívül — semmi nem változik.",
    brand,
  };
  const toOld = {
    preheader: "Változik a belépési címed",
    heading: "Valaki átállítja a belépési e-mail-címedet",
    paragraphs: [
      `Szia ${m.user.name}!`,
      `A ${senderName} munkaterületen a belépési e-mail-címedet erre állítanák át: ${newEmail}. A megerősítésig ez a cím működik.`,
      "Ha nem te kérted, azonnal szólj a munkaterület Ownerének.",
    ],
    footNote: "Ez a levél tájékoztatás — nincs benne teendő.",
    brand,
  };

  try {
    await provider.send({
      domain: identity.domain,
      to: newEmail,
      from: identity.from,
      subject: `Erősítsd meg az új e-mail-címed — ${senderName}`,
      html: brandEmail(toNew),
      text: brandEmailText(toNew),
    });
    // Best-effort on the old address: the change is already staged and the
    // link is already out, so failing here must not leave a half state.
    await provider
      .send({
        domain: identity.domain,
        to: m.user.email,
        from: identity.from,
        subject: `Változik a belépési címed — ${senderName}`,
        html: brandEmail(toOld),
        text: brandEmailText(toOld),
      })
      .catch(() => {});
  } catch (e) {
    return { ok: false, error: `A megerősítő levél nem ment ki: ${(e as Error).message}` };
  }

  await recordMemberEvent({
    workspaceId: g.workspaceId,
    userId: m.userId,
    actorUserId: g.userId,
    kind: "email_change_requested",
    before: { email: m.user.email },
    after: { email: newEmail },
  });
  revalidatePath("/settings/admin/members");
  return { ok: true, sentTo: newEmail };
}

/*
 * There is deliberately no `confirmEmailChange` wrapper here.
 *
 * The confirm path lives in `email-change.ts` and the public verify route
 * calls it directly. A wrapper in this file would be dead code — which the
 * reachability test caught within a minute of my writing one — and worse, it
 * would drag this module's Auth.js import into an unauthenticated route.
 */

// ---------------------------------------------------------------------------
// 2FA reset — reason mandatory (§4)
// ---------------------------------------------------------------------------

/**
 * Clear somebody's authenticator.
 *
 * ── WHY THE REASON IS NOT OPTIONAL ──────────────────────────────────────────
 *
 * This is the classic social-engineering target: "hi, it's Anna, I lost my
 * phone, can you reset my 2FA". The defence is not technical — it is that
 * whoever does it has to write down who asked and how they satisfied
 * themselves it was really them, and know that it goes on a record with their
 * name on it.
 */
export async function resetMemberTotp(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const g = await gate();
  if (!g.ok) return g;
  const parsed = z
    .object({ userId: z.string().min(1), reason: z.string().trim().min(10).max(500) })
    .safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Say who asked and how you know it was them — at least ten characters.",
    };
  }
  const m = await memberOf(g.workspaceId, parsed.data.userId);
  if (!m) return { ok: false, error: "Not a member of this workspace." };

  await prismaUnsafe.user.update({
    where: { id: m.userId },
    data: {
      totpSecret: null,
      totpEnabled: false,
      totpLastStep: null,
      // The shell redirects on this until they register a new one.
      mustEnrollTotp: true,
    },
  });
  const revoked = await revokeAllUserSessions(m.userId);

  // They are told, by email, on the address that is still theirs. An
  // authenticator reset nobody mentioned to them is the attack succeeding
  // quietly.
  try {
    const ws = await prismaUnsafe.workspace.findUnique({
      where: { id: g.workspaceId },
      select: { name: true, mailgunConfig: true, brand: true },
    });
    const brand = brandFrom(ws?.brand);
    const identity = resolveSendingIdentity(ws?.mailgunConfig, brand);
    const senderName = ws?.name?.trim() || brand.name;
    const content = {
      preheader: "A kétlépcsős azonosítód alaphelyzetbe került",
      heading: "Újra be kell állítanod a kétlépcsős azonosítást",
      paragraphs: [
        `Szia ${m.user.name}!`,
        `A ${senderName} munkaterületen egy Owner alaphelyzetbe állította a kétlépcsős azonosításodat. A következő belépésnél új hitelesítőt kell beállítanod.`,
        "Ha nem te kérted, azonnal szólj — valaki más kérte a nevedben.",
      ],
      footNote: "Minden eszközödről kiléptettünk.",
      brand,
    };
    await getMailProvider().send({
      domain: identity.domain,
      to: m.user.email,
      from: identity.from,
      subject: `Kétlépcsős azonosítás alaphelyzetbe — ${senderName}`,
      html: brandEmail(content),
      text: brandEmailText(content),
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[members] could not notify on 2FA reset", e);
  }

  await recordMemberEvent({
    workspaceId: g.workspaceId,
    userId: m.userId,
    actorUserId: g.userId,
    kind: "totp_reset",
    reason: parsed.data.reason.trim(),
    meta: { sessionsRevoked: revoked },
  });
  revalidatePath("/settings/admin/members");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// role change, with the preview (§4)
// ---------------------------------------------------------------------------

export async function previewRoleChange(
  raw: unknown,
): Promise<
  | { ok: true; gains: string[]; loses: string[]; identical: boolean }
  | { ok: false; error: string }
> {
  const g = await gate();
  if (!g.ok) return g;
  const parsed = z
    .object({ userId: z.string().min(1), role: z.enum(["OWNER", "ADMIN", "BDR", "CLIENT"]) })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown role." };

  const m = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId: parsed.data.userId, workspaceId: g.workspaceId } },
    select: { role: true, grants: true },
  });
  if (!m) return { ok: false, error: "Not a member of this workspace." };

  // Computed from the grants model, never described. The whole requirement.
  const diff = roleDiff({
    fromRole: m.role,
    toRole: parsed.data.role,
    grants: Array.isArray(m.grants) ? (m.grants as string[]) : [],
  });
  return { ok: true, gains: diff.gains, loses: diff.loses, identical: diff.identical };
}

// ---------------------------------------------------------------------------
// suspend and reinstate, single member (§4)
// ---------------------------------------------------------------------------

export async function setMemberSuspended(
  raw: unknown,
): Promise<{ ok: true; revoked: number } | { ok: false; error: string }> {
  const g = await gate();
  if (!g.ok) return g;
  const parsed = z
    .object({
      userId: z.string().min(1),
      suspended: z.boolean(),
      reason: z.string().trim().max(500).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the request." };
  const { userId, suspended } = parsed.data;

  if (userId === g.userId) {
    return { ok: false, error: "You cannot suspend yourself. Transfer ownership first." };
  }
  const m = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: g.workspaceId } },
    select: { role: true, state: true, grants: true, suspendedRole: true, suspendedGrants: true },
  });
  if (!m) return { ok: false, error: "Not a member of this workspace." };

  const target = suspended ? "SUSPENDED" : "ACTIVE";
  if (!canTransition(m.state, target)) {
    return {
      ok: false,
      error:
        m.state === "INVITED"
          ? "Nothing to suspend — revoke the invitation instead."
          : m.state === "REMOVED"
            ? "They were removed. Invite them again instead."
            : `Cannot go from ${m.state} to ${target}.`,
    };
  }
  if (suspended && m.role === "OWNER" && (await liveOwnerCount(g.workspaceId, userId)) === 0) {
    return {
      ok: false,
      error: "This is the last Owner who can sign in. Transfer ownership first.",
    };
  }

  await prismaUnsafe.membership.update({
    where: { userId_workspaceId: { userId, workspaceId: g.workspaceId } },
    data: suspended
      ? {
          state: "SUSPENDED",
          suspendedAt: new Date(),
          suspendedBy: g.userId,
          // Exactly what they had, so reinstating gives it back.
          suspendedRole: m.role,
          suspendedGrants: (m.grants ?? []) as never,
        }
      : {
          state: "ACTIVE",
          role: m.suspendedRole ?? m.role,
          ...(m.suspendedGrants ? { grants: m.suspendedGrants as never } : {}),
          suspendedAt: null,
          suspendedBy: null,
          suspendedRole: null,
          suspendedGrants: undefined,
        },
  });
  const revoked = suspended ? await revokeAllUserSessions(userId) : 0;

  await recordMemberEvent({
    workspaceId: g.workspaceId,
    userId,
    actorUserId: g.userId,
    kind: suspended ? "suspended" : "reinstated",
    reason: parsed.data.reason ?? null,
    before: { state: m.state, role: m.role },
    after: { state: target, role: suspended ? m.role : (m.suspendedRole ?? m.role) },
    meta: { sessionsRevoked: revoked },
  });
  revalidatePath("/settings/admin/members");
  revalidatePath("/", "layout");
  return { ok: true, revoked };
}

// ---------------------------------------------------------------------------
// removal (§4)
// ---------------------------------------------------------------------------

export async function getRemovalImpact(
  userId: string,
): Promise<ImpactReport | { error: string }> {
  const g = await gate();
  if (!g.ok) return { error: g.error };
  const impact = await impactOf(g.workspaceId, userId);
  return impact ?? { error: "Not a member of this workspace." };
}

export async function removeMemberFromWorkspace(
  raw: unknown,
): Promise<
  { ok: true; moved: Record<string, number> } | { ok: false; error: string; problems?: string[] }
> {
  const g = await gate();
  if (!g.ok) return g;
  const parsed = z
    .object({
      userId: z.string().min(1),
      /** Typed by hand, and it has to match. */
      confirmName: z.string().trim().min(1),
      reason: z.string().trim().min(1).max(500),
      plan: z.record(z.string(), z.unknown()),
      disconnectMail: z.boolean().default(true),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the form." };

  const m = await memberOf(g.workspaceId, parsed.data.userId);
  if (!m) return { ok: false, error: "Not a member of this workspace." };

  /**
   * The typed confirmation, checked on the SERVER.
   *
   * Checking it only in the browser would make it decoration: the action is
   * reachable by anybody who can post to it, and this is the last thing
   * standing between a mis-click and somebody's book changing hands.
   */
  if (parsed.data.confirmName.toLowerCase() !== m.user.name.toLowerCase()) {
    return { ok: false, error: `Type “${m.user.name}” exactly to confirm.` };
  }

  const res = await executeRemoval({
    workspaceId: g.workspaceId,
    actorUserId: g.userId,
    userId: parsed.data.userId,
    plan: parsed.data.plan as RemovalPlan,
    reason: parsed.data.reason,
    disconnectMail: parsed.data.disconnectMail,
  });
  if (!res.ok) return res;

  revalidatePath("/settings/admin/members");
  revalidatePath("/", "layout");
  return { ok: true, moved: res.moved };
}

// ---------------------------------------------------------------------------
// ownership transfer (§4)
// ---------------------------------------------------------------------------

/**
 * Hand the workspace over.
 *
 * ── WHY THIS ASKS FOR A PASSWORD AND A CODE ─────────────────────────────────
 *
 * It is irreversible without the new Owner's consent, and it is the one action
 * that can lock the person taking it out of their own workspace. A session is
 * not enough proof for that: a borrowed laptop is a session. So it re-checks
 * the password and the second factor, which is the same bar a bank puts on
 * moving money.
 */
export async function transferOwnership(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const g = await gate();
  if (!g.ok) return g;
  const parsed = z
    .object({
      toUserId: z.string().min(1),
      password: z.string().min(1).max(200),
      code: z.string().trim().max(20),
      reason: z.string().trim().min(1).max(500),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the form." };
  if (parsed.data.toUserId === g.userId) {
    return { ok: false, error: "They are already the Owner." };
  }

  const me = await prismaUnsafe.user.findUnique({
    where: { id: g.userId },
    select: { passwordHash: true, totpSecret: true, totpEnabled: true, totpLastStep: true },
  });
  if (!me) return { ok: false, error: "Sign in again." };
  if (!(await verifyPassword(parsed.data.password, me.passwordHash))) {
    return { ok: false, error: "That password is not right." };
  }
  if (me.totpEnabled) {
    if (!me.totpSecret) return { ok: false, error: "Register an authenticator first." };
    const v = verifyTotp(parsed.data.code, me.totpSecret, Date.now(), me.totpLastStep);
    if (!v.ok) return { ok: false, error: "That six-digit code is not right." };
    await prismaUnsafe.user.update({
      where: { id: g.userId },
      data: { totpLastStep: v.step },
    });
  }

  const target = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId: parsed.data.toUserId, workspaceId: g.workspaceId } },
    include: { user: { select: { email: true, name: true } } },
  });
  if (!target || target.state !== "ACTIVE") {
    return { ok: false, error: "Pick somebody who is an active member." };
  }
  if (target.role === "CLIENT") {
    return { ok: false, error: "A read-only client account cannot own a workspace." };
  }

  await prismaUnsafe.$transaction([
    // The new Owner gets the full grant set, the same as one created by
    // `createWorkspace` — an Owner with a partial set is an Owner who cannot
    // do their job.
    prismaUnsafe.membership.update({
      where: { userId_workspaceId: { userId: target.userId, workspaceId: g.workspaceId } },
      data: { role: "OWNER", grants: OWNER_GRANTS as never },
    }),
    // Demoted, not removed: they stay an Admin so the handover is a change of
    // authority rather than a loss of access.
    prismaUnsafe.membership.update({
      where: { userId_workspaceId: { userId: g.userId, workspaceId: g.workspaceId } },
      data: { role: "ADMIN" },
    }),
  ]);

  for (const [userId, note] of [
    [target.userId, "You are now the Owner of this workspace."],
    [g.userId, "You are no longer the Owner of this workspace."],
  ] as const) {
    await recordMemberEvent({
      workspaceId: g.workspaceId,
      userId,
      actorUserId: g.userId,
      kind: "ownership_transferred",
      reason: parsed.data.reason,
      after: { note, role: userId === target.userId ? "OWNER" : "ADMIN" },
    });
  }

  revalidatePath("/settings/admin/members");
  revalidatePath("/", "layout");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// account deletion, with a grace period (§4)
// ---------------------------------------------------------------------------

/**
 * Schedule an account for deletion.
 *
 * Only when they have no membership anywhere — an account still in a workspace
 * is somebody's colleague, and the way to end that is to remove the
 * membership. And not immediately: thirty days, restorable, because deleting a
 * person is the one action in this product with no undo, so it gets one.
 */
export async function deleteUserAccount(
  raw: unknown,
): Promise<{ ok: true; purgeAfter: string } | { ok: false; error: string }> {
  const g = await gate();
  if (!g.ok) return g;
  const parsed = z
    .object({ userId: z.string().min(1), reason: z.string().trim().min(1).max(500) })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Say why." };
  if (parsed.data.userId === g.userId) {
    return { ok: false, error: "You cannot delete your own account." };
  }

  const live = await prismaUnsafe.membership.count({
    where: { userId: parsed.data.userId, state: { in: ["INVITED", "ACTIVE", "SUSPENDED"] } },
  });
  if (live > 0) {
    return {
      ok: false,
      error: `They are still in ${live} workspace(s). Remove them from each first.`,
    };
  }

  const purgeAfter = new Date(Date.now() + 30 * 86_400_000);
  await prismaUnsafe.user.update({
    where: { id: parsed.data.userId },
    data: { deletedAt: new Date(), purgeAfter },
  });
  await revokeAllUserSessions(parsed.data.userId);

  await recordMemberEvent({
    workspaceId: g.workspaceId,
    userId: parsed.data.userId,
    actorUserId: g.userId,
    kind: "account_deleted",
    reason: parsed.data.reason,
    after: { purgeAfter: purgeAfter.toISOString() },
  });
  revalidatePath("/settings/admin/members");
  return { ok: true, purgeAfter: purgeAfter.toISOString() };
}

export async function restoreUserAccount(
  userId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const g = await gate();
  if (!g.ok) return g;
  const user = await prismaUnsafe.user.findUnique({
    where: { id: userId },
    select: { deletedAt: true, purgeAfter: true },
  });
  if (!user?.deletedAt) return { ok: false, error: "That account is not scheduled for deletion." };
  if (user.purgeAfter && user.purgeAfter.getTime() < Date.now()) {
    return { ok: false, error: "The grace period has passed — the data is gone." };
  }
  await prismaUnsafe.user.update({
    where: { id: userId },
    data: { deletedAt: null, purgeAfter: null },
  });
  await recordMemberEvent({
    workspaceId: g.workspaceId,
    userId,
    actorUserId: g.userId,
    kind: "account_restored",
  });
  revalidatePath("/settings/admin/members");
  return { ok: true };
}
