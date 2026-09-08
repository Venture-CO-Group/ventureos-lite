/**
 * Carrying out and undoing a merge (playbook-v2 P5/2).
 *
 * Workspace-id in rather than session-derived, like `leads/bulk-store.ts`: what
 * matters is what a merge REACHES, and that is worth proving against a real
 * database.
 *
 * THE SHAPE OF A MERGE:
 *   1. resolve the surviving value for every comparable field;
 *   2. re-link every dependent row from the loser to the survivor, RECORDING
 *      the ids that moved;
 *   3. tombstone the loser (`mergedIntoId`), never delete it, so a bookmark, a
 *      stale tab or an external system's stored id still resolves;
 *   4. write a MergeRecord holding the loser's whole row, the survivor's
 *      pre-merge row and the moved ids.
 *
 * Step 2 records ids rather than counts because that is the difference between
 * an undo and a guess: reverting has to move back exactly what the merge moved,
 * and nothing a person has attached to the survivor since.
 */

import { getWorkspaceClient } from "@/lib/db";
import { cached, invalidate } from "@/lib/ttl-cache";
import { normalizeTaxId } from "@/modules/registry/dedupe";
import {
  defaultChoice,
  findCompanyDuplicates,
  findLeadDuplicates,
  type DuplicateCandidate,
  type FieldChoice,
  pairKey,
  sortedPair,
  withoutDismissed,
} from "./detect";

export const REVERT_WINDOW_DAYS = 30;

export type MergeEntity = "company" | "lead";

export type MergeResult =
  | { ok: true; mergeId: string; moved: Record<string, number> }
  | { ok: false; error: string };

/** The fields a merge lets you choose between, per entity. */
export const COMPANY_FIELDS = [
  "name",
  "domain",
  "website",
  "industry",
  "sizeBand",
  "phone",
  "address",
  "city",
  "taxId",
  "notes",
] as const;

export const LEAD_FIELDS = [
  "contactName",
  "title",
  "email",
  "phone",
  "linkedinUrl",
  "notes",
  "ownerId",
  "language",
] as const;

export interface FieldComparison {
  field: string;
  survivorValue: unknown;
  loserValue: unknown;
  suggested: FieldChoice;
}

export interface MergePreview {
  entity: MergeEntity;
  survivorId: string;
  loserId: string;
  survivorLabel: string;
  loserLabel: string;
  fields: FieldComparison[];
  /** What would move, by table. */
  impact: Record<string, number>;
}

// ---- candidates -------------------------------------------------------------

/**
 * The candidate scan, cached for 60 seconds (P6/3).
 *
 * It reads every company and every lead in the workspace and compares them.
 * Blocking made it near-linear rather than quadratic, but it is still a
 * whole-table pass, and it is asked for by two surfaces — the Settings panel
 * and the lead modal's banner. Duplicates do not appear by the second.
 */
export async function listDuplicateCandidates(
  workspaceId: string,
): Promise<{ companies: DuplicateCandidate[]; leads: DuplicateCandidate[] }> {
  const scanned = await cached(`duplicates:${workspaceId}`, () => scanDuplicates(workspaceId));

  /**
   * Dismissals are applied OUTSIDE the cache.
   *
   * The scan is the expensive half and it only changes when companies or leads
   * do; a dismissal has to take effect on the very next render, and caching it
   * alongside the scan would leave the pair on screen until the cache expired
   * — which reads as the button not working.
   */
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.duplicateDismissal.findMany({
    select: { entity: true, aId: true, bId: true },
  });
  const byEntity = { company: new Set<string>(), lead: new Set<string>() };
  for (const r of rows) {
    const set = r.entity === "lead" ? byEntity.lead : byEntity.company;
    set.add(pairKey(r.aId, r.bId));
  }

  return {
    companies: withoutDismissed(scanned.companies, byEntity.company),
    leads: withoutDismissed(scanned.leads, byEntity.lead),
  };
}

