"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { isOwner } from "@/lib/authz";
import { revokeAllUserSessions } from "@/lib/auth/sessions";
import { recordMemberEvent } from "./timeline";
import { liveOwnerCount } from "./directory";
import { canTransition } from "./lifecycle";
import { resendInvitation } from "./invitation-store";

/**
 * Bulk actions on members (§3).
 *
 * ── THE RULE THIS FILE IS BUILT AROUND ──────────────────────────────────────
 *
 * **A bulk operation must never partially apply silently.**
 *
 * So every row gets its own attempt and its own line in the result, and the
 * caller renders all of them. The failure this prevents is specific: select
 * twelve people, change their role, and have three of them refused for
 * reasons nobody sees — the table refreshes, nine rows changed, and the person
 * who pressed the button believes twelve did.
 *
 * Sequential, in batches, and never inside one transaction. A transaction
 * would make it all-or-nothing, which sounds safer and is worse here: one
 * refusal — the last Owner, say — would silently undo eleven legitimate
 * changes, and the report would have to say "nothing happened" for reasons
 * that applied to one row.
 */
const BATCH = 25;

export interface BulkRowResult {
  userId: string;
  email: string;
  ok: boolean;
  error?: string;
}

export interface BulkMemberResult {
  results: BulkRowResult[];
  changed: number;
  refused: number;
}

async function gate(): Promise<
  { ok: true; workspaceId: string; userId: string } | { ok: false; error: string }
> {
  if (!(await isOwner())) return { ok: false, error: "Only an Owner can manage members." };
  const { workspaceId, userId } = await getActiveContext();
  return { ok: true, workspaceId, userId };
}

const schema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(200),
  action: z.enum(["role", "suspend", "reinstate", "team", "resend"]),
  role: z.enum(["OWNER", "ADMIN", "BDR"]).optional(),
  teamId: z.string().min(1).optional(),
  reason: z.string().trim().max(500).optional(),
});

export async function bulkMemberAction(
  raw: unknown,
): Promise<{ ok: true; result: BulkMemberResult } | { ok: false; error: string }> {
  const g = await gate();
  if (!g.ok) return g;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the selection and the action." };
  const { userIds, action, role, teamId } = parsed.data;

  if (action === "role" && !role) return { ok: false, error: "Pick a role." };
  if (action === "team" && !teamId) return { ok: false, error: "Pick a team." };

  const unique = [...new Set(userIds)];
  const members = await prismaUnsafe.membership.findMany({
    where: { workspaceId: g.workspaceId, userId: { in: unique } },
    include: { user: { select: { id: true, email: true } } },
  });
  const byUser = new Map(members.map((m) => [m.userId, m]));

  const result: BulkMemberResult = { results: [], changed: 0, refused: 0 };

  for (let i = 0; i < unique.length; i += BATCH) {
    for (const id of unique.slice(i, i + BATCH)) {
      const m = byUser.get(id);
      if (!m) {
        result.results.push({
          userId: id,
          email: id,
          ok: false,
          error: "Not a member of this workspace.",
        });
        result.refused += 1;
        continue;
      }
      const row = await applyOne({
        workspaceId: g.workspaceId,
        actorUserId: g.userId,
        membership: m,
        action,
        role,
        teamId,
        reason: parsed.data.reason ?? null,
      });
      result.results.push(row);
      if (row.ok) result.changed += 1;
      else result.refused += 1;
    }
  }

  revalidatePath("/settings/admin/members");
  revalidatePath("/", "layout");
  return { ok: true, result };
}

type MembershipRow = {
  userId: string;
  role: string;
  state: string;
  grants: unknown;
  user: { id: string; email: string };
};

/**
 * One row, with every refusal the single-member path would give.
 *
 * Deliberately the same rules rather than a relaxed bulk variant. A bulk
 * action that can do something the individual action refuses is a way around
 * the individual action.
 */
