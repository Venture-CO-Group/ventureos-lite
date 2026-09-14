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
import { coerce, isBlank, readValues, validateValues } from "@/modules/fields/types";
import { recordUndo, type UndoToken } from "@/modules/undo/store";
import { eraseLeadData } from "@/modules/gdpr/erase";
import { canQualify, type Qualification } from "../inbox/qualification";
import { requiresReason } from "../pipeline/transitions";
import { applyFilters, type FilterSet } from "./filters";
import {
  addSignals,
  buildLeadsCsv,
  chunk,
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

// ---- custom fields -------------------------------------------------------

/**
 * Set one Owner-defined field across a selection (P2/2.2).
 *
 * ── WHY ROW BY ROW RATHER THAN `updateMany` ─────────────────────────────────
 *
 * `Lead.customFields` is a single JSON column holding every custom value, so
 * writing one field means merging into whatever else is already there. An
 * `updateMany` would replace the column and silently drop every other custom
 * value on those leads — the kind of loss nobody notices until a report comes
 * out wrong months later.
 *
 * Batched by the caller, so the cost is bounded per request.
 */
export async function applyCustomField(
  workspaceId: string,
  ids: string[],
  fieldKey: string,
  rawValue: unknown,
): Promise<BulkResult> {
  if (ids.length === 0) return { applied: 0, skipped: [] };

  const db = getWorkspaceClient(workspaceId);
  const defs = await listFieldDefsWith(db, "lead");
  const def = defs.find((d) => d.key === fieldKey && !d.archived);
  if (!def) {
    return {
      applied: 0,
      skipped: ids.map((id) => ({ id, reason: "that field does not exist here" })),
    };
  }

  // Clearing is a legitimate bulk edit, and a required field cannot be
  // cleared — the forms would then refuse to save a row the bulk bar created.
  const clearing = isBlank(rawValue);
  if (clearing && def.required) {
    return {
      applied: 0,
      skipped: ids.map((id) => ({ id, reason: `${def.label} is required and cannot be cleared` })),
    };
  }

  let value: unknown = null;
  if (!clearing) {
    const coerced = coerce(def, rawValue);
    const result = validateValues([def], { [def.key]: coerced as never });
    if (!result.ok) {
      const reason = result.problems[0]?.message ?? `${def.label} is not valid`;
      return { applied: 0, skipped: ids.map((id) => ({ id, reason })) };
    }
    value = coerced;
  }

  const rows = await db.lead.findMany({
    where: { id: { in: ids } },
    select: { id: true, customFields: true },
  });

  let applied = 0;
  for (const row of rows) {
    const current = readValues(row.customFields);
    const next = { ...current };
    if (clearing) delete next[def.key];
    else next[def.key] = value as never;

    const { count } = await db.lead.updateMany({
      where: { id: row.id },
      data: { customFields: next as never },
    });
    applied += count;
  }
  return { applied, skipped: [] };
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
 * How many leads are read from the database in one go.
 *
 * An export may name ten thousand ids, and `WHERE id IN (...)` with ten
 * thousand bound parameters is a query some drivers refuse outright and the
 * rest plan badly. Reading in batches also means the row objects for a finished
 * batch can be collected while the next is in flight, rather than the whole
 * export sitting in memory as one array of fully-joined leads.
 */
export const EXPORT_BATCH_SIZE = 500;

/**
 * The rows an export is built from, and the field definitions that give the
 * Owner-defined columns their labels.
 *
 * Split out from `exportLeadsCsv` because CSV is no longer the only
 * destination: the spreadsheet and the branded PDF need exactly these rows,
 * and fetching them three slightly different ways is how three exports of the
 * same selection end up disagreeing with each other.
 *
 * ── WHAT IT LOADS ───────────────────────────────────────────────────────────
 *
 * The whole record the column registry can resolve, joins included: the
 * company's domain, city and adószám, the latest completed audit, and the last
 * outbound touch. Anything the registry knows how to print, this loads — which
 * is the invariant that stops a column being added and quietly exporting blank.
 *
 * The person summary is READ from `personBrief`. Nothing here calls Claude: an
 * export is not a research trigger, and a lead without a brief exports an empty
 * cell rather than acquiring one (CLAUDE.md rule #3).
 */
export async function loadLeadsForExport(
  workspaceId: string,
  ids: string[],
): Promise<{ leads: CsvLead[]; customFields: Awaited<ReturnType<typeof listFieldDefsWith>> }> {
  const db = getWorkspaceClient(workspaceId);

  // The workspace's own fields, so an exported custom column carries its label
  // and its formatted value rather than an empty cell (P5/1).
  const customFields = await listFieldDefsWith(db, "lead");

  const leads: CsvLead[] = [];
  for (const batch of chunk(ids, EXPORT_BATCH_SIZE)) {
    leads.push(...(await loadExportBatch(db, batch)));
  }

  // The batches came back newest-first individually; the whole export is sorted
  // once so a file's order does not depend on how the ids happened to chunk.
  leads.sort((a, b) => dateMs(b.createdAt) - dateMs(a.createdAt));

  return { leads, customFields };
}

function dateMs(v: Date | string | null | undefined): number {
  return v ? new Date(v).getTime() : 0;
}

type GuardedClient = ReturnType<typeof getWorkspaceClient>;

async function loadExportBatch(db: GuardedClient, ids: string[]): Promise<CsvLead[]> {
  const rows = await db.lead.findMany({
    where: { id: { in: ids } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      contactName: true,
      title: true,
      email: true,
      phone: true,
      linkedinUrl: true,
      locationRaw: true,
      icpScore: true,
      scoreBreakdown: true,
      stage: true,
      signals: true,
      source: true,
      ownerId: true,
      personBrief: true,
      notes: true,
      lastActivityAt: true,
      createdAt: true,
      customFields: true,
      companyId: true,
      company: {
        select: {
          name: true,
          industry: true,
          city: true,
          domain: true,
          website: true,
          taxId: true,
          registry: { select: { taxId: true } },
        },
      },
    },
  });

  const ownerNames = await loadOwnerNames(rows.map((r) => r.ownerId));
  const audits = await loadLatestAudits(
    db,
    rows.map((r) => r.companyId),
  );
  const contacted = await loadLastContacted(db, ids);

  return rows.map((r) => {
    const audit = r.companyId ? audits.get(r.companyId) : undefined;
    return {
      id: r.id,
      contactName: r.contactName,
      title: r.title,
      email: r.email,
      phone: r.phone,
      linkedinUrl: r.linkedinUrl,
      company: r.company?.name ?? null,
      // A domain is what we prefer to show; a website is what we fall back to
      // when the prospector only ever saw a full URL.
      domain: r.company?.domain ?? r.company?.website ?? null,
      industry: r.company?.industry ?? null,
      // The company's city, falling back to the location line LinkedIn showed —
      // which is all we have for a lead captured before its company existed.
      city: r.company?.city ?? r.locationRaw ?? null,
      // The registry value is the enriched one and outranks whatever was typed.
      taxId: r.company?.registry?.taxId ?? r.company?.taxId ?? null,
      icpScore: r.icpScore,
      scoreBreakdown: r.scoreBreakdown,
      stage: r.stage,
      signals: Array.isArray(r.signals) ? (r.signals as string[]) : [],
      source: r.source,
      ownerName: r.ownerId ? (ownerNames.get(r.ownerId) ?? null) : null,
      auditScore: audit?.score ?? null,
      auditAt: audit?.createdAt ?? null,
      personBrief: r.personBrief,
      notes: r.notes,
      customFields: readValues(r.customFields),
      createdAt: r.createdAt,
      lastActivityAt: r.lastActivityAt,
      lastContactedAt: contacted.get(r.id) ?? null,
    };
  });
}

/**
 * Owner display names.
 *
 * Through the unguarded client because users are global rather than
 * tenant-scoped — the same reason `Lead.ownerId` is a plain column and not a
 * foreign key. Only ids that came back from a guarded lead read are looked up,
 * so this cannot be steered at another workspace's people.
 */
async function loadOwnerNames(ids: (string | null)[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return new Map();
  const users = await prismaUnsafe.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, u.name]));
}