export interface DismissedPair {
  entity: string;
  aId: string;
  bId: string;
  label: string;
  reason: string | null;
  at: string;
}

/**
 * What has been dismissed, so a mis-click is not permanent.
 *
 * A one-way button on a list like this is worse than no button: the pair
 * disappears and there is no way to learn that it ever existed.
 */
export async function listDismissedPairs(workspaceId: string): Promise<DismissedPair[]> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.duplicateDismissal.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  if (rows.length === 0) return [];

  const companyIds = rows.filter((r) => r.entity === "company").flatMap((r) => [r.aId, r.bId]);
  const leadIds = rows.filter((r) => r.entity === "lead").flatMap((r) => [r.aId, r.bId]);
  const [companies, leads] = await Promise.all([
    companyIds.length
      ? db.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    leadIds.length
      ? db.lead.findMany({
          where: { id: { in: leadIds } },
          select: { id: true, contactName: true, email: true },
        })
      : Promise.resolve([]),
  ]);
  const name = new Map<string, string>([
    ...companies.map((c) => [c.id, c.name] as const),
    ...leads.map((l) => [l.id, l.contactName || l.email || "lead"] as const),
  ]);

  return rows.map((r) => ({
    entity: r.entity,
    aId: r.aId,
    bId: r.bId,
    // A row whose record has since been deleted still deserves a label rather
    // than an empty line.
    label: `${name.get(r.aId) ?? "(removed)"} ↔ ${name.get(r.bId) ?? "(removed)"}`,
    reason: r.reason,
    at: r.createdAt.toISOString(),
  }));
}

async function scanDuplicates(
  workspaceId: string,
): Promise<{ companies: DuplicateCandidate[]; leads: DuplicateCandidate[] }> {
  const db = getWorkspaceClient(workspaceId);
  const [companies, leads] = await Promise.all([
    db.company.findMany({
      select: {
        id: true,
        name: true,
        domain: true,
        taxId: true,
        createdAt: true,
        mergedIntoId: true,
      },
    }),
    db.lead.findMany({
      select: {
        id: true,
        contactName: true,
        email: true,
        companyId: true,
        createdAt: true,
        mergedIntoId: true,
      },
    }),
  ]);
  return {
    companies: findCompanyDuplicates(companies),
    leads: findLeadDuplicates(leads),
  };
}

// ---- preview ----------------------------------------------------------------

async function loadPair(workspaceId: string, entity: MergeEntity, aId: string, bId: string) {
  const db = getWorkspaceClient(workspaceId);
  if (entity === "company") {
    const rows = await db.company.findMany({ where: { id: { in: [aId, bId] } } });
    return { survivor: rows.find((r) => r.id === aId), loser: rows.find((r) => r.id === bId) };
  }
  const rows = await db.lead.findMany({ where: { id: { in: [aId, bId] } } });
  return { survivor: rows.find((r) => r.id === aId), loser: rows.find((r) => r.id === bId) };
}

function labelFor(entity: MergeEntity, row: Record<string, unknown>): string {
  if (entity === "company") return String(row.name ?? "(unnamed company)");
  return String(row.contactName ?? row.email ?? "(unnamed lead)");
}

export async function previewMerge(
  workspaceId: string,
  entity: MergeEntity,
  survivorId: string,
  loserId: string,
): Promise<{ ok: true; preview: MergePreview } | { ok: false; error: string }> {
  if (survivorId === loserId) return { ok: false, error: "That is the same record twice." };
  const { survivor, loser } = await loadPair(workspaceId, entity, survivorId, loserId);
  if (!survivor || !loser) return { ok: false, error: "One of those records no longer exists." };
  if (survivor.mergedIntoId || loser.mergedIntoId) {
    return { ok: false, error: "One of those records has already been merged." };
  }

  const fieldNames: readonly string[] = entity === "company" ? COMPANY_FIELDS : LEAD_FIELDS;
  const loserIsNewer = loser.createdAt > survivor.createdAt;
  const s = survivor as unknown as Record<string, unknown>;
  const l = loser as unknown as Record<string, unknown>;

  const fields: FieldComparison[] = fieldNames.map((field) => ({
    field,
    survivorValue: s[field] ?? null,
    loserValue: l[field] ?? null,
    suggested: defaultChoice(s[field], l[field], { loserIsNewer }),
  }));

  return {
    ok: true,
    preview: {
      entity,
      survivorId,
      loserId,
      survivorLabel: labelFor(entity, s),
      loserLabel: labelFor(entity, l),
      fields,
      impact: await countImpact(workspaceId, entity, loserId),
    },
  };
}