async function applyOne(input: {
  workspaceId: string;
  actorUserId: string;
  membership: MembershipRow;
  action: "role" | "suspend" | "reinstate" | "team" | "resend";
  role?: string;
  teamId?: string;
  reason: string | null;
}): Promise<BulkRowResult> {
  const { membership: m, workspaceId, actorUserId } = input;
  const base = { userId: m.userId, email: m.user.email };

  try {
    if (input.action === "role") {
      if (m.userId === actorUserId) {
        return { ...base, ok: false, error: "You cannot change your own role." };
      }
      if (m.role === "CLIENT") {
        // A client account is scoped to one company, which this cannot express.
        return { ...base, ok: false, error: "Client access is changed one at a time." };
      }
      if (input.role !== "OWNER" && (await liveOwnerCount(workspaceId, m.userId)) === 0) {
        return {
          ...base,
          ok: false,
          error: "This is the last Owner — promote somebody else first.",
        };
      }
      if (m.role === input.role) return { ...base, ok: true };

      await prismaUnsafe.membership.update({
        where: { userId_workspaceId: { userId: m.userId, workspaceId } },
        data: { role: input.role as never },
      });
      // A role change has to bite now, in both directions.
      const revoked = await revokeAllUserSessions(m.userId);
      await recordMemberEvent({
        workspaceId,
        userId: m.userId,
        actorUserId,
        kind: "role_changed",
        reason: input.reason,
        before: { role: m.role },
        after: { role: input.role },
        meta: { sessionsRevoked: revoked, bulk: true },
      });
      return { ...base, ok: true };
    }

    if (input.action === "suspend") {
      if (m.userId === actorUserId) {
        return { ...base, ok: false, error: "You cannot suspend yourself." };
      }
      if (!canTransition(m.state, "SUSPENDED")) {
        return {
          ...base,
          ok: false,
          error:
            m.state === "INVITED"
              ? "Nothing to suspend — revoke the invitation instead."
              : `Cannot suspend from ${m.state}.`,
        };
      }
      if (m.role === "OWNER" && (await liveOwnerCount(workspaceId, m.userId)) === 0) {
        return { ...base, ok: false, error: "This is the last Owner." };
      }
      await prismaUnsafe.membership.update({
        where: { userId_workspaceId: { userId: m.userId, workspaceId } },
        data: {
          state: "SUSPENDED",
          suspendedAt: new Date(),
          suspendedBy: actorUserId,
          // Stored so reinstating gives back exactly what they had (§4).
          suspendedRole: m.role as never,
          suspendedGrants: (m.grants ?? []) as never,
        },
      });
      const revoked = await revokeAllUserSessions(m.userId);
      await recordMemberEvent({
        workspaceId,
        userId: m.userId,
        actorUserId,
        kind: "suspended",
        reason: input.reason,
        before: { state: m.state, role: m.role },
        after: { state: "SUSPENDED" },
        meta: { sessionsRevoked: revoked, bulk: true },
      });
      return { ...base, ok: true };
    }

    if (input.action === "reinstate") {
      if (!canTransition(m.state, "ACTIVE")) {
        return {
          ...base,
          ok: false,
          error:
            m.state === "REMOVED"
              ? "They were removed — invite them again instead."
              : `Cannot reinstate from ${m.state}.`,
        };
      }
      const stored = await prismaUnsafe.membership.findUnique({
        where: { userId_workspaceId: { userId: m.userId, workspaceId } },
        select: { suspendedRole: true, suspendedGrants: true },
      });
      await prismaUnsafe.membership.update({
        where: { userId_workspaceId: { userId: m.userId, workspaceId } },
        data: {
          state: "ACTIVE",
          // Exactly what they had. Recomputing from the role would silently
          // drop every explicit grant and every explicit withdrawal.
          role: (stored?.suspendedRole ?? m.role) as never,
          ...(stored?.suspendedGrants ? { grants: stored.suspendedGrants as never } : {}),
          suspendedAt: null,
          suspendedBy: null,
          suspendedRole: null,
          suspendedGrants: undefined,
        },
      });
      await recordMemberEvent({
        workspaceId,
        userId: m.userId,
        actorUserId,
        kind: "reinstated",
        before: { state: m.state },
        after: { state: "ACTIVE", role: stored?.suspendedRole ?? m.role },
        meta: { bulk: true },
      });
      return { ...base, ok: true };
    }

    if (input.action === "team") {
      if (m.role === "CLIENT") {
        return { ...base, ok: false, error: "A client account is not on a team." };
      }
      const team = await prismaUnsafe.team.findFirst({
        where: { id: input.teamId, workspaceId, archivedAt: null },
        select: { id: true, name: true },
      });
      if (!team) return { ...base, ok: false, error: "That team does not exist." };

      const existing = await prismaUnsafe.teamMember.findUnique({
        where: { teamId_userId: { teamId: team.id, userId: m.userId } },
        select: { id: true },
      });
      if (existing) return { ...base, ok: true };

      await prismaUnsafe.teamMember.create({
        data: { workspaceId, teamId: team.id, userId: m.userId },
      });
      await recordMemberEvent({
        workspaceId,
        userId: m.userId,
        actorUserId,
        kind: "team_joined",
        after: { team: team.name },
        meta: { bulk: true },
      });
      return { ...base, ok: true };
    }

    // resend
    const invitation = await prismaUnsafe.invitation.findFirst({
      where: { workspaceId, email: m.user.email, acceptedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!invitation) {
      return { ...base, ok: false, error: "No outstanding invitation to resend." };
    }
    const res = await resendInvitation({
      workspaceId,
      actorUserId,
      invitationId: invitation.id,
    });
    return res.ok ? { ...base, ok: true } : { ...base, ok: false, error: res.error };
  } catch (e) {
    // One row failing must not take the rest of the batch with it.
    return { ...base, ok: false, error: (e as Error).message };
  }
}
