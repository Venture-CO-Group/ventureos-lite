"use server";

import { getActiveContext } from "@/lib/session";
import { isOwner } from "@/lib/authz";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { accessReview, employeeExport, type AccessReview } from "./access-review";

/**
 * The access review and the employee data export (§7). Owner-only.
 */
export async function getAccessReview(): Promise<AccessReview | { error: string }> {
  if (!(await isOwner())) return { error: "Only an Owner can run an access review." };
  const { workspaceId } = await getActiveContext();
  return accessReview(workspaceId);
}

/**
 * Everything held about somebody as a USER, as a JSON file.
 *
 * Audit-logged, because handing over a person's own data is a disclosure — and
 * a disclosure nobody recorded is one nobody can account for.
 */
export async function exportEmployeeData(
  userId: string,
): Promise<{ ok: true; json: string; filename: string } | { ok: false; error: string }> {
  if (!(await isOwner())) return { ok: false, error: "Only an Owner can export member data." };
  const { workspaceId, userId: actorId } = await getActiveContext();

  const data = await employeeExport(workspaceId, userId);
  if (!data) return { ok: false, error: "No such user." };

  const subject = await prismaUnsafe.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  await getWorkspaceClient(workspaceId).auditLog.create({
    data: {
      workspaceId,
      actorUserId: actorId,
      action: "member.data_exported",
      entityType: "User",
      entityId: userId,
      meta: { email: subject?.email ?? null, sections: Object.keys(data).length },
    },
  });

  return {
    ok: true,
    json: JSON.stringify(data, null, 2),
    filename: `member-data-${(subject?.email ?? userId).replace(/[^a-z0-9.@-]/gi, "_")}.json`,
  };
}