async function countImpact(
  workspaceId: string,
  entity: MergeEntity,
  loserId: string,
): Promise<Record<string, number>> {
  const db = getWorkspaceClient(workspaceId);
  if (entity === "company") {
    const [leads, deals, audits, subscriptions, invoices, referrers, keywords, logs] =
      await Promise.all([
        db.lead.count({ where: { companyId: loserId } }),
        db.deal.count({ where: { companyId: loserId } }),
        db.auditResult.count({ where: { companyId: loserId } }),
        db.subscription.count({ where: { companyId: loserId } }),
        db.invoice.count({ where: { companyId: loserId } }),
        db.referrer.count({ where: { linkedCompanyId: loserId } }),
        db.trackedKeyword.count({ where: { companyId: loserId } }),
        db.logUpload.count({ where: { companyId: loserId } }),
      ]);
    return { leads, deals, audits, subscriptions, invoices, referrers, keywords, logs };
  }
  const [activities, messages, calls, meetings, documents, emailLogs, threads, deals, outcomes, tasks, addressLinks, shares, recipients, subscriptions] =
    await Promise.all([
      db.activity.count({ where: { leadId: loserId } }),
      db.message.count({ where: { leadId: loserId } }),
      db.call.count({ where: { leadId: loserId } }),
      db.meeting.count({ where: { leadId: loserId } }),
      db.document.count({ where: { leadId: loserId } }),
      db.emailLog.count({ where: { leadId: loserId } }),
      db.emailThread.count({ where: { leadId: loserId } }),
      db.deal.count({ where: { leadId: loserId } }),
      db.dealOutcome.count({ where: { leadId: loserId } }),
      db.task.count({ where: { entityType: "lead", entityId: loserId } }),
      db.addressLink.count({ where: { leadId: loserId } }),
      db.auditShare.count({ where: { leadId: loserId } }),
      db.campaignRecipient.count({ where: { leadId: loserId } }),
      db.subscription.count({ where: { leadId: loserId } }),
    ]);
  return {
    activities,
    messages,
    calls,
    meetings,
    documents,
    emailLogs,
    threads,
    deals,
    outcomes,
    tasks,
    addressLinks,
    shares,
    recipients,
    subscriptions,
  };
}

// ---- merge ------------------------------------------------------------------

type MovedIds = Record<string, string[]>;

