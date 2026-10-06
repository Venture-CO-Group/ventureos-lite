"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { hasGrant } from "@/lib/authz";
import { BULK_RESTORE_MAX, cancelFollowups, previewRestore, restoreCandidate, type RestoreDeps, type RestorePreview, type RestoreResult } from "./restore";
import { productionRunDeps } from "./run-deps";
import { draftCandidate } from "./draft-engine";

/**
 * History & recovery actions. Behind `outbound.approve`, like the queue: a
 * restore is a second review decision, and it can cost a registry lookup and
 * a Claude call, both budgeted.
 */
type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };
const DENIED = { ok: false as const, error: "You do not have permission to review outbound candidates." };

async function ctx() {
  if (!(await hasGrant("outbound.approve"))) return null;
  return getActiveContext();
}

async function deps(workspaceId: string): Promise<RestoreDeps> {
  const run = await productionRunDeps(workspaceId);
  return { now: () => new Date(), readSite: run.readSite, verify: run.verify, draft: (ws, id) => draftCandidate(ws, id) };
}

function refresh(): void {
  revalidatePath("/outbound");
  revalidatePath("/outbound/history");
}

export async function previewRestoreAction(candidateId: string): Promise<Result<{ preview: RestorePreview }>> {
  const c = await ctx();
  if (!c) return DENIED;
  return { ok: true, preview: await previewRestore(getWorkspaceClient(c.workspaceId), c.workspaceId, candidateId) };
}

const restoreSchema = z.object({ candidateId: z.string().min(1), note: z.string().max(1000).nullish() });

export async function restoreAction(raw: unknown): Promise<Result<{ result: RestoreResult }>> {
  const c = await ctx();
  if (!c) return DENIED;
  const p = restoreSchema.safeParse(raw);
  if (!p.success) return { ok: false, error: "Invalid request." };
  const result = await restoreCandidate(getWorkspaceClient(c.workspaceId), c.workspaceId, { ...p.data, userId: c.userId }, await deps(c.workspaceId));
  refresh();
  return { ok: true, result };
}

/** Capped and confirmed in the UI; each candidate is checked on its own and reported. */
export async function bulkRestoreAction(raw: unknown): Promise<Result<{ results: Array<{ candidateId: string; result: RestoreResult }> }>> {
  const c = await ctx();
  if (!c) return DENIED;
  const p = z.object({ candidateIds: z.array(z.string().min(1)).min(1), note: z.string().max(1000).nullish() }).safeParse(raw);
  if (!p.success) return { ok: false, error: "Select at least one candidate." };
  if (p.data.candidateIds.length > BULK_RESTORE_MAX) {
    return { ok: false, error: `Restore at most ${BULK_RESTORE_MAX} at a time — each one is re-checked and may be redrafted.` };
  }
  const db = getWorkspaceClient(c.workspaceId);
  const d = await deps(c.workspaceId);
  const results: Array<{ candidateId: string; result: RestoreResult }> = [];
  for (const candidateId of p.data.candidateIds) {
    results.push({ candidateId, result: await restoreCandidate(db, c.workspaceId, { candidateId, userId: c.userId, note: p.data.note }, d) });
  }
  refresh();
  return { ok: true, results };
}

export async function cancelFollowupsAction(candidateId: string): Promise<Result<{ cancelled: number }>> {
  const c = await ctx();
  if (!c) return DENIED;
  const r = await cancelFollowups(getWorkspaceClient(c.workspaceId), c.workspaceId, candidateId, c.userId);
  if (r.ok) refresh();
  return r;
}