/**
 * The latest finished audit per company.
 *
 * Ordered newest-first and kept only on first sight of a company, which is one
 * query for the batch rather than one per lead. Unfinished and failed runs are
 * excluded: a queued audit has a score of 0, and exporting that as the
 * company's score would read as a verdict rather than as an absence.
 */
async function loadLatestAudits(
  db: GuardedClient,
  companyIds: (string | null)[],
): Promise<Map<string, { score: number; createdAt: Date }>> {
  const unique = [...new Set(companyIds.filter((v): v is string => !!v))];
  if (unique.length === 0) return new Map();

  const rows = await db.auditResult.findMany({
    where: { companyId: { in: unique }, status: "done" },
    orderBy: { createdAt: "desc" },
    select: { companyId: true, score: true, createdAt: true },
  });

  const out = new Map<string, { score: number; createdAt: Date }>();
  for (const r of rows) {
    if (!r.companyId || out.has(r.companyId)) continue;
    out.set(r.companyId, { score: r.score, createdAt: r.createdAt });
  }
  return out;
}

/**
 * When we last reached OUT to each lead.
 *
 * There is no `lastContactedAt` column, and adding one would mean a value kept
 * correct by every send path forever. It is derived instead from the three
 * things that ARE a contact: a message actually sent, a logged email, and a
 * call. Inbound messages are excluded — a reply is them contacting us, and
 * counting it would make "last contacted" say we followed up when we did not.
 */
async function loadLastContacted(
  db: GuardedClient,
  leadIds: string[],
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const keep = (leadId: string | null, at: Date | null) => {
    if (!leadId || !at) return;
    const prev = out.get(leadId);
    if (!prev || at > prev) out.set(leadId, at);
  };

  const [messages, emails, calls] = await Promise.all([
    db.message.findMany({
      where: { leadId: { in: leadIds }, direction: "OUTBOUND", sentAt: { not: null } },
      select: { leadId: true, sentAt: true },
    }),
    db.emailLog.findMany({
      where: { leadId: { in: leadIds } },
      select: { leadId: true, at: true },
    }),
    db.call.findMany({
      where: { leadId: { in: leadIds } },
      select: { leadId: true, at: true },
    }),
  ]);

  for (const m of messages) keep(m.leadId, m.sentAt);
  for (const e of emails) keep(e.leadId, e.at);
  for (const c of calls) keep(c.leadId, c.at);
  return out;
}

/**
 * The CSV for a selection — the whole lead record, not a column subset.
 *
 * The `columns` argument is gone on purpose. It was how the on-screen column
 * selection decided what a file contained, so a table showing five columns
 * exported five columns and the rest of the record never left.
 */
export async function exportLeadsCsv(workspaceId: string, ids: string[]): Promise<string> {
  const { leads, customFields } = await loadLeadsForExport(workspaceId, ids);
  return buildLeadsCsv(leads, customFields);
}

/** Re-exported so the actions layer has one import for the whole feature. */
export { applyFilters };
