"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { hasGrant } from "@/lib/authz";
import { parseCsv } from "@/modules/leads/csv";
import type { ProspectRow } from "@/modules/prospector/types";
import { searchRegistry } from "@/modules/registry/registry-service";
import { createRun, estimateRunCost, loadRunDetail, type RunDetail, type RunEstimate } from "./run-store";
import { enqueueRunPass } from "./run-jobs";
import { addPlacesToPool, harvestSegment, poolRowsFromCsv, upsertPool } from "./sources";
import { loadSegments } from "./segments";

/**
 * Sourcing runs by hand, and the pool's manual inputs (playbook-v6 F3/8).
 *
 * A manual run spends registry quota, so it needs `settings.manage` — which a
 * BDR carries — and the pre-run estimate must be confirmed: the action
 * refuses a start without the estimate the person saw.
 */
type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

const CHANNELS = ["all", "NAME_HARVEST", "SEED_LIST", "PLACES", "CSV"] as const;
const runInput = z.object({
  profileId: z.string().min(1),
  requested: z.number().int().min(1).max(200),
  channel: z.enum(CHANNELS),
});

async function gate(): Promise<string | null> {
  return (await hasGrant("settings.manage")) ? null : "You do not have permission to run the outbound motor.";
}

export async function estimateRun(raw: unknown): Promise<Result<{ estimate: RunEstimate }>> {
  const parsed = runInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Pick a profile, a channel and how many candidates." };
  const { workspaceId } = await getActiveContext();
  const estimate = await estimateRunCost(getWorkspaceClient(workspaceId), workspaceId, parsed.data);
  if (!estimate) return { ok: false, error: "That profile no longer exists." };
  return { ok: true, estimate };
}

export async function startManualRun(raw: unknown): Promise<Result<{ runId: string }>> {
  const denied = await gate();
  if (denied) return { ok: false, error: denied };
  const parsed = runInput.extend({ confirmedLookups: z.number().int().min(0) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Confirm the estimate before starting the run." };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const estimate = await estimateRunCost(db, workspaceId, parsed.data);
  if (!estimate) return { ok: false, error: "That profile no longer exists." };
  // The estimate moved since the person saw it (a nightly run spent quota,
  // the pool grew): ask again rather than start on numbers they did not see.
  if (estimate.expectedLookups > parsed.data.confirmedLookups) {
    return { ok: false, error: `The estimate changed to ${estimate.expectedLookups} lookups — review it again.` };
  }
  const run = await createRun(db, workspaceId, {
    ...parsed.data,
    trigger: "MANUAL",
    estimate,
    startedById: userId,
  });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "outbound.run.started",
      entityType: "SourcingRun",
      entityId: run.id,
      meta: { ...parsed.data, expectedLookups: estimate.expectedLookups },
    },
  });
  await enqueueRunPass({ workspaceId, runId: run.id });
  revalidatePath("/outbound/runs");
  return { ok: true, runId: run.id };
}

export async function cancelRun(runId: string): Promise<Result> {
  const denied = await gate();
  if (denied) return { ok: false, error: denied };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const run = await db.sourcingRun.findUnique({ where: { id: runId }, select: { status: true } });
  if (!run) return { ok: false, error: "That run no longer exists." };
  if (run.status === "DONE" || run.status === "FAILED" || run.status === "CANCELLED") {
    return { ok: false, error: "That run has already finished." };
  }
  await db.sourcingRun.update({
    where: { id: runId },
    data: { status: "CANCELLED", finishedAt: new Date(), message: "Cancelled by hand." },
  });
  await db.auditLog.create({
    data: { workspaceId, actorUserId: userId, action: "outbound.run.cancelled", entityType: "SourcingRun", entityId: runId },
  });
  revalidatePath("/outbound/runs");
  return { ok: true };
}

export async function getRunDetail(runId: string): Promise<RunDetail | null> {
  const { workspaceId } = await getActiveContext();
  return loadRunDetail(getWorkspaceClient(workspaceId), runId);
}

// ---- pool inputs ------------------------------------------------------------

const csvInput = z.object({
  segmentKey: z.string().min(1),
  csv: z.string().min(1).max(5_000_000),
  mapping: z.object({
    name: z.number().int().min(0),
    taxNumber: z.number().int().min(0).nullable().optional(),
    website: z.number().int().min(0).nullable().optional(),
    city: z.number().int().min(0).nullable().optional(),
    phone: z.number().int().min(0).nullable().optional(),
  }),
});

/** Header row of a CSV, so the mapping can be picked before importing. */
export async function previewPoolCsv(csv: string): Promise<Result<{ headers: string[]; rows: number }>> {
  const parsed = parseCsv(csv);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, headers: parsed.data.headers, rows: parsed.data.rows.length };
}

export async function importPoolCsv(raw: unknown): Promise<Result<{ created: number; updated: number; skipped: Array<{ row: number; reason: string }> }>> {
  const denied = await gate();
  if (denied) return { ok: false, error: denied };
  const input = csvInput.safeParse(raw);
  if (!input.success) return { ok: false, error: "Pick a segment and map at least the company-name column." };
  const parsed = parseCsv(input.data.csv);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const segments = await loadSegments(db, workspaceId);
  if (!segments.some((s) => s.key === input.data.segmentKey)) return { ok: false, error: "Unknown segment." };
  const { rows, skipped } = poolRowsFromCsv(parsed.data.rows, input.data.mapping, input.data.segmentKey);
  const res = await upsertPool(db, workspaceId, "CSV", rows, new Date());
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "outbound.pool.imported",
      entityType: "CandidatePool",
      meta: { segmentKey: input.data.segmentKey, created: res.created, updated: res.updated, skipped: skipped.length },
    },
  });
  revalidatePath("/outbound/runs");
  return { ok: true, ...res, skipped };
}

/** Rows the Prospector already paid Places for, into the pool. No new spend. */
export async function addSearchToPool(raw: unknown): Promise<Result<{ created: number; updated: number }>> {
  const denied = await gate();
  if (denied) return { ok: false, error: denied };
  const input = z.object({ searchId: z.string().min(1), segmentKey: z.string().min(1) }).safeParse(raw);
  if (!input.success) return { ok: false, error: "Pick a saved search and a segment." };
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const search = await db.prospectSearch.findUnique({ where: { id: input.data.searchId } });
  if (!search) return { ok: false, error: "That search no longer exists." };
  const rows = (search.results as ProspectRow[] | null) ?? [];
  const res = await addPlacesToPool(db, workspaceId, input.data.segmentKey, rows, new Date());
  revalidatePath("/outbound/runs");
  return { ok: true, ...res };
}

/** A harvest by hand — free, bounded, and the same code the run uses. */
export async function harvestNow(segmentKey: string): Promise<Result<{ created: number; updated: number; errors: string[] }>> {
  const denied = await gate();
  if (denied) return { ok: false, error: denied };
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const segment = (await loadSegments(db, workspaceId)).find((s) => s.key === segmentKey);
  if (!segment) return { ok: false, error: "Unknown segment." };
  const now = new Date();
  const report = await harvestSegment(
    db,
    workspaceId,
    segment,
    {
      search: (p) => searchRegistry(workspaceId, p, { now }),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now,
    },
    { maxPagesPerFragment: 1 },
  );
  revalidatePath("/outbound/segments");
  return { ok: true, created: report.created, updated: report.updated, errors: report.errors };
}
