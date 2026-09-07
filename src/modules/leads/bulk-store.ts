/**
 * Carrying out bulk actions (playbook-v2 P3/2).
 *
 * Takes the workspace and actor explicitly so the rules can be proved against a
 * real database; `bulk-actions.ts` is the "use server" layer that supplies them
 * from the session and checks the grants.
 *
 * EVERY read and write here goes through the guarded client, so a lead id from
 * another workspace is not refused so much as invisible: it never comes back
 * from the initial fetch, so nothing downstream can act on it. That is why the
 * cross-tenant tests assert "nothing happened" rather than "an error was
 * raised" — there is nothing to raise an error about.
 *
 * Deliberately imports nothing that resolves a session or touches Redis. The
 * follow-up and audit-watch automations therefore run in `bulk-actions.ts`,
 * which has a request context; `applyStageChange` reports which leads moved so
 * that layer knows what to run them for.
 */

import type { Stage } from "@prisma/client";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { listFieldDefsWith } from "@/modules/fields/store";
import { readValues } from "@/modules/fields/types";
import { recordUndo, type UndoToken } from "@/modules/undo/store";
import { eraseLeadData } from "@/modules/gdpr/erase";
import { canQualify, type Qualification } from "../inbox/qualification";
import { requiresReason } from "../pipeline/transitions";
import { applyFilters, type FilterSet } from "./filters";
import {
  addSignals,
  buildLeadsCsv,
  planStageChange,
  type BulkResult,
  type CsvLead,
  type SkippedLead,
} from "./bulk";
import { removeSignals } from "./bulk";
import { matchingLeadIds } from "./table";

/** Ids matching a filter, computed server-side — the browser does not choose. */
export async function resolveSelection(
  workspaceId: string,
  filters: FilterSet,
  now: Date = new Date(),
): Promise<string[]> {
  return matchingLeadIds(workspaceId, filters, now);
}

// ---- stage --------------------------------------------------------------

export interface StageChangeResult extends BulkResult {
  /** The leads that actually moved, for the caller to run automations on. */
  moved: Array<{ id: string; companyId: string | null }>;
  /** The toast's undo handle (P7/2). Null when nothing moved. */
  undo?: UndoToken | null;
}

