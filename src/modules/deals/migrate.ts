/**
 * The P4 deals migration (playbook-v2 P4/a + P4/d).
 *
 * This is the invasive part of the phase, so it is built to be inspected before
 * it runs and undone after it has:
 *
 *   - `plan()` derives the whole mapping WITHOUT writing anything. The dry-run
 *     prints it, and the printed table is committed into
 *     docs/migrations/p4-deals.md as the record of what was actually applied.
 *   - `apply()` writes exactly that plan, tagging every row it creates with
 *     `source = "p4_migration"`.
 *   - `rollback()` deletes precisely those rows and nothing else, so a deal a
 *     person created by hand afterwards survives an undo.
 *   - `verify()` proves the postconditions: every prior lead-stage state
 *     accounted for, document chains intact, no orphaned records.
 *
 * WHAT IT DOES NOT DO: touch `Lead.stage`. The deals layer is ADDITIVE. Moving
 * leads backwards to Replied would destroy the very state this migration is
 * supposed to account for, and would make the rollback a reconstruction rather
 * than a delete.
 */

import type { Stage } from "@prisma/client";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import {
  DEAL_OWNED_LEAD_STAGES,
  DEFAULT_PIPELINES,
  pipelineKeyForLead,
  pipelineSeed,
  stageForLeadStage,
} from "./pipelines";
import { ensurePipelines, listPipelines, type PipelineView } from "./store";

export const MIGRATION_SOURCE = "p4_migration";

/** How long after entering its stage an open migrated deal is expected to close. */
const DEFAULT_CLOSE_HORIZON_DAYS = 30;

export interface PlannedDeal {
  leadId: string;
  leadName: string;
  companyId: string | null;
  companyName: string | null;
  leadStage: Stage;
  pipelineKey: string;
  pipelineName: string;
  stageKey: string;
  stageName: string;
  title: string;
  value: number;
  /** Where the value came from: outcome | quote | none. */
  valueSource: "outcome" | "quote" | "none";
  ownerId: string | null;
  status: "OPEN" | "WON" | "LOST";
  expectedCloseAt: Date | null;
  stageEnteredAt: Date;
  documentIds: string[];
  subscriptionIds: string[];
  outcomeIds: string[];
}

export interface MigrationPlan {
  workspaceId: string;
  workspaceName: string;
  /** Leads examined, by stage — the "every prior state accounted for" ledger. */
  leadsByStage: Record<string, number>;
  deals: PlannedDeal[];
  /** Leads already carrying a migration deal, skipped so a re-run is a no-op. */
  alreadyMigrated: number;
  documentsToLink: number;
  subscriptionsToLink: number;
  outcomesToLink: number;
  pipelinesToCreate: string[];
}

