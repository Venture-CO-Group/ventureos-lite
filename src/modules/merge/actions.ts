"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant, GrantError } from "@/lib/authz";
import {
  listDuplicateCandidates,
  listMergeHistory,
  mergeRecords,
  previewMerge,
  revertMerge,
  type MergeEntity,
  type MergeHistoryRow,
  type MergePreview,
} from "./store";
import type { DuplicateCandidate } from "./detect";
import { listImportBatches, type BatchRow } from "@/modules/import/store";

/**
 * Merge, session-facing (playbook-v2 P5/2).
 *
 * Grant-gated on `data.merge` and audit-logged both ways (CLAUDE.md hard rules
 * #7 and #8). A merge is not a typo-level mistake to make — it moves every
 * activity, document and deal off one record onto another — so both the doing
 * and the undoing leave a trail with the field choices in it.
 */

async function requireMergeGrant(): Promise<string | null> {
  try {
    await requireGrant("data.merge");
    return null;
  } catch (e) {
    return e instanceof GrantError
      ? "Only an Owner (or a user granted data.merge) can merge records."
      : "Could not check your permissions.";
  }
}

export interface DataQualityView {
  companies: DuplicateCandidate[];
  leads: DuplicateCandidate[];
  history: MergeHistoryRow[];
  /** Import batches and their rollback windows (P5/3) — same screen, same job. */
  batches: BatchRow[];
  canMerge: boolean;
  /** Owner-only, matching the single-lead delete (P5/3). */
  canRollback: boolean;
}

export async function getDataQuality(): Promise<DataQualityView> {
  const { workspaceId } = await getActiveContext();
  const [{ companies, leads }, history, batches] = await Promise.all([
    listDuplicateCandidates(workspaceId),
    listMergeHistory(workspaceId),
    listImportBatches(workspaceId),
  ]);
  let owner = false;
  try {
    await requireGrant("data.merge");
    owner = true;
  } catch {
    owner = false;
  }
  return {
    companies,
    leads,
    history,
    batches,
    canMerge: (await requireMergeGrant()) === null,
    canRollback: owner,
  };
}

export async function getMergePreview(raw: unknown): Promise<
  { ok: true; preview: MergePreview } | { ok: false; error: string }
> {
  const parsed = z
    .object({
      entity: z.enum(["company", "lead"]),
      survivorId: z.string().min(1),
      loserId: z.string().min(1),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown records." };

  const { workspaceId } = await getActiveContext();
  return previewMerge(
    workspaceId,
    parsed.data.entity as MergeEntity,
    parsed.data.survivorId,
    parsed.data.loserId,
  );
}

export type MergeActionResult =
  | { ok: true; mergeId: string; moved: Record<string, number> }
  | { ok: false; error: string };

export async function performMerge(raw: unknown): Promise<MergeActionResult> {
  const parsed = z
    .object({
      entity: z.enum(["company", "lead"]),
      survivorId: z.string().min(1),
      loserId: z.string().min(1),
      choices: z.record(z.enum(["survivor", "loser"])).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That merge is not valid." };

  const denied = await requireMergeGrant();
  if (denied) return { ok: false, error: denied };

  const { workspaceId, userId } = await getActiveContext();
  const res = await mergeRecords(workspaceId, userId, {
    entity: parsed.data.entity as MergeEntity,
    survivorId: parsed.data.survivorId,
    loserId: parsed.data.loserId,
    choices: parsed.data.choices,
  });
  if (!res.ok) return res;

  await getWorkspaceClient(workspaceId).auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "data.merge",
      entityType: parsed.data.entity === "company" ? "Company" : "Lead",
      entityId: parsed.data.survivorId,
      meta: {
        loserId: parsed.data.loserId,
        mergeId: res.mergeId,
        moved: res.moved,
        choices: parsed.data.choices ?? null,
      },
    },
  });

  revalidatePath("/settings");
  revalidatePath("/leads");
  revalidatePath("/deals");
  return res;
}

export async function undoMerge(
  mergeId: string,
): Promise<{ ok: true; restored: number } | { ok: false; error: string }> {
  const denied = await requireMergeGrant();
  if (denied) return { ok: false, error: denied };

  const { workspaceId, userId } = await getActiveContext();
  const res = await revertMerge(workspaceId, userId, mergeId);
  if (!res.ok) return res;

  await getWorkspaceClient(workspaceId).auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "data.merge_reverted",
      entityType: "MergeRecord",
      entityId: mergeId,
      meta: { restored: res.restored },
    },
  });

  revalidatePath("/settings");
  revalidatePath("/leads");
  return res;
}

/**
 * The "possible duplicate" banner for one lead (P5/2).
 *
 * Computed on demand rather than stored: a duplicate is a relationship between
 * two rows, and a stored flag on one of them goes stale the moment the other is
 * edited.
 */
export async function duplicatesForLead(leadId: string): Promise<
  Array<{ id: string; label: string; detail: string; confidence: number }>
> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const { leads } = await listDuplicateCandidates(workspaceId);
  const pairs = leads.filter((c) => c.aId === leadId || c.bId === leadId);
  if (pairs.length === 0) return [];

  const otherIds = pairs.map((c) => (c.aId === leadId ? c.bId : c.aId));
  const others = await db.lead.findMany({
    where: { id: { in: otherIds } },
    select: { id: true, contactName: true, email: true },
  });
  const byId = new Map(others.map((o) => [o.id, o]));

  return pairs.map((c) => {
    const otherId = c.aId === leadId ? c.bId : c.aId;
    const other = byId.get(otherId);
    return {
      id: otherId,
      label: other?.contactName ?? other?.email ?? "(unnamed lead)",
      detail: c.detail,
      confidence: c.confidence,
    };
  });
}