export async function applyStageChange(
  workspaceId: string,
  userId: string,
  ids: string[],
  toStage: string,
  threshold: number,
  opts: { reason?: string; wakeUpAt?: Date } = {},
): Promise<StageChangeResult> {
  if (ids.length === 0) return { applied: 0, skipped: [], moved: [] };
  const db = getWorkspaceClient(workspaceId);

  const rows = await db.lead.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      icpScore: true,
      stage: true,
      qualification: true,
      companyId: true,
      // Captured for the undo's inverse, before the update overwrites them.
      stageEnteredAt: true,
      stageReason: true,
      wakeUpAt: true,
    },
  });

  // A reason is required to disqualify (spec §4.5) — the same rule as the
  // single-lead path, reported per lead rather than as one failed request.
  if (requiresReason(toStage as Stage) && !opts.reason?.trim()) {
    return {
      applied: 0,
      moved: [],
      skipped: rows.map((r) => ({ id: r.id, reason: "a reason is required to disqualify" })),
    };
  }

  const plan = planStageChange(rows, toStage, threshold);
  const skipped: SkippedLead[] = [...plan.skipped];

  // Qualification unlocks at 3 of 4 (spec §4.7) — also per lead.
  let allowed = plan.allowed;
  if (toStage === "QUALIFIED") {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const passing: string[] = [];
    for (const id of allowed) {
      const q = byId.get(id)?.qualification as Partial<Qualification> | null;
      if (canQualify(q)) passing.push(id);
      else skipped.push({ id, reason: "fewer than 3 of 4 qualification answers" });
    }
    allowed = passing;
  }

  if (allowed.length === 0) return { applied: 0, skipped, moved: [] };

  const now = new Date();
  await db.lead.updateMany({
    where: { id: { in: allowed } },
    data: {
      stage: toStage as Stage,
      stageEnteredAt: now,
      stageReason: opts.reason ?? null,
      ...(toStage === "NOT_NOW" ? { wakeUpAt: opts.wakeUpAt ?? null } : {}),
    },
  });

  // One activity per lead that actually moved — the timeline is how anyone
  // reconstructs what a bulk action did.
  const byId = new Map(rows.map((r) => [r.id, r]));
  await db.activity.createMany({
    data: allowed.map((id) => ({
      workspaceId,
      leadId: id,
      type: "stage_change",
      byUserId: userId,
      payload: {
        from: byId.get(id)?.stage ?? null,
        to: toStage,
        reason: opts.reason ?? null,
        bulk: true,
      },
    })),
  });

  // Undoable as ONE action (P7/2): the toast offers to put back exactly the
  // leads that moved, which is not the same set as the ones that were selected
  // — the score gate and the qualification gate skipped some, and undoing a
  // move that never happened would be a new edit dressed as a reversal.
  const undoToken = await recordUndo(workspaceId, userId, {
    kind: "bulk_stage",
    label: `Moved ${allowed.length} lead${allowed.length === 1 ? "" : "s"}`,
    inverse: {
      entity: "lead",
      targets: allowed.map((id) => {
        const before = byId.get(id)!;
        return {
          id,
          set: {
            stage: before.stage,
            stageEnteredAt: before.stageEnteredAt.toISOString(),
            stageReason: before.stageReason,
            wakeUpAt: before.wakeUpAt ? before.wakeUpAt.toISOString() : null,
          },
        };
      }),
    },
    expected: Object.fromEntries(allowed.map((id) => [id, { stage: toStage }])),
  });

  return {
    applied: allowed.length,
    skipped,
    moved: allowed.map((id) => ({ id, companyId: byId.get(id)?.companyId ?? null })),
    undo: undoToken,
  };
}

// ---- signals ------------------------------------------------------------

export async function applySignals(
  workspaceId: string,
  ids: string[],
  changes: { add?: string[]; remove?: string[] },
): Promise<BulkResult> {
  if (ids.length === 0) return { applied: 0, skipped: [] };
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.lead.findMany({
    where: { id: { in: ids } },
    select: { id: true, signals: true },
  });

  let applied = 0;
  for (const row of rows) {
    const current = Array.isArray(row.signals) ? (row.signals as string[]) : [];
    let next = addSignals(current, changes.add ?? []);
    next = removeSignals(next, changes.remove ?? []);
    // Skip the write when nothing actually changes — a no-op update still
    // bumps updated_at, which makes "recently changed" meaningless.
    if (next.length === current.length && next.every((s, i) => s === current[i])) continue;
    await db.lead.update({ where: { id: row.id }, data: { signals: next } });
    applied += 1;
  }
  return { applied, skipped: [] };
}

// ---- owner ---------------------------------------------------------------

export async function applyOwner(
  workspaceId: string,
  ids: string[],
  ownerId: string | null,
): Promise<BulkResult> {
  if (ids.length === 0) return { applied: 0, skipped: [] };

  // An owner must be a member of THIS workspace. Without this check a valid
  // user id from anywhere could be written onto our leads.
  if (ownerId) {
    const membership = await prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId: ownerId, workspaceId } },
      select: { userId: true },
    });
    if (!membership) {
      return {
        applied: 0,
        skipped: ids.map((id) => ({ id, reason: "that person is not in this workspace" })),
      };
    }
  }

  const db = getWorkspaceClient(workspaceId);
  const result = await db.lead.updateMany({ where: { id: { in: ids } }, data: { ownerId } });
  return { applied: result.count, skipped: [] };
}

// ---- delete --------------------------------------------------------------