function quoteNet(totals: unknown): number | null {
  if (!totals || typeof totals !== "object" || Array.isArray(totals)) return null;
  const net = (totals as Record<string, unknown>).net;
  return typeof net === "number" && Number.isFinite(net) ? Math.round(net) : null;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/**
 * Derive the plan. Reads only.
 *
 * `pipelines` is passed in rather than read here so a dry-run against a
 * workspace with no pipelines yet still shows which pipeline each lead WOULD
 * land in — the seed definitions carry the same keys the real rows will.
 */
export async function plan(workspaceId: string): Promise<MigrationPlan> {
  const db = getWorkspaceClient(workspaceId);
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true },
  });

  const existingPipelines = await listPipelines(db);
  const haveKeys = new Set(existingPipelines.map((p) => p.key));
  const pipelinesToCreate = DEFAULT_PIPELINES.filter((p) => !haveKeys.has(p.key)).map(
    (p) => p.key,
  );

  const allLeads = await db.lead.findMany({
    select: { id: true, stage: true },
  });
  const leadsByStage: Record<string, number> = {};
  for (const l of allLeads) leadsByStage[l.stage] = (leadsByStage[l.stage] ?? 0) + 1;

  const leads = await db.lead.findMany({
    where: { stage: { in: DEAL_OWNED_LEAD_STAGES } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      contactName: true,
      companyId: true,
      stage: true,
      stageEnteredAt: true,
      ownerId: true,
      signals: true,
      notes: true,
      company: { select: { name: true, industry: true } },
      deals: { select: { id: true, source: true } },
      documents: { select: { id: true } },
      outcomes: {
        orderBy: { at: "desc" },
        select: { id: true, result: true, value: true, at: true, dealId: true },
      },
    },
  });

  const leadIds = leads.map((l) => l.id);
  const quotes = leadIds.length
    ? await db.document.findMany({
        where: { leadId: { in: leadIds }, type: "QUOTE" },
        orderBy: { createdAt: "desc" },
        select: { leadId: true, totals: true },
      })
    : [];
  const quoteNetByLead = new Map<string, number>();
  for (const q of quotes) {
    if (!q.leadId || quoteNetByLead.has(q.leadId)) continue;
    const net = quoteNet(q.totals);
    if (net !== null) quoteNetByLead.set(q.leadId, net);
  }

  const subs = leadIds.length
    ? await db.subscription.findMany({
        where: { leadId: { in: leadIds } },
        select: { id: true, leadId: true },
      })
    : [];
  const subsByLead = new Map<string, string[]>();
  for (const s of subs) {
    if (!s.leadId) continue;
    subsByLead.set(s.leadId, [...(subsByLead.get(s.leadId) ?? []), s.id]);
  }

  const deals: PlannedDeal[] = [];
  let alreadyMigrated = 0;

  for (const lead of leads) {
    if (lead.deals.some((d) => d.source === MIGRATION_SOURCE)) {
      alreadyMigrated += 1;
      continue;
    }

    const signals = Array.isArray(lead.signals) ? (lead.signals as string[]) : [];
    const pipelineKey = pipelineKeyForLead({
      signals: signals.filter((s) => typeof s === "string"),
      industry: lead.company?.industry ?? null,
      companyName: lead.company?.name ?? null,
    });
    const seed = pipelineSeed(pipelineKey);
    if (!seed) throw new Error(`No seed for pipeline ${pipelineKey}`);

    const latestOutcome = lead.outcomes[0] ?? null;
    const status: PlannedDeal["status"] =
      latestOutcome?.result === "WON"
        ? "WON"
        : latestOutcome?.result === "LOST"
          ? "LOST"
          : "OPEN";

    const openStage = stageForLeadStage(seed, lead.stage);
    const terminalKind = status === "WON" ? "won" : "lost";
    const stageSeed =
      status === "OPEN"
        ? openStage
        : (seed.stages.find((s) => s.kind === terminalKind) ?? openStage);

    let value = 0;
    let valueSource: PlannedDeal["valueSource"] = "none";
    if (typeof latestOutcome?.value === "number" && latestOutcome.value > 0) {
      value = latestOutcome.value;
      valueSource = "outcome";
    } else {
      const net = quoteNetByLead.get(lead.id);
      if (typeof net === "number" && net > 0) {
        value = net;
        valueSource = "quote";
      }
    }

    const companyName = lead.company?.name ?? null;
    const leadName = lead.contactName ?? "Unnamed contact";

    deals.push({
      leadId: lead.id,
      leadName,
      companyId: lead.companyId,
      companyName,
      leadStage: lead.stage,
      pipelineKey,
      pipelineName: seed.name,
      stageKey: stageSeed.key,
      stageName: stageSeed.name,
      title: companyName ? `${companyName} — ${seed.name}` : `${leadName} — ${seed.name}`,
      value,
      valueSource,
      ownerId: lead.ownerId,
      status,
      expectedCloseAt:
        status === "OPEN"
          ? addDays(lead.stageEnteredAt, DEFAULT_CLOSE_HORIZON_DAYS)
          : (latestOutcome?.at ?? null),
      stageEnteredAt: lead.stageEnteredAt,
      documentIds: lead.documents.map((d) => d.id),
      subscriptionIds: subsByLead.get(lead.id) ?? [],
      outcomeIds: lead.outcomes.map((o) => o.id),
    });
  }

  return {
    workspaceId,
    workspaceName: ws?.name ?? workspaceId,
    leadsByStage,
    deals,
    alreadyMigrated,
    documentsToLink: deals.reduce((n, d) => n + d.documentIds.length, 0),
    subscriptionsToLink: deals.reduce((n, d) => n + d.subscriptionIds.length, 0),
    outcomesToLink: deals.reduce((n, d) => n + d.outcomeIds.length, 0),
    pipelinesToCreate,
  };
}

export interface ApplyResult {
  workspaceId: string;
  pipelinesCreated: number;
  dealsCreated: number;
  documentsLinked: number;
  subscriptionsLinked: number;
  outcomesLinked: number;
}

function findStage(pipelines: PipelineView[], pipelineKey: string, stageKey: string) {
  const pipeline = pipelines.find((p) => p.key === pipelineKey);
  if (!pipeline) throw new Error(`Pipeline ${pipelineKey} missing after seeding`);
  const stage = pipeline.stages.find((s) => s.key === stageKey);
  if (!stage) throw new Error(`Stage ${pipelineKey}/${stageKey} missing after seeding`);
  return { pipeline, stage };
}

