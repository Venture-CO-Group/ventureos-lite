"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";
import {
  deleteImportTemplate,
  listImportBatches,
  listImportTemplates,
  rollbackImport,
  runImport,
  saveImportTemplate,
  validateImport,
  type BatchRow,
  type RollbackConflict,
  type TemplateRow,
} from "./store";
import type { ValidationSummary } from "./validate";

/**
 * CSV import v2, session-facing (playbook-v2 P5/3).
 *
 * Every mutation resolves its tenant from the session and goes through the
 * guarded client underneath — an import cannot reach another workspace's rows,
 * and neither can a rollback.
 */

const candidateSchema = z.object({
  contactName: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  email: z.string().max(200).optional(),
  linkedinUrl: z.string().max(500).optional(),
  companyName: z.string().max(200).optional(),
  companyDomain: z.string().max(200).optional(),
  customFields: z.record(z.string().max(2000)).optional(),
});

const MAX_ROWS = 5000;

export async function previewImport(raw: unknown): Promise<ValidationSummary> {
  const parsed = z
    .object({
      candidates: z.array(candidateSchema).max(MAX_ROWS),
      mode: z.enum(["skip", "update"]).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return { rows: [], newCount: 0, updateCount: 0, skipCount: 0, byCode: {} };
  }
  const { workspaceId } = await getActiveContext();
  return validateImport(workspaceId, parsed.data.candidates, { mode: parsed.data.mode });
}

export type CommitResult =
  | { ok: true; batchId: string; created: number; updated: number; skipped: number }
  | { ok: false; error: string };

export async function commitImport(raw: unknown): Promise<CommitResult> {
  const parsed = z
    .object({
      candidates: z.array(candidateSchema).max(MAX_ROWS),
      filename: z.string().max(300).optional(),
      templateId: z.string().min(1).nullable().optional(),
      mode: z.enum(["skip", "update"]).optional(),
      skipIndexes: z.array(z.number().int().min(0)).max(MAX_ROWS).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That import is not valid." };

  const { workspaceId, userId } = await getActiveContext();
  const res = await runImport(workspaceId, userId, parsed.data);

  await getWorkspaceClient(workspaceId).auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "import.run",
      entityType: "ImportBatch",
      entityId: res.batchId,
      meta: {
        filename: parsed.data.filename ?? null,
        created: res.created,
        updated: res.updated,
        skipped: res.skipped,
      },
    },
  });

  revalidatePath("/leads");
  revalidatePath("/settings");
  return { ok: true, ...res };
}

export type RollbackActionResult =
  | { ok: true; deleted: number; reverted: number }
  | { ok: false; error: string; conflicts?: RollbackConflict[] };

/**
 * Roll an import back.
 *
 * OWNER-ONLY, matching the single-lead delete. Running an import is a BDR's
 * ordinary work and stays ungated; a rollback DELETES leads, and "who may
 * delete a lead" is already settled elsewhere in this codebase — having it be
 * one answer on the lead modal and a different one on a batch would be the
 * kind of inconsistency an audit finds later.
 *
 * The conflict checks still hold underneath: an Owner cannot roll back over
 * work either.
 */
export async function rollbackBatch(batchId: string): Promise<RollbackActionResult> {
  try {
    await requireGrant("leads.delete");
  } catch {
    return { ok: false, error: "You need the leads.delete capability to roll an import back." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const res = await rollbackImport(workspaceId, userId, batchId);
  if (!res.ok) return res;

  await getWorkspaceClient(workspaceId).auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "import.rollback",
      entityType: "ImportBatch",
      entityId: batchId,
      meta: { deleted: res.deleted, reverted: res.reverted },
    },
  });

  revalidatePath("/leads");
  revalidatePath("/settings");
  return res;
}

export async function getImportTemplates(): Promise<TemplateRow[]> {
  const { workspaceId } = await getActiveContext();
  return listImportTemplates(workspaceId);
}

export async function saveTemplate(
  raw: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(120),
      source: z.string().trim().max(120).nullable().optional(),
      mapping: z.record(z.number().int().min(0).max(500)),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That template is not valid." };

  const { workspaceId, userId } = await getActiveContext();
  const res = await saveImportTemplate(workspaceId, userId, parsed.data);
  if (res.ok) revalidatePath("/leads");
  return res;
}