/**
 * Erasure, not a soft delete: the same cascade the single-lead path uses, so a
 * bulk delete is a real GDPR erasure and not a second, weaker kind of delete.
 * Audit-logged per lead (CLAUDE.md hard rule #8).
 */
export async function deleteLeadsBulk(
  workspaceId: string,
  userId: string,
  ids: string[],
): Promise<BulkResult> {
  if (ids.length === 0) return { applied: 0, skipped: [] };
  const db = getWorkspaceClient(workspaceId);

  const leads = await db.lead.findMany({
    where: { id: { in: ids } },
    select: { id: true, contactName: true, email: true, company: { select: { name: true } } },
  });

  let applied = 0;
  const skipped: SkippedLead[] = [];
  for (const lead of leads) {
    try {
      const result = await eraseLeadData(db, lead.id, { eraseDocuments: false });
      await db.auditLog.create({
        data: {
          workspaceId,
          actorUserId: userId,
          action: "lead.deleted",
          entityType: "Lead",
          entityId: lead.id,
          meta: {
            contactName: lead.contactName,
            company: lead.company?.name ?? null,
            email: lead.email,
            erasedDocuments: false,
            deleted: result.deleted,
            filesRemoved: result.filesRemoved,
            bulk: true,
          },
        },
      });
      applied += 1;
    } catch (e) {
      skipped.push({ id: lead.id, reason: (e as Error).message });
    }
  }
  return { applied, skipped };
}

// ---- export --------------------------------------------------------------

/**
 * The rows an export is built from, and the field definitions that give the
 * Owner-defined columns their labels.
 *
 * Split out from `exportLeadsCsv` because CSV is no longer the only
 * destination: the spreadsheet and the branded PDF need exactly these rows,
 * and fetching them three slightly different ways is how three exports of the
 * same selection end up disagreeing with each other.
 */
export async function loadLeadsForExport(
  workspaceId: string,
  ids: string[],
): Promise<{ leads: CsvLead[]; customFields: Awaited<ReturnType<typeof listFieldDefsWith>> }> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.lead.findMany({
    where: { id: { in: ids } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      contactName: true,
      title: true,
      email: true,
      phone: true,
      icpScore: true,
      stage: true,
      signals: true,
      source: true,
      ownerId: true,
      lastActivityAt: true,
      createdAt: true,
      customFields: true,
      company: { select: { name: true, industry: true, city: true } },
    },
  });
  // The workspace's own fields, so an exported custom column carries its label
  // and its formatted value rather than an empty cell (P5/1).
  const customFields = await listFieldDefsWith(db, "lead");

  const ownerIds = [...new Set(rows.map((r) => r.ownerId).filter((v): v is string => !!v))];
  const owners = ownerIds.length
    ? await prismaUnsafe.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, name: true },
      })
    : [];
  const ownerNames = new Map(owners.map((o) => [o.id, o.name]));

  return {
    leads: rows.map((r) => ({
      id: r.id,
      contactName: r.contactName,
      title: r.title,
      email: r.email,
      phone: r.phone,
      company: r.company?.name ?? null,
      industry: r.company?.industry ?? null,
      city: r.company?.city ?? null,
      icpScore: r.icpScore,
      stage: r.stage,
      signals: Array.isArray(r.signals) ? (r.signals as string[]) : [],
      source: r.source,
      ownerName: r.ownerId ? (ownerNames.get(r.ownerId) ?? null) : null,
      customFields: readValues(r.customFields),
      lastActivityAt: r.lastActivityAt,
      createdAt: r.createdAt,
    })),
    customFields,
  };
}

export async function exportLeadsCsv(
  workspaceId: string,
  ids: string[],
  columns: string[],
): Promise<string> {
  const { leads, customFields } = await loadLeadsForExport(workspaceId, ids);
  return buildLeadsCsv(leads, columns, customFields);
}

/** Re-exported so the actions layer has one import for the whole feature. */
export { applyFilters };
