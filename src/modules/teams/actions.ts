"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { isOwner } from "@/lib/authz";
import { isSafeColor } from "@/modules/workspaces/brand";
import { recordMemberEvent } from "@/modules/members/timeline";
import { listTeams, teamImpact, type TeamView } from "./store";

/**
 * Team management (§5). Owner-gated, like everything in this section.
 *
 * No permission logic here or anywhere in the teams module — authority stays
 * role + grant. See the note at the top of `store.ts`.
 */
async function gate(): Promise<
  { ok: true; workspaceId: string; userId: string } | { ok: false; error: string }
> {
  if (!(await isOwner())) return { ok: false, error: "Only an Owner can manage teams." };
  const { workspaceId, userId } = await getActiveContext();
  return { ok: true, workspaceId, userId };
}

export async function getTeams(): Promise<TeamView[]> {
  if (!(await isOwner())) return [];
  const { workspaceId } = await getActiveContext();
  return listTeams(workspaceId);
}

const teamSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  color: z.string().trim().max(20).optional(),
});

export async function saveTeam(
  raw: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const g = await gate();
  if (!g.ok) return g;
  const parsed = teamSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Give the team a name." };
  const input = parsed.data;
  // Validated before it can reach a style attribute — the same rule the
  // letterhead colours go through.
  const color = input.color && isSafeColor(input.color) ? input.color : null;

  try {
    if (input.id) {
      const existing = await prismaUnsafe.team.findFirst({
        where: { id: input.id, workspaceId: g.workspaceId },
        select: { id: true },
      });
      if (!existing) return { ok: false, error: "That team does not exist." };
      await prismaUnsafe.team.update({
        where: { id: input.id },
        data: { name: input.name, description: input.description || null, color },
      });
      revalidatePath("/settings/admin/members");
      return { ok: true, id: input.id };
    }
    const created = await prismaUnsafe.team.create({
      data: {
        workspaceId: g.workspaceId,
        name: input.name,
        description: input.description || null,
        color,
        createdBy: g.userId,
      },
      select: { id: true },
    });
    revalidatePath("/settings/admin/members");
    return { ok: true, id: created.id };
  } catch (e) {
    // `@@unique([workspaceId, name])`: two teams with one name is two teams
    // nobody can tell apart in a picker.
    if ((e as { code?: string }).code === "P2002") {
      return { ok: false, error: "A team with that name already exists." };
    }
    throw e;
  }
}

export async function setTeamMember(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const g = await gate();
  if (!g.ok) return g;
  const parsed = z
    .object({
      teamId: z.string().min(1),
      userId: z.string().min(1),
      on: z.boolean(),
      isLead: z.boolean().optional(),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the request." };
  const { teamId, userId, on, isLead } = parsed.data;

  const team = await prismaUnsafe.team.findFirst({
    where: { id: teamId, workspaceId: g.workspaceId },
    select: { id: true, name: true, archivedAt: true },
  });
  if (!team) return { ok: false, error: "That team does not exist." };
  if (team.archivedAt && on) {
    return { ok: false, error: "That team is archived. Bring it back first." };
  }

  const membership = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: g.workspaceId } },
    select: { state: true, role: true },
  });
  if (!membership) return { ok: false, error: "Not a member of this workspace." };
  if (on && membership.role === "CLIENT") {
    // A team is a work grouping, and a client account does no work here.
    return { ok: false, error: "A read-only client account is not on a team." };
  }

  if (on) {
    await prismaUnsafe.teamMember.upsert({
      where: { teamId_userId: { teamId, userId } },
      update: { isLead: isLead ?? false },
      create: { workspaceId: g.workspaceId, teamId, userId, isLead: isLead ?? false },
    });
    /**
     * One lead per team.
     *
     * Two leads means an escalation with two destinations, which in practice
     * means neither of them acts. Enforced here rather than by a unique index,
     * because a partial index over `is_lead = true` is Postgres-only and this
     * schema runs on MySQL too.
     */
    if (isLead) {
      await prismaUnsafe.teamMember.updateMany({
        where: { teamId, userId: { not: userId } },
        data: { isLead: false },
      });
    }
  } else {
    await prismaUnsafe.teamMember.deleteMany({ where: { teamId, userId } });
  }

  await recordMemberEvent({
    workspaceId: g.workspaceId,
    userId,
    actorUserId: g.userId,
    kind: on ? "team_joined" : "team_left",
    after: { team: team.name, ...(on && isLead ? { lead: true } : {}) },
  });
  revalidatePath("/settings/admin/members");
  return { ok: true };
}

export async function setTeamArchived(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const g = await gate();
  if (!g.ok) return g;
  const parsed = z
    .object({ teamId: z.string().min(1), archived: z.boolean() })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the request." };

  const team = await prismaUnsafe.team.findFirst({
    where: { id: parsed.data.teamId, workspaceId: g.workspaceId },
    select: { id: true },
  });
  if (!team) return { ok: false, error: "That team does not exist." };

  await prismaUnsafe.team.update({
    where: { id: team.id },
    data: { archivedAt: parsed.data.archived ? new Date() : null },
  });
  revalidatePath("/settings/admin/members");
  return { ok: true };
}

/**
 * Delete a team, but only once nothing points at it (§5).
 *
 * Same impact-report pattern as removing a member. Deleting a team that is
 * still somebody's escalation route would leave that pointing at nothing, and
 * silently — which is the failure mode the whole pattern exists to prevent.
 * Archiving is offered as the answer that always works.
 */
export async function deleteTeam(
  teamId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const g = await gate();
  if (!g.ok) return g;
  const team = await prismaUnsafe.team.findFirst({
    where: { id: teamId, workspaceId: g.workspaceId },
    select: { id: true, name: true },
  });
  if (!team) return { ok: false, error: "That team does not exist." };

  const impact = await teamImpact(g.workspaceId, teamId);
  if (!impact.canDelete) return { ok: false, error: impact.reason ?? "Still in use." };

  await prismaUnsafe.team.delete({ where: { id: team.id } });
  revalidatePath("/settings/admin/members");
  return { ok: true };
}

export async function getTeamImpact(
  teamId: string,
): Promise<{ members: number; canDelete: boolean; reason: string | null } | { error: string }> {
  const g = await gate();
  if (!g.ok) return { error: g.error };
  return teamImpact(g.workspaceId, teamId);
}