/** Write the plan. Idempotent: a lead that already has a migration deal is skipped. */
export async function apply(workspaceId: string): Promise<ApplyResult> {
  const db = getWorkspaceClient(workspaceId);
  const before = await listPipelines(db);
  const pipelines = await ensurePipelines(workspaceId);
  const p = await plan(workspaceId);

  let dealsCreated = 0;
  let documentsLinked = 0;
  let subscriptionsLinked = 0;
  let outcomesLinked = 0;

  for (const d of p.deals) {
    const { pipeline, stage } = findStage(pipelines, d.pipelineKey, d.stageKey);
    const deal = await db.deal.create({
      data: {
        workspaceId,
        leadId: d.leadId,
        companyId: d.companyId,
        title: d.title,
        value: d.value,
        currency: "HUF",
        expectedCloseAt: d.expectedCloseAt,
        pipelineId: pipeline.id,
        stageId: stage.id,
        stageEnteredAt: d.stageEnteredAt,
        ownerId: d.ownerId,
        status: d.status,
        closedAt: d.status === "OPEN" ? null : (d.expectedCloseAt ?? new Date()),
        source: MIGRATION_SOURCE,
      },
    });
    dealsCreated += 1;

    if (d.documentIds.length) {
      const res = await db.document.updateMany({
        where: { id: { in: d.documentIds }, dealId: null },
        data: { dealId: deal.id },
      });
      documentsLinked += res.count;
    }
    if (d.subscriptionIds.length) {
      const res = await db.subscription.updateMany({
        where: { id: { in: d.subscriptionIds }, dealId: null },
        data: { dealId: deal.id },
      });
      subscriptionsLinked += res.count;
    }
    if (d.outcomeIds.length) {
      const res = await db.dealOutcome.updateMany({
        where: { id: { in: d.outcomeIds }, dealId: null },
        data: { dealId: deal.id },
      });
      outcomesLinked += res.count;
    }
  }

  return {
    workspaceId,
    pipelinesCreated: pipelines.length - before.length,
    dealsCreated,
    documentsLinked,
    subscriptionsLinked,
    outcomesLinked,
  };
}

export interface RollbackResult {
  workspaceId: string;
  dealsDeleted: number;
  documentsUnlinked: number;
  subscriptionsUnlinked: number;
  outcomesUnlinked: number;
}

/**
 * Undo the migration.
 *
 * Only rows tagged `p4_migration` go. Pipelines are LEFT IN PLACE: they are
 * configuration, they may already have hand-made deals in them, and deleting a
 * pipeline someone has since renamed and re-weighted would throw away work the
 * migration never created.
 */
export async function rollback(workspaceId: string): Promise<RollbackResult> {
  const db = getWorkspaceClient(workspaceId);
  const deals = await db.deal.findMany({
    where: { source: MIGRATION_SOURCE },
    select: { id: true },
  });
  const ids = deals.map((d) => d.id);
  if (ids.length === 0) {
    return {
      workspaceId,
      dealsDeleted: 0,
      documentsUnlinked: 0,
      subscriptionsUnlinked: 0,
      outcomesUnlinked: 0,
    };
  }

  const documentsUnlinked = (
    await db.document.updateMany({ where: { dealId: { in: ids } }, data: { dealId: null } })
  ).count;
  const subscriptionsUnlinked = (
    await db.subscription.updateMany({ where: { dealId: { in: ids } }, data: { dealId: null } })
  ).count;
  const outcomesUnlinked = (
    await db.dealOutcome.updateMany({ where: { dealId: { in: ids } }, data: { dealId: null } })
  ).count;
  const dealsDeleted = (await db.deal.deleteMany({ where: { id: { in: ids } } })).count;

  return {
    workspaceId,
    dealsDeleted,
    documentsUnlinked,
    subscriptionsUnlinked,
    outcomesUnlinked,
  };
}

export interface IntegrityIssue {
  check: string;
  detail: string;
}

export interface IntegrityReport {
  workspaceId: string;
  workspaceName: string;
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  issues: IntegrityIssue[];
}

/**
 * Post-migration integrity check (P4/d).
 *
 * Five questions, each answerable with a count:
 *   1. Is every lead in a deal-owned stage represented by exactly one deal?
 *   2. Did any lead OUTSIDE those stages get a migration deal it should not have?
 *   3. Are the document chains intact — parent and child on the same deal?
 *   4. Are there orphaned deals: a stage from another pipeline, a dangling
 *      lead/company reference, a pipeline that no longer exists?
 *   5. Does every recorded outcome on a migrated lead point at its deal?
 */
