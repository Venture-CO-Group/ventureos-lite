"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { hasGrant } from "@/lib/authz";
import { hasSource, parseCriteria } from "./criteria";
import { createFinderRun, estimateEnrichment, resumeFinderRun, stopFinderRun, type EnrichmentEstimate } from "./engine";
import { enqueueFinderJob } from "./jobs";

/**
 * Running a list (item 2). Phase 1 is free and needs only the list. Phase 2
 * spends quota, so — exactly like a manual outbound run — it refuses to start
 * without the estimate the person confirmed, and refuses again if the
 * estimate has grown since they saw it.
 */
type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

async function gate(): Promise<string | null> {
  return (await hasGrant("settings.manage")) ? null : "You do not have permission to run the Company Finder.";
}

const BUSY = ["HARVESTING", "ENRICHING", "CONTACTS"];

export async function startHarvest(listId: string): Promise<Result> {
  const denied = await gate();
  if (denied) return { ok: false, error: denied };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const list = await db.finderList.findUnique({ where: { id: listId } });
  if (!list) return { ok: false, error: "That list no longer exists." };
  if (BUSY.includes(list.status)) return { ok: false, error: "The list is already running." };
  if (!list.cachedOnly && !hasSource(parseCriteria(list.criteria))) {
    return { ok: false, error: "Pick a segment or add a keyword first — there is nothing to harvest." };
  }
  await db.finderList.update({ where: { id: listId }, data: { status: "HARVESTING", message: null } });
  await db.auditLog.create({
    data: { workspaceId, actorUserId: userId, action: "finder.harvest.started", entityType: "FinderList", entityId: listId, meta: { cachedOnly: list.cachedOnly } },
  });
  await enqueueFinderJob({ kind: "harvest", workspaceId, listId });
  revalidatePath(`/finder/${listId}`);
  return { ok: true };
}

const lookupsInput = z.object({ listId: z.string().min(1), maxLookups: z.number().int().min(1).max(100_000) });

export async function estimatePhase2(raw: unknown): Promise<Result<{ estimate: EnrichmentEstimate }>> {
  const input = lookupsInput.safeParse(raw);
  if (!input.success) return { ok: false, error: "Set how many lookups this run may spend." };
  const { workspaceId } = await getActiveContext();
  const list = await getWorkspaceClient(workspaceId).finderList.findUnique({ where: { id: input.data.listId }, select: { id: true } });
  if (!list) return { ok: false, error: "That list no longer exists." };
  return { ok: true, estimate: await estimateEnrichment(workspaceId, input.data.listId, input.data.maxLookups) };
}

export async function startPhase2(raw: unknown): Promise<Result<{ runId: string }>> {
  const denied = await gate();
  if (denied) return { ok: false, error: denied };
  const input = lookupsInput.extend({ confirmedLookups: z.number().int().min(0) }).safeParse(raw);
  if (!input.success) return { ok: false, error: "Confirm the estimate before starting." };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const list = await db.finderList.findUnique({ where: { id: input.data.listId } });
  if (!list) return { ok: false, error: "That list no longer exists." };
  if (list.cachedOnly) return { ok: false, error: "This list runs on cached datasheets only — it never spends lookups." };
  if (BUSY.includes(list.status)) return { ok: false, error: "The list is already running." };
  const open = await db.finderRun.findFirst({ where: { listId: list.id, status: { in: ["RUNNING", "CHECKPOINT", "PAUSED_QUOTA"] } } });
  if (open) return { ok: false, error: "This list has a paused run — continue or stop it first." };
  const estimate = await estimateEnrichment(workspaceId, list.id, input.data.maxLookups);
  if (estimate.expected > input.data.confirmedLookups) {
    return { ok: false, error: `The estimate changed to ${estimate.expected} lookups — review it again.` };
  }
  if (estimate.pending === 0) return { ok: false, error: "Nothing is waiting for a lookup — run phase 1 first." };
  const run = await createFinderRun(db, workspaceId, { listId: list.id, maxLookups: input.data.maxLookups, estimate, userId });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "finder.run.started",
      entityType: "FinderRun",
      entityId: run.id,
      meta: { listId: list.id, maxLookups: input.data.maxLookups, expected: estimate.expected, monthRemaining: estimate.monthRemaining },
    },
  });
  await enqueueFinderJob({ kind: "pass", workspaceId, runId: run.id });
  revalidatePath(`/finder/${list.id}`);
  return { ok: true, runId: run.id };
}

/** Continue past the first-batch checkpoint, or resume a quota-paused run. */
export async function continueFinderRun(runId: string): Promise<Result> {
  const denied = await gate();
  if (denied) return { ok: false, error: denied };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const res = await resumeFinderRun(db, runId);
  if (!res.ok) return { ok: false, error: res.error ?? "Could not continue." };
  await db.auditLog.create({ data: { workspaceId, actorUserId: userId, action: "finder.run.continued", entityType: "FinderRun", entityId: runId } });
  // A fresh attempt counter would collide with the pass ids already used; a
  // timestamped attempt keeps the id unique without losing the dedupe.
  await enqueueFinderJob({ kind: "pass", workspaceId, runId, attempt: Date.now() });
  revalidatePath(`/finder/${res.listId}`);
  return { ok: true };
}

export async function stopRun(runId: string): Promise<Result> {
  const denied = await gate();
  if (denied) return { ok: false, error: denied };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const res = await stopFinderRun(db, runId);
  if (!res.ok) return { ok: false, error: res.error ?? "Could not stop." };
  await db.auditLog.create({ data: { workspaceId, actorUserId: userId, action: "finder.run.stopped", entityType: "FinderRun", entityId: runId } });
  revalidatePath("/finder");
  return { ok: true };
}
