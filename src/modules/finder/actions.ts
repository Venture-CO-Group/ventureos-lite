"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { hasGrant } from "@/lib/authz";
import { describeCriteria, parseCriteria } from "./criteria";
import { saveList } from "./store";

/**
 * Company Finder list definitions (item 1). Defining and running a list is
 * sales work, so it rides on `settings.manage` like a manual outbound run —
 * a BDR carries it by default and an Owner can withdraw it. Exports have
 * their own grant (`exports.run`), checked where the file is built.
 */
type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

async function gate(): Promise<string | null> {
  return (await hasGrant("settings.manage")) ? null : "You do not have permission to run the Company Finder.";
}

const saveInput = z.object({
  id: z.string().min(1).optional(),
  name: z.string().max(200),
  criteria: z.unknown(),
  cachedOnly: z.boolean().optional(),
});

export async function saveFinderList(raw: unknown): Promise<Result<{ id: string }>> {
  const denied = await gate();
  if (denied) return { ok: false, error: denied };
  const input = saveInput.safeParse(raw);
  if (!input.success) return { ok: false, error: "That list could not be read." };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const res = await saveList(db, workspaceId, input.data, userId);
  if (!res.ok) return res;
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: input.data.id ? "finder.list.updated" : "finder.list.created",
      entityType: "FinderList",
      entityId: res.list.id,
      meta: { name: res.list.name, criteria: describeCriteria(parseCriteria(res.list.criteria)), cachedOnly: res.list.cachedOnly },
    },
  });
  revalidatePath("/finder");
  revalidatePath(`/finder/${res.list.id}`);
  return { ok: true, id: res.list.id };
}

export async function deleteFinderList(id: string): Promise<Result> {
  const denied = await gate();
  if (denied) return { ok: false, error: denied };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const list = await db.finderList.findUnique({ where: { id }, select: { id: true, name: true, status: true } });
  if (!list) return { ok: false, error: "That list no longer exists." };
  if (list.status === "HARVESTING" || list.status === "ENRICHING" || list.status === "CONTACTS") {
    return { ok: false, error: "Stop the run before deleting the list." };
  }
  // Results and runs cascade; the pool and the datasheet cache are shared and stay.
  await db.finderList.delete({ where: { id } });
  await db.auditLog.create({
    data: { workspaceId, actorUserId: userId, action: "finder.list.deleted", entityType: "FinderList", entityId: id, meta: { name: list.name } },
  });
  revalidatePath("/finder");
  return { ok: true };
}