async function collectAndMoveLead(
  db: ReturnType<typeof getWorkspaceClient>,
  loserId: string,
  survivorId: string,
): Promise<MovedIds> {
  const moved: MovedIds = {};
  const move = async (
    name: string,
    ids: string[],
    apply: (ids: string[]) => Promise<unknown>,
  ) => {
    if (ids.length === 0) return;
    moved[name] = ids;
    await apply(ids);
  };

  const idsOf = async <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id);

  await move(
    "activity",
    await idsOf(await db.activity.findMany({ where: { leadId: loserId }, select: { id: true } })),
    (ids) => db.activity.updateMany({ where: { id: { in: ids } }, data: { leadId: survivorId } }),
  );
  await move(
    "message",
    await idsOf(await db.message.findMany({ where: { leadId: loserId }, select: { id: true } })),
    (ids) => db.message.updateMany({ where: { id: { in: ids } }, data: { leadId: survivorId } }),
  );
  await move(
    "call",
    await idsOf(await db.call.findMany({ where: { leadId: loserId }, select: { id: true } })),
    (ids) => db.call.updateMany({ where: { id: { in: ids } }, data: { leadId: survivorId } }),
  );
  await move(
    "meeting",
    await idsOf(await db.meeting.findMany({ where: { leadId: loserId }, select: { id: true } })),
    (ids) => db.meeting.updateMany({ where: { id: { in: ids } }, data: { leadId: survivorId } }),
  );
  await move(
    "document",
    await idsOf(await db.document.findMany({ where: { leadId: loserId }, select: { id: true } })),
    (ids) => db.document.updateMany({ where: { id: { in: ids } }, data: { leadId: survivorId } }),
  );
  await move(
    "emailLog",
    await idsOf(await db.emailLog.findMany({ where: { leadId: loserId }, select: { id: true } })),
    (ids) => db.emailLog.updateMany({ where: { id: { in: ids } }, data: { leadId: survivorId } }),
  );
  await move(
    "emailThread",
    await idsOf(
      await db.emailThread.findMany({ where: { leadId: loserId }, select: { id: true } }),
    ),
    (ids) => db.emailThread.updateMany({ where: { id: { in: ids } }, data: { leadId: survivorId } }),
  );
  await move(
    "deal",
    await idsOf(await db.deal.findMany({ where: { leadId: loserId }, select: { id: true } })),
    (ids) => db.deal.updateMany({ where: { id: { in: ids } }, data: { leadId: survivorId } }),
  );
  await move(
    "dealOutcome",
    await idsOf(
      await db.dealOutcome.findMany({ where: { leadId: loserId }, select: { id: true } }),
    ),
    (ids) => db.dealOutcome.updateMany({ where: { id: { in: ids } }, data: { leadId: survivorId } }),
  );
  await move(
    "task",
    await idsOf(
      await db.task.findMany({
        where: { entityType: "lead", entityId: loserId },
        select: { id: true },
      }),
    ),
    (ids) => db.task.updateMany({ where: { id: { in: ids } }, data: { entityId: survivorId } }),
  );
  await move(
    "auditShare",
    await idsOf(await db.auditShare.findMany({ where: { leadId: loserId }, select: { id: true } })),
    (ids) => db.auditShare.updateMany({ where: { id: { in: ids } }, data: { leadId: survivorId } }),
  );
  await move(
    "campaignRecipient",
    await idsOf(
      await db.campaignRecipient.findMany({ where: { leadId: loserId }, select: { id: true } }),
    ),
    (ids) =>
      db.campaignRecipient.updateMany({ where: { id: { in: ids } }, data: { leadId: survivorId } }),
  );
  await move(
    "subscription",
    await idsOf(
      await db.subscription.findMany({ where: { leadId: loserId }, select: { id: true } }),
    ),
    (ids) => db.subscription.updateMany({ where: { id: { in: ids } }, data: { leadId: survivorId } }),
  );
  // The learned address→lead mapping follows the person, or it will keep
  // re-matching new mail onto a tombstone.
  await move(
    "addressLink",
    await idsOf(
      await db.addressLink.findMany({ where: { leadId: loserId }, select: { id: true } }),
    ),
    (ids) => db.addressLink.updateMany({ where: { id: { in: ids } }, data: { leadId: survivorId } }),
  );
  return moved;
}

