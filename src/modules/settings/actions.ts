"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireOwner } from "@/lib/authz";
import { GRANTS, denyToken, grantIsImplicit } from "@/lib/grants";
import { recordMemberEvent } from "@/modules/members/timeline";

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: string;
  grants: string[];
}

export async function listMembers(): Promise<Member[]> {
  const { workspaceId } = await getActiveContext();
  const rows = await prismaUnsafe.membership.findMany({
    where: { workspaceId },
    include: { user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((m) => ({
    userId: m.userId,
    name: m.user.name,
    email: m.user.email,
    role: m.role,
    grants: Array.isArray(m.grants) ? (m.grants as string[]) : [],
  }));
}

const setSchema = z.object({
  userId: z.string().min(1),
  grant: z.string().min(1),
  enabled: z.boolean(),
  /**
   * Why, optionally (§6).
   *
   * Optional on purpose. A mandatory field on an action somebody takes twenty
   * times while setting up a workspace is a field that gets filled with "x",
   * and a trail of "x" is worse than a trail of blanks — it looks like a
   * reason. The three actions where it IS mandatory are listed in
   * `members/events.ts`, and a capability change is not one of them.
   */
  reason: z.string().trim().max(500).optional(),
});

/** Grant changes are Owner-only and audit-logged (CLAUDE.md hard rules #7, #8). */
export async function setGrant(raw: unknown): Promise<{ ok: true }> {
  const input = setSchema.parse(raw);
  if (!(GRANTS as readonly string[]).includes(input.grant)) {
    throw new Error(`Unknown grant: ${input.grant}`);
  }
  await requireOwner();
  const { workspaceId, userId: actorId } = await getActiveContext();

  const m = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId: input.userId, workspaceId } },
    select: { id: true, role: true, grants: true },
  });
  if (!m) throw new Error("Membership not found");

  /**
   * Turning something OFF has to be recorded, not merely un-recorded.
   *
   * The array used to mean only "additionally allowed", so removing an entry
   * was the whole of "off" — which worked while every grant was opt-in. Now a
   * BDR carries most capabilities by default, and deleting an entry that was
   * never there does nothing at all. A `!`-prefixed entry says withdrawn, and
   * `grantAllowed` honours it above the role.
   */
  const set = new Set(Array.isArray(m.grants) ? (m.grants as string[]) : []);
  const deny = denyToken(input.grant);
  if (input.enabled) {
    set.delete(deny);
    // An implicit capability needs no positive entry; adding one is noise that
    // would survive a later role change and quietly re-grant it.
    if (!grantIsImplicit(m.role, input.grant)) set.add(input.grant);
  } else {
    set.delete(input.grant);
    if (grantIsImplicit(m.role, input.grant)) set.add(deny);
  }
  const next = [...set];

  await prismaUnsafe.membership.update({ where: { id: m.id }, data: { grants: next } });

  const db = getWorkspaceClient(workspaceId);
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: actorId,
      action: "grant.change",
      entityType: "Membership",
      entityId: m.id,
      meta: {
        userId: input.userId,
        grant: input.grant,
        enabled: input.enabled,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    },
  });

  /**
   * And on the person's own timeline (§1, §6).
   *
   * The audit log answers "what happened in this workspace"; the timeline
   * answers "what happened to me", which is the question asked when somebody
   * says "I used to be able to do that". Before this, a capability change was
   * only in the log — filtered, paged, and Owner-gated — so the answer existed
   * but nobody could find it.
   */
  await recordMemberEvent({
    workspaceId,
    userId: input.userId,
    actorUserId: actorId,
    kind: input.enabled ? "grant_added" : "grant_removed",
    reason: input.reason ?? null,
    before: { grants: Array.isArray(m.grants) ? m.grants : [] },
    after: { grants: next, grant: input.grant },
  });

  revalidatePath("/settings");
  revalidatePath("/settings/admin/members");
  return { ok: true };
}
