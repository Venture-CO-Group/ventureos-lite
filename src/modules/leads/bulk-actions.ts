"use server";

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Stage } from "@prisma/client";
import { prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant, requireOwner } from "@/lib/authz";
import { autoWatchForStage } from "../audit/watch-actions";
import { cancelFollowups, scheduleFollowups } from "../pipeline/jobs";
import { cancelsFollowups, schedulesFollowups } from "../pipeline/transitions";
import { gateThresholdFromConfig } from "./scoring";
import { filterSetSchema } from "./view-params";
import type { BulkResult } from "./bulk";
import {
  applyOwner,
  applySignals,
  applyStageChange,
  deleteLeadsBulk,
  exportLeadsCsv,
  loadLeadsForExport,
  resolveSelection,
  type StageChangeResult,
} from "./bulk-store";
import type { FilterSet } from "./filters";
import { EXPORT_FORMATS, buildLeadsXlsx } from "./export-formats";
import { enqueueLeadsPdf } from "../audit/enqueue";

/**
 * Bulk-action server actions (playbook-v2 P3/2).
 *
 * The browser sends a list of ids and the server does the rest. Passing ids is
 * safe because every mutation runs through the guarded client, so an id from
 * another workspace simply matches nothing — and because the gates (score,
 * qualification, grants) are re-checked here per lead rather than trusted from
 * whatever the table happened to render.
 *
 * Work arrives in batches from the client (BULK_BATCH_SIZE) so that moving 500
 * leads shows a progress bar instead of one long unexplained wait.
 */

const idsSchema = z.array(z.string().min(1)).max(500);

/**
 * "Select all matching" resolves HERE, from the filter, not from a list the
 * browser assembled. What the filter means is a server-side question.
 */
export async function resolveBulkSelection(rawFilters: unknown): Promise<string[]> {
  const parsed = filterSetSchema.safeParse(rawFilters);
  if (!parsed.success) return [];
  const { workspaceId } = await getActiveContext();
  return resolveSelection(workspaceId, parsed.data as FilterSet);
}

async function threshold(workspaceId: string): Promise<number> {
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { icpConfig: true },
  });
  return gateThresholdFromConfig(ws?.icpConfig);
}

const stageSchema = z.object({
  ids: idsSchema,
  toStage: z.enum([
    "RESEARCHED",
    "CONTACTED",
    "ACCEPTED",
    "REPLIED",
    "QUALIFIED",
    "MEETING_BOOKED",
    "HANDED_OFF",
    "NOT_NOW",
    "DISQUALIFIED",
  ]),
  reason: z.string().optional(),
  wakeUpAt: z.string().optional(),
});

export async function bulkChangeStage(raw: unknown): Promise<BulkResult> {
  const parsed = stageSchema.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const { workspaceId, userId } = await getActiveContext();

  const result: StageChangeResult = await applyStageChange(
    workspaceId,
    userId,
    parsed.data.ids,
    parsed.data.toStage,
    await threshold(workspaceId),
    {
      reason: parsed.data.reason,
      wakeUpAt: parsed.data.wakeUpAt ? new Date(parsed.data.wakeUpAt) : undefined,
    },
  );

  // Task-level automations only, never messaging (CLAUDE.md hard rule #2).
  // Best-effort, exactly as the single-lead path: an automation failing must
  // not undo a move that has already happened.
  const toStage = parsed.data.toStage as Stage;
  for (const lead of result.moved) {
    try {
      await autoWatchForStage(lead.companyId, toStage);
      if (schedulesFollowups(toStage)) await scheduleFollowups(lead.id, workspaceId);
      if (cancelsFollowups(toStage)) await cancelFollowups(lead.id);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[bulk] stage automation failed", lead.id, e);
    }
  }

  revalidatePath("/leads");
  revalidatePath("/pipeline");
  return {
    applied: result.applied,
    skipped: result.skipped,
    undoId: result.undo?.id ?? null,
    undoLabel: result.undo?.label ?? null,
  };
}

const signalsSchema = z.object({
  ids: idsSchema,
  add: z.array(z.string()).max(20).optional(),
  remove: z.array(z.string()).max(20).optional(),
});

export async function bulkEditSignals(raw: unknown): Promise<BulkResult> {
  const parsed = signalsSchema.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const { workspaceId } = await getActiveContext();
  const result = await applySignals(workspaceId, parsed.data.ids, {
    add: parsed.data.add,
    remove: parsed.data.remove,
  });
  revalidatePath("/leads");
  return result;
}

const ownerSchema = z.object({
  ids: idsSchema,
  ownerId: z.string().nullable(),
});

export async function bulkAssignOwner(raw: unknown): Promise<BulkResult> {
  const parsed = ownerSchema.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const { workspaceId } = await getActiveContext();
  const result = await applyOwner(workspaceId, parsed.data.ids, parsed.data.ownerId);
  revalidatePath("/leads");
  return result;
}