async function collectAndMoveCompany(
  db: ReturnType<typeof getWorkspaceClient>,
  loserId: string,
  survivorId: string,
): Promise<MovedIds> {
  const moved: MovedIds = {};
  const move = async (
    name: string,
    ids: string[],
    apply: (ids: string[]) => Promise<unknown>,
  ) => {
    if (ids.length === 0) return;
    moved[name] = ids;
    await apply(ids);
  };
  const idsOf = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id);

  await move(
    "lead",
    idsOf(await db.lead.findMany({ where: { companyId: loserId }, select: { id: true } })),
    (ids) => db.lead.updateMany({ where: { id: { in: ids } }, data: { companyId: survivorId } }),
  );
  await move(
    "deal",
    idsOf(await db.deal.findMany({ where: { companyId: loserId }, select: { id: true } })),
    (ids) => db.deal.updateMany({ where: { id: { in: ids } }, data: { companyId: survivorId } }),
  );
  await move(
    "auditResult",
    idsOf(await db.auditResult.findMany({ where: { companyId: loserId }, select: { id: true } })),
    (ids) =>
      db.auditResult.updateMany({ where: { id: { in: ids } }, data: { companyId: survivorId } }),
  );
  await move(
    "subscription",
    idsOf(await db.subscription.findMany({ where: { companyId: loserId }, select: { id: true } })),
    (ids) =>
      db.subscription.updateMany({ where: { id: { in: ids } }, data: { companyId: survivorId } }),
  );
  await move(
    "invoice",
    idsOf(await db.invoice.findMany({ where: { companyId: loserId }, select: { id: true } })),
    (ids) => db.invoice.updateMany({ where: { id: { in: ids } }, data: { companyId: survivorId } }),
  );
  await move(
    "referrer",
    idsOf(
      await db.referrer.findMany({ where: { linkedCompanyId: loserId }, select: { id: true } }),
    ),
    (ids) =>
      db.referrer.updateMany({ where: { id: { in: ids } }, data: { linkedCompanyId: survivorId } }),
  );
  await move(
    "trackedKeyword",
    idsOf(await db.trackedKeyword.findMany({ where: { companyId: loserId }, select: { id: true } })),
    (ids) =>
      db.trackedKeyword.updateMany({ where: { id: { in: ids } }, data: { companyId: survivorId } }),
  );
  await move(
    "logUpload",
    idsOf(await db.logUpload.findMany({ where: { companyId: loserId }, select: { id: true } })),
    (ids) => db.logUpload.updateMany({ where: { id: { in: ids } }, data: { companyId: survivorId } }),
  );
  await move(
    "emailThread",
    idsOf(await db.emailThread.findMany({ where: { companyId: loserId }, select: { id: true } })),
    (ids) =>
      db.emailThread.updateMany({ where: { id: { in: ids } }, data: { companyId: survivorId } }),
  );
  return moved;
}

export interface MergeInput {
  entity: MergeEntity;
  survivorId: string;
  loserId: string;
  /** field -> which side's value survives. Missing fields keep the survivor's. */
  choices?: Record<string, FieldChoice>;
}