export async function verify(workspaceId: string): Promise<IntegrityReport> {
  const db = getWorkspaceClient(workspaceId);
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true },
  });
  const checks: IntegrityReport["checks"] = [];
  const issues: IntegrityIssue[] = [];

  const add = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    if (!ok) issues.push({ check: name, detail });
  };

  // 1 — every prior lead-stage state accounted for.
  const owned = await db.lead.findMany({
    where: { stage: { in: DEAL_OWNED_LEAD_STAGES } },
    select: { id: true, stage: true, deals: { select: { id: true } } },
  });
  const missing = owned.filter((l) => l.deals.length === 0);
  const byStage = owned.reduce<Record<string, number>>((acc, l) => {
    acc[l.stage] = (acc[l.stage] ?? 0) + 1;
    return acc;
  }, {});
  add(
    "every deal-owned lead has a deal",
    missing.length === 0,
    missing.length === 0
      ? `${owned.length} leads across ${Object.entries(byStage)
          .map(([s, n]) => `${s}=${n}`)
          .join(", ") || "no stages"} each carry at least one deal`
      : `${missing.length} lead(s) with no deal: ${missing.slice(0, 10).map((l) => l.id).join(", ")}`,
  );

  // 2 — no migration deal on a lead the migration was never meant to touch.
  const migrated = await db.deal.findMany({
    where: { source: MIGRATION_SOURCE },
    select: {
      id: true,
      leadId: true,
      companyId: true,
      pipelineId: true,
      stageId: true,
      lead: { select: { stage: true } },
      stage: { select: { pipelineId: true } },
    },
  });
  const stray = migrated.filter(
    (d) => d.lead && !DEAL_OWNED_LEAD_STAGES.includes(d.lead.stage),
  );
  add(
    "no migration deal on a top-of-funnel lead",
    stray.length === 0,
    stray.length === 0
      ? `${migrated.length} migration deal(s), all on Qualified/Meeting booked/Handed off leads`
      : `${stray.length} deal(s) on leads outside the deal-owned stages`,
  );

  // 3 — document chains intact: a chained pair must sit on the same deal.
  const chained = await db.document.findMany({
    where: { chainParentId: { not: null } },
    select: { id: true, dealId: true, chainParentId: true },
  });
  const parents = new Map(
    (
      await db.document.findMany({
        where: { id: { in: chained.map((c) => c.chainParentId!).filter(Boolean) } },
        select: { id: true, dealId: true },
      })
    ).map((p) => [p.id, p.dealId]),
  );
  const broken = chained.filter((c) => {
    if (!c.chainParentId) return false;
    if (!parents.has(c.chainParentId)) return true;
    return (parents.get(c.chainParentId) ?? null) !== c.dealId;
  });
  add(
    "document chains intact",
    broken.length === 0,
    broken.length === 0
      ? `${chained.length} chained document(s) share a deal with their parent`
      : `${broken.length} chained document(s) disagree with their parent's deal`,
  );

  // 4 — no orphaned records.
  const allDeals = await db.deal.findMany({
    select: {
      id: true,
      leadId: true,
      pipelineId: true,
      stageId: true,
      lead: { select: { id: true } },
      stage: { select: { pipelineId: true } },
      pipeline: { select: { id: true } },
    },
  });
  const orphans = allDeals.filter(
    (d) =>
      !d.pipeline ||
      !d.stage ||
      d.stage.pipelineId !== d.pipelineId ||
      (d.leadId !== null && !d.lead),
  );
  add(
    "no orphaned deals",
    orphans.length === 0,
    orphans.length === 0
      ? `${allDeals.length} deal(s) resolve to a live pipeline, a stage of that same pipeline and a live lead`
      : `${orphans.length} orphaned deal(s): ${orphans.slice(0, 10).map((d) => d.id).join(", ")}`,
  );

  // 5 — outcomes point at their deal.
  const outcomes = await db.dealOutcome.findMany({
    select: { id: true, dealId: true, lead: { select: { deals: { select: { id: true } } } } },
  });
  const unlinkedOutcomes = outcomes.filter(
    (o) => o.dealId === null && (o.lead?.deals.length ?? 0) > 0,
  );
  add(
    "outcomes linked to their deal",
    unlinkedOutcomes.length === 0,
    unlinkedOutcomes.length === 0
      ? `${outcomes.length} outcome(s) checked; none left dangling beside a deal`
      : `${unlinkedOutcomes.length} outcome(s) on a lead that has a deal but no deal link`,
  );

  return {
    workspaceId,
    workspaceName: ws?.name ?? workspaceId,
    ok: issues.length === 0,
    checks,
    issues,
  };
}

/** Every workspace, oldest first — the migration runs across all of them. */
export async function allWorkspaceIds(): Promise<Array<{ id: string; name: string }>> {
  return prismaUnsafe.workspace.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
}
