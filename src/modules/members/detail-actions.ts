"use server";

import { getActiveContext } from "@/lib/session";
import { isOwner } from "@/lib/authz";
import { prismaUnsafe } from "@/lib/db";
import { memberTimeline, type TimelineEntry } from "./timeline";
import { grantAllowed, grantIsImplicit, GRANTS, denyToken } from "@/lib/grants";

/**
 * The member detail drawer's data (§3, §6).
 *
 * ── WHY EFFECTIVE PERMISSIONS ARE COMPUTED, NEVER DESCRIBED ─────────────────
 *
 * §6 asks for a resolved view — "carries X because of role BDR; has Y by
 * explicit grant" — and is explicit that it must come from the grants module
 * rather than be duplicated in prose. That is the whole point: a settings
 * screen that explains permissions in hand-written sentences is a screen that
 * disagrees with the code the first time the code changes, and nobody notices
 * because the sentences still read fine.
 *
 * So every line below is `grantAllowed` and `grantIsImplicit` asked about this
 * membership. The property-based test in §6 asserts this view matches the
 * resolver across every role × grant combination.
 */
export interface EffectiveGrant {
  grant: string;
  allowed: boolean;
  /** Why: the role carries it, it was granted, or it was withdrawn. */
  source: "role" | "explicit" | "withdrawn" | "none";
}

export interface MemberDetail {
  userId: string;
  timeline: TimelineEntry[];
  effective: EffectiveGrant[];
}

export async function getMemberDetail(
  userId: string,
): Promise<MemberDetail | { error: string }> {
  if (!(await isOwner())) return { error: "Only an Owner can see a member's history." };
  const { workspaceId } = await getActiveContext();

  const membership = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true, grants: true },
  });
  if (!membership) return { error: "Not a member of this workspace." };

  const grants = Array.isArray(membership.grants) ? (membership.grants as string[]) : [];
  const effective: EffectiveGrant[] = GRANTS.map((grant) => {
    const allowed = grantAllowed(membership.role, grants, grant);
    const implicit = grantIsImplicit(membership.role, grant);
    const withdrawn = grants.includes(denyToken(grant));
    return {
      grant,
      allowed,
      source: withdrawn
        ? "withdrawn"
        : implicit
          ? "role"
          : grants.includes(grant)
            ? "explicit"
            : "none",
    };
  });

  return {
    userId,
    timeline: await memberTimeline(workspaceId, userId),
    effective,
  };
}