export async function mergeRecords(
  workspaceId: string,
  actorUserId: string | null,
  input: MergeInput,
): Promise<MergeResult> {
  const { entity, survivorId, loserId } = input;
  if (survivorId === loserId) return { ok: false, error: "That is the same record twice." };

  const db = getWorkspaceClient(workspaceId);
  const { survivor, loser } = await loadPair(workspaceId, entity, survivorId, loserId);
  if (!survivor || !loser) return { ok: false, error: "One of those records no longer exists." };
  if (survivor.mergedIntoId || loser.mergedIntoId) {
    return { ok: false, error: "One of those records has already been merged." };
  }

  const fieldNames: readonly string[] = entity === "company" ? COMPANY_FIELDS : LEAD_FIELDS;
  const s = survivor as unknown as Record<string, unknown>;
  const l = loser as unknown as Record<string, unknown>;
  const loserIsNewer = loser.createdAt > survivor.createdAt;

  const patch: Record<string, unknown> = {};
  const choices: Record<string, FieldChoice> = {};
  for (const field of fieldNames) {
    const choice =
      input.choices?.[field] ?? defaultChoice(s[field], l[field], { loserIsNewer });
    choices[field] = choice;
    if (choice === "loser" && l[field] !== undefined && l[field] !== s[field]) {
      patch[field] = l[field];
    }
  }

  // Custom-field values union: the survivor's win a clash, the loser's fill the
  // gaps. Dropping the loser's outright would lose data the merge is supposed
  // to consolidate.
  const survivorCustom = (s.customFields ?? {}) as Record<string, unknown>;
  const loserCustom = (l.customFields ?? {}) as Record<string, unknown>;
  const mergedCustom = { ...loserCustom, ...survivorCustom };
  if (Object.keys(mergedCustom).length > 0) patch.customFields = mergedCustom;

  // The tax id is unique per workspace, so it has to leave the tombstone before
  // it can land on the survivor — otherwise the update collides with itself.
  if (entity === "company" && patch.taxId) {
    patch.taxId = normalizeTaxId(String(patch.taxId)) ?? null;
  }

  const moved =
    entity === "company"
      ? await collectAndMoveCompany(db, loserId, survivorId)
      : await collectAndMoveLead(db, loserId, survivorId);

  const now = new Date();
  if (entity === "company") {
    await db.company.update({
      where: { id: loserId },
      // The tombstone gives up its unique keys: a merged-away company must not
      // keep holding the adószám the survivor now needs.
      data: { mergedIntoId: survivorId, mergedAt: now, taxId: null, domain: null },
    });
    await db.company.update({ where: { id: survivorId }, data: patch });
  } else {
    await db.lead.update({
      where: { id: loserId },
      data: { mergedIntoId: survivorId, mergedAt: now },
    });
    await db.lead.update({ where: { id: survivorId }, data: patch });
  }

  const record = await db.mergeRecord.create({
    data: {
      workspaceId,
      entity,
      survivorId,
      loserId,
      snapshot: {
        loser: JSON.parse(JSON.stringify(l)),
        survivorBefore: JSON.parse(JSON.stringify(s)),
        moved,
      },
      choices,
      performedBy: actorUserId,
      revertUntil: new Date(now.getTime() + REVERT_WINDOW_DAYS * 86_400_000),
    },
  });

  // The candidate list is cached; a merge is exactly the event that must show
  // immediately rather than in up to a minute.
  invalidate(`duplicates:${workspaceId}`);

  return {
    ok: true,
    mergeId: record.id,
    moved: Object.fromEntries(Object.entries(moved).map(([k, v]) => [k, v.length])),
  };
}

// ---- revert -----------------------------------------------------------------

export type RevertResult = { ok: true; restored: number } | { ok: false; error: string };

/**
 * Undo a merge, within the window.
 *
 * Restores by MOVED IDS, not by "everything currently pointing at the
 * survivor": a call logged against the survivor after the merge belongs to the
 * survivor, and sweeping it back would be a second wrong merge in the opposite
 * direction.
 *
 * The survivor's own field values are restored from `survivorBefore`, so a
 * value the merge copied across is undone too.
 */