/**
 * Deleting is erasure and Owner-only, matching the single-lead path — a bulk
 * delete must not be a weaker second door to the same thing. Audit-logged per
 * lead in the store (CLAUDE.md hard rule #8).
 */
export async function bulkDeleteLeads(
  raw: unknown,
): Promise<BulkResult & { error?: string }> {
  const parsed = idsSchema.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  try {
    await requireOwner();
  } catch {
    return { applied: 0, skipped: [], error: "Only an Owner can delete leads." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const result = await deleteLeadsBulk(workspaceId, userId, parsed.data);
  revalidatePath("/leads");
  revalidatePath("/pipeline");
  return result;
}

const formatExportSchema = z.object({
  ids: idsSchema,
  columns: z.array(z.string()).max(30),
  format: z.enum(EXPORT_FORMATS),
  /** How the selection was described, for the PDF's subtitle line. */
  subtitle: z.string().trim().max(200).optional(),
});



/**
 * Export the selection as a spreadsheet or a branded document.
 *
 * ── WHY ONE ACTION AND NOT THREE ────────────────────────────────────────────
 *
 * The three formats have genuinely different shapes. CSV and XLSX are built
 * here and handed back inline, because they are small and the browser can save
 * them immediately. A PDF needs headless Chrome, which lives only in the worker
 * image — so it is queued, and the caller polls for the file exactly as the
 * audit PDF does.
 *
 * All three are gated on `exports.run` and audit-logged (hard rule #8). This is
 * a route personal data leaves by, and adding two more of them without adding
 * two more log lines would quietly halve what the audit log knows.
 */
export type BulkExportResult =
  | { ok: true; kind: "inline"; filename: string; mime: string; base64: string; rows: number }
  | { ok: true; kind: "queued"; rel: string; rows: number }
  | { ok: false; error: string };

export async function bulkExport(raw: unknown): Promise<BulkExportResult> {
  const parsed = formatExportSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Nothing to export." };
  const { ids, columns, format, subtitle } = parsed.data;

  try {
    await requireGrant("exports.run");
  } catch {
    return { ok: false, error: "You need the exports.run grant to export leads." };
  }

  const { workspaceId, userId } = await getActiveContext();
  const stamp = new Date();
  const date = stamp.toISOString().slice(0, 10);

  await prismaUnsafe.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "export.run",
      meta: { kind: `leads.${format}`, rows: ids.length, columns },
    },
  });

  if (format === "csv") {
    const csv = await exportLeadsCsv(workspaceId, ids, columns);
    return {
      ok: true,
      kind: "inline",
      filename: `leads-${date}.csv`,
      mime: "text/csv;charset=utf-8",
      // The BOM goes on HERE rather than in the browser, so every caller of
      // this action gets a file Hungarian Excel reads correctly.
      base64: Buffer.from("\ufeff" + csv, "utf8").toString("base64"),
      rows: ids.length,
    };
  }

  if (format === "xlsx") {
    const { leads, customFields } = await loadLeadsForExport(workspaceId, ids);
    const ws = await prismaUnsafe.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true },
    });
    const buf = await buildLeadsXlsx(leads, columns, customFields, {
      workspaceName: ws?.name ?? "Leads",
      exportedAt: stamp,
    });
    return {
      ok: true,
      kind: "inline",
      filename: `leads-${date}.xlsx`,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64: buf.toString("base64"),
      rows: ids.length,
    };
  }

  // PDF — queued, because Chromium is worker-only.
  const user = await prismaUnsafe.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });
  const rel = `exports/${workspaceId}-leads-${stamp.getTime()}.pdf`;
  await enqueueLeadsPdf({
    workspaceId,
    rel,
    ids,
    columns,
    meta: {
      subtitle: subtitle ?? `${ids.length} lead${ids.length === 1 ? "" : "s"}`,
      exportedAt: stamp.toISOString(),
      exportedBy: user?.name ?? "",
    },
  });
  return { ok: true, kind: "queued", rel, rows: ids.length };
}

/**
 * Has the queued PDF landed yet?
 *
 * The path is re-derived from the session's workspace rather than trusted from
 * the client: `rel` comes back to us as a string, and a string a browser can
 * edit must never become a filesystem read on another tenant's export.
 */
export async function exportReady(rel: string): Promise<{ ready: boolean }> {
  const { workspaceId } = await getActiveContext();
  if (!rel.startsWith(`exports/${workspaceId}-leads-`) || rel.includes("..")) {
    return { ready: false };
  }
  try {
    await stat(join(process.env.FILES_DIR ?? "/data/files", rel));
    return { ready: true };
  } catch {
    return { ready: false };
  }
}
