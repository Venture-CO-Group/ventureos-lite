"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { hasGrant } from "@/lib/authz";
import { onLeadCreated } from "@/modules/workflow/triggers";
import { emitLeadCreated } from "@/modules/webhooks/emit";
import { addResultsAsLeads, sendResultsToOutbound, suppressResults } from "./results-ops";

/** Row and bulk actions on Company Finder results (item 5). */
type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

const idsInput = z.object({ listId: z.string().min(1), ids: z.array(z.string().min(1)).min(1).max(5000) });

async function gate(): Promise<string | null> {
  return (await hasGrant("settings.manage")) ? null : "You do not have permission to act on Company Finder results.";
}

export async function finderAddLeads(raw: unknown): Promise<Result<{ created: number; skipped: number; firstSkip: string | null }>> {
  const denied = await gate();
  if (denied) return { ok: false, error: denied };
  const input = idsInput.safeParse(raw);
  if (!input.success) return { ok: false, error: "Select at least one company." };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const res = await addResultsAsLeads(db, workspaceId, input.data.listId, input.data.ids, {
    onCreated: async (leadId) => {
      await onLeadCreated(workspaceId, leadId);
      await emitLeadCreated(workspaceId, leadId);
    },
  });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "finder.results.leads",
      entityType: "FinderList",
      entityId: input.data.listId,
      meta: { selected: input.data.ids.length, created: res.created, skipped: res.skipped.length },
    },
  });
  revalidatePath(`/finder/${input.data.listId}`);
  revalidatePath("/leads");
  return {
    ok: true,
    created: res.created,
    skipped: res.skipped.length,
    firstSkip: res.skipped[0] ? `${res.skipped[0].name}: ${res.skipped[0].reason}` : null,
  };
}

export async function finderSendToOutbound(raw: unknown): Promise<Result<{ created: number; updated: number }>> {
  const denied = await gate();
  if (denied) return { ok: false, error: denied };
  const input = idsInput.extend({ profileId: z.string().min(1) }).safeParse(raw);
  if (!input.success) return { ok: false, error: "Pick a product profile and at least one company." };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const res = await sendResultsToOutbound(db, workspaceId, input.data.listId, input.data.ids, input.data.profileId);
  if (!res.ok) return res;
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "finder.results.outbound",
      entityType: "FinderList",
      entityId: input.data.listId,
      meta: { profileId: input.data.profileId, segmentKey: res.segmentKey, created: res.created, updated: res.updated },
    },
  });
  revalidatePath("/outbound/runs");
  return { ok: true, created: res.created, updated: res.updated };
}

export async function finderSuppress(raw: unknown): Promise<Result<{ added: number }>> {
  const denied = await gate();
  if (denied) return { ok: false, error: denied };
  const input = idsInput.safeParse(raw);
  if (!input.success) return { ok: false, error: "Select at least one company." };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const res = await suppressResults(db, workspaceId, input.data.listId, input.data.ids);
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "finder.results.suppressed",
      entityType: "FinderList",
      entityId: input.data.listId,
      meta: { selected: input.data.ids.length, added: res.added },
    },
  });
  revalidatePath(`/finder/${input.data.listId}`);
  return { ok: true, added: res.added };
}