export async function revertMerge(
  workspaceId: string,
  actorUserId: string | null,
  mergeId: string,
  now: Date = new Date(),
): Promise<RevertResult> {
  const db = getWorkspaceClient(workspaceId);
  const record = await db.mergeRecord.findUnique({ where: { id: mergeId } });
  if (!record) return { ok: false, error: "That merge is not on record." };
  if (record.revertedAt) return { ok: false, error: "That merge has already been undone." };
  if (record.revertUntil < now) {
    return {
      ok: false,
      error: `The ${REVERT_WINDOW_DAYS}-day window for undoing this merge has closed.`,
    };
  }

  const snapshot = record.snapshot as {
    loser?: Record<string, unknown>;
    survivorBefore?: Record<string, unknown>;
    moved?: MovedIds;
  };
  const moved = snapshot.moved ?? {};
  const entity = record.entity as MergeEntity;
  let restored = 0;

  const back = async (name: string, apply: (ids: string[]) => Promise<{ count: number }>) => {
    const ids = moved[name];
    if (!ids || ids.length === 0) return;
    const res = await apply(ids);
    restored += res.count;
  };

  if (entity === "lead") {
    const to = { leadId: record.loserId };
    await back("activity", (ids) => db.activity.updateMany({ where: { id: { in: ids } }, data: to }));
    await back("message", (ids) => db.message.updateMany({ where: { id: { in: ids } }, data: to }));
    await back("call", (ids) => db.call.updateMany({ where: { id: { in: ids } }, data: to }));
    await back("meeting", (ids) => db.meeting.updateMany({ where: { id: { in: ids } }, data: to }));
    await back("document", (ids) => db.document.updateMany({ where: { id: { in: ids } }, data: to }));
    await back("emailLog", (ids) => db.emailLog.updateMany({ where: { id: { in: ids } }, data: to }));
    await back("emailThread", (ids) =>
      db.emailThread.updateMany({ where: { id: { in: ids } }, data: to }),
    );
    await back("deal", (ids) => db.deal.updateMany({ where: { id: { in: ids } }, data: to }));
    await back("dealOutcome", (ids) =>
      db.dealOutcome.updateMany({ where: { id: { in: ids } }, data: to }),
    );
    await back("task", (ids) =>
      db.task.updateMany({ where: { id: { in: ids } }, data: { entityId: record.loserId } }),
    );
    await back("auditShare", (ids) =>
      db.auditShare.updateMany({ where: { id: { in: ids } }, data: to }),
    );
    await back("campaignRecipient", (ids) =>
      db.campaignRecipient.updateMany({ where: { id: { in: ids } }, data: to }),
    );
    await back("subscription", (ids) =>
      db.subscription.updateMany({ where: { id: { in: ids } }, data: to }),
    );
    await back("addressLink", (ids) =>
      db.addressLink.updateMany({ where: { id: { in: ids } }, data: to }),
    );
    await db.lead.update({
      where: { id: record.loserId },
      data: { mergedIntoId: null, mergedAt: null },
    });
    await db.lead.update({
      where: { id: record.survivorId },
      data: restorePatch(snapshot.survivorBefore, LEAD_FIELDS),
    });
  } else {
    const to = { companyId: record.loserId };
    await back("lead", (ids) => db.lead.updateMany({ where: { id: { in: ids } }, data: to }));
    await back("deal", (ids) => db.deal.updateMany({ where: { id: { in: ids } }, data: to }));
    await back("auditResult", (ids) =>
      db.auditResult.updateMany({ where: { id: { in: ids } }, data: to }),
    );
    await back("subscription", (ids) =>
      db.subscription.updateMany({ where: { id: { in: ids } }, data: to }),
    );
    await back("invoice", (ids) => db.invoice.updateMany({ where: { id: { in: ids } }, data: to }));
    await back("referrer", (ids) =>
      db.referrer.updateMany({
        where: { id: { in: ids } },
        data: { linkedCompanyId: record.loserId },
      }),
    );
    await back("trackedKeyword", (ids) =>
      db.trackedKeyword.updateMany({ where: { id: { in: ids } }, data: to }),
    );
    await back("logUpload", (ids) =>
      db.logUpload.updateMany({ where: { id: { in: ids } }, data: to }),
    );
    await back("emailThread", (ids) =>
      db.emailThread.updateMany({ where: { id: { in: ids } }, data: to }),
    );
    // The survivor gives back the unique keys BEFORE the tombstone reclaims
    // them, or the two rows collide on the workspace-unique adószám.
    await db.company.update({
      where: { id: record.survivorId },
      data: restorePatch(snapshot.survivorBefore, COMPANY_FIELDS),
    });
    await db.company.update({
      where: { id: record.loserId },
      data: {
        mergedIntoId: null,
        mergedAt: null,
        ...restorePatch(snapshot.loser, COMPANY_FIELDS),
      },
    });
  }

  await db.mergeRecord.update({
    where: { id: mergeId },
    data: { revertedAt: now, revertedBy: actorUserId },
  });
  invalidate(`duplicates:${workspaceId}`);

  return { ok: true, restored };
}

