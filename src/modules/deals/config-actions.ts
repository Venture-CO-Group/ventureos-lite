"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prismaUnsafe } from "@/lib/db";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";

/**
 * The forecast's commit/upside split point (playbook-v2 P4/c).
 *
 * Owner-only and audited: it does not change any number in the pipeline, but it
 * changes which half of the forecast a board pack calls "committed", and that
 * is exactly the kind of quiet reclassification worth a log entry.
 */
export async function setCommitThreshold(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z.number().int().min(0).max(100).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "The threshold must be between 0 and 100." };

  try {
    await requireGrant("settings.manage");
  } catch {
    return { ok: false, error: "You need the settings.manage capability to change the commit threshold." };
  }

  const { workspaceId, userId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { dealsConfig: true },
  });
  const cfg =
    ws?.dealsConfig && typeof ws.dealsConfig === "object" && !Array.isArray(ws.dealsConfig)
      ? (ws.dealsConfig as Record<string, unknown>)
      : {};

  await prismaUnsafe.workspace.update({
    where: { id: workspaceId },
    data: { dealsConfig: { ...cfg, commitThreshold: parsed.data } },
  });

  await getWorkspaceClient(workspaceId).auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "deals.commit_threshold",
      entityType: "Workspace",
      entityId: workspaceId,
      meta: { from: cfg.commitThreshold ?? null, to: parsed.data },
    },
  });

  revalidatePath("/analytics");
  return { ok: true };
}