/** Only the comparable fields, so a restore cannot rewrite ids or timestamps. */
function restorePatch(
  snapshot: Record<string, unknown> | undefined,
  fields: readonly string[],
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (!snapshot) return patch;
  for (const field of fields) {
    if (field in snapshot) patch[field] = snapshot[field] ?? null;
  }
  if ("customFields" in snapshot) {
    patch.customFields = snapshot.customFields ?? undefined;
  }
  return patch;
}

// ---- tombstones -------------------------------------------------------------

/**
 * Follow a tombstone to the record that survived (P5/2).
 *
 * Chases the chain, because A can be merged into B and B later into C. Bounded
 * at ten hops so a cycle written by a bad migration cannot hang a page render.
 */
export async function resolveSurvivor(
  workspaceId: string,
  entity: MergeEntity,
  id: string,
): Promise<string> {
  const db = getWorkspaceClient(workspaceId);
  let current = id;
  for (let hop = 0; hop < 10; hop += 1) {
    const row =
      entity === "company"
        ? await db.company.findUnique({ where: { id: current }, select: { mergedIntoId: true } })
        : await db.lead.findUnique({ where: { id: current }, select: { mergedIntoId: true } });
    if (!row?.mergedIntoId) return current;
    current = row.mergedIntoId;
  }
  return current;
}

export interface MergeHistoryRow {
  id: string;
  entity: string;
  survivorId: string;
  loserId: string;
  survivorLabel: string;
  loserLabel: string;
  at: string;
  revertUntil: string;
  revertedAt: string | null;
  canRevert: boolean;
}

export async function listMergeHistory(
  workspaceId: string,
  now: Date = new Date(),
): Promise<MergeHistoryRow[]> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.mergeRecord.findMany({ orderBy: { at: "desc" }, take: 100 });
  return rows.map((r) => {
    const snapshot = r.snapshot as {
      loser?: Record<string, unknown>;
      survivorBefore?: Record<string, unknown>;
    };
    return {
      id: r.id,
      entity: r.entity,
      survivorId: r.survivorId,
      loserId: r.loserId,
      survivorLabel: labelFor(r.entity as MergeEntity, snapshot.survivorBefore ?? {}),
      loserLabel: labelFor(r.entity as MergeEntity, snapshot.loser ?? {}),
      at: r.at.toISOString(),
      revertUntil: r.revertUntil.toISOString(),
      revertedAt: r.revertedAt?.toISOString() ?? null,
      canRevert: !r.revertedAt && r.revertUntil >= now,
    };
  });
}


/**
 * Record that a pair is not a duplicate.
 *
 * Idempotent: dismissing the same pair twice is one row, and the second call
 * refreshes the reason rather than failing on the unique index.
 */
export async function dismissDuplicate(
  workspaceId: string,
  userId: string,
  entity: "company" | "lead",
  aId: string,
  bId: string,
  reason: string | null,
): Promise<void> {
  const db = getWorkspaceClient(workspaceId);
  const pair = sortedPair(aId, bId);
  const existing = await db.duplicateDismissal.findFirst({
    where: { entity, aId: pair.aId, bId: pair.bId },
    select: { id: true },
  });
  if (existing) {
    await db.duplicateDismissal.update({
      where: { id: existing.id },
      data: { reason, dismissedBy: userId },
    });
    return;
  }
  await db.duplicateDismissal.create({
    data: { workspaceId, entity, ...pair, dismissedBy: userId, reason },
  });
}

/** Put a dismissed pair back on the review list. */
export async function restoreDuplicate(
  workspaceId: string,
  entity: "company" | "lead",
  aId: string,
  bId: string,
): Promise<void> {
  const db = getWorkspaceClient(workspaceId);
  const pair = sortedPair(aId, bId);
  await db.duplicateDismissal.deleteMany({
    where: { entity, aId: pair.aId, bId: pair.bId },
  });
}
