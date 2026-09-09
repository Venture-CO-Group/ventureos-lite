/**
 * Reading and provisioning the deals layer (playbook-v2 P4).
 *
 * Everything here goes through the workspace-guarded client — deals, pipelines
 * and stages are business tables and carry workspace_id like everything else.
 */

import type { WorkspaceClient } from "@/lib/db";
import { getWorkspaceClient } from "@/lib/db";
import { openTaskCounts } from "@/modules/tasks/entity-tasks";
import {
  DEFAULT_PIPELINES,
  DEFAULT_PIPELINE_KEY,
  type PipelineSeed,
} from "./pipelines";
import {
  daysInStage,
  effectiveProbability,
  isRotting,
  type DealLike,
} from "./logic";

export interface StageView {
  id: string;
  key: string;
  name: string;
  position: number;
  probability: number;
  rottingDays: number | null;
  kind: string;
}

export interface PipelineView {
  id: string;
  key: string;
  name: string;
  position: number;
  isDefault: boolean;
  stages: StageView[];
}

/**
 * Create the two default pipelines for a workspace that has none.
 *
 * Idempotent and additive: an existing pipeline is left exactly as the
 * workspace has configured it, including renamed stages and re-weighted
 * probabilities. Re-running this must never undo somebody's tuning.
 */
export async function ensurePipelines(
  workspaceId: string,
  seeds: PipelineSeed[] = DEFAULT_PIPELINES,
): Promise<PipelineView[]> {
  const db = getWorkspaceClient(workspaceId);
  for (const seed of seeds) {
    const existing = await db.pipeline.findFirst({ where: { key: seed.key } });
    if (existing) continue;
    await db.pipeline.create({
      data: {
        workspaceId,
        key: seed.key,
        name: seed.name,
        position: seed.position,
        isDefault: seed.isDefault,
        stages: {
          create: seed.stages.map((s, i) => ({
            workspaceId,
            key: s.key,
            name: s.name,
            position: i,
            probability: s.probability,
            rottingDays: s.rottingDays,
            kind: s.kind,
          })),
        },
      },
    });
  }
  return listPipelines(db);
}

export async function listPipelines(db: WorkspaceClient): Promise<PipelineView[]> {
  const rows = await db.pipeline.findMany({
    where: { archived: false },
    orderBy: { position: "asc" },
    include: { stages: { orderBy: { position: "asc" } } },
  });
  return rows.map((p) => ({
    id: p.id,
    key: p.key,
    name: p.name,
    position: p.position,
    isDefault: p.isDefault,
    stages: p.stages.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      position: s.position,
      probability: s.probability,
      rottingDays: s.rottingDays,
      kind: s.kind,
    })),
  }));
}

/** The pipeline a new deal lands in when the caller has no preference. */
export function defaultPipeline(pipelines: PipelineView[]): PipelineView | null {
  return (
    pipelines.find((p) => p.isDefault) ??
    pipelines.find((p) => p.key === DEFAULT_PIPELINE_KEY) ??
    pipelines[0] ??
    null
  );
}

export interface DealCardView {
  id: string;
  title: string;
  value: number;
  currency: string;
  probability: number;
  /** True when the number above came from the stage, not from the deal. */
  inheritedProbability: boolean;
  expectedCloseAt: string | null;
  stageId: string;
  pipelineId: string;
  status: "OPEN" | "WON" | "LOST";
  daysInStage: number;
  rotting: boolean;
  leadId: string | null;
  leadName: string | null;
  companyId: string | null;
  companyName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  /** Document types present on this deal, for the chain dots. */
  chainTypes: string[];
  invoiceStatus: string | null;
  /**
   * The delivery checklist, once there is one (P11/2).
   *
   * Null on a won deal is the interesting state: it is the moment the board
   * offers to start one, and the reason a signed contract stops drifting
   * towards a certificate nobody issues.
   */
  projectId: string | null;
  /**
   * Open tasks on this deal (playbook-v5 P20/4) — the badge on the card.
   *
   * A deal nobody has anything to do next on is the one that quietly rots, so
   * the number belongs where the board is read rather than one click inside.
   */
  openTaskCount: number;
}

/**
 * Every deal on one pipeline, with the card decorations the board needs.
 *
 * Loaded per pipeline rather than per workspace: the board shows one at a time,
 * and reading every deal in the workspace to render one column set is exactly
 * the kind of query P6/3 has to come back and undo.
 */
export const DEAL_STAGE_PAGE_SIZE = 25;

export async function loadPipelineBoard(
  workspaceId: string,
  pipelineId: string,
  opts?: { now?: Date; ownerNames?: Map<string, string>; perStage?: number },
): Promise<DealCardView[]> {
  const db = getWorkspaceClient(workspaceId);
  const now = opts?.now ?? new Date();
  const perStage = Math.max(1, Math.min(400, opts?.perStage ?? DEAL_STAGE_PAGE_SIZE));

  // Capped PER STAGE rather than per board (P6/3): a board-wide limit empties
  // the late columns, because the oldest cards are all in the first one. One
  // query per column costs a handful of round trips and keeps every column
  // showing its own oldest cards.
  const stages = await db.dealStage.findMany({
    where: { pipelineId },
    orderBy: { position: "asc" },
    select: { id: true },
  });
  const perStageDeals = await Promise.all(
    stages.map((stage) =>
      db.deal.findMany({
        where: { pipelineId, stageId: stage.id },
        orderBy: [{ stageEnteredAt: "asc" }],
        take: perStage,
        include: {
          stage: { select: { probability: true, rottingDays: true } },
          lead: { select: { contactName: true } },
          company: { select: { name: true } },
          documents: { select: { id: true, type: true } },
        },
      }),
    ),
  );
  const deals = perStageDeals.flat();

  const docIds = deals.flatMap((d) => d.documents.map((doc) => doc.id));
  const invoices = docIds.length
    ? await db.invoice.findMany({
        where: { documentId: { in: docIds } },
        orderBy: { at: "desc" },
        select: { documentId: true, status: true },
      })
    : [];
  // One query for the whole board rather than one per card.
  const projects = await db.project.findMany({
    where: { dealId: { in: deals.map((d) => d.id) } },
    select: { id: true, dealId: true },
  });
  const projectByDeal = new Map(projects.map((p) => [p.dealId, p.id]));

  const invoiceByDoc = new Map<string, string>();
  for (const inv of invoices) {
    if (inv.documentId && !invoiceByDoc.has(inv.documentId)) {
      invoiceByDoc.set(inv.documentId, inv.status);
    }
  }

  /**
   * One query for every card's open-task count, from both the fast path and
   * the link table (playbook-v5 P20/4).
   */
  const taskCounts = await openTaskCounts(
    workspaceId,
    "deal",
    deals.map((d) => d.id),
  );

  return deals.map((d) => {
    const chainTypes = [...new Set(d.documents.map((doc) => doc.type as string))];
    const invoiceStatus =
      d.documents.map((doc) => invoiceByDoc.get(doc.id)).find((s) => !!s) ?? null;
    return {
      id: d.id,
      title: d.title,
      value: d.value,
      currency: d.currency,
      probability: effectiveProbability({
        probability: d.probability,
        stageProbability: d.stage.probability,
        status: d.status,
      }),
      inheritedProbability: d.probability === null,
      expectedCloseAt: d.expectedCloseAt ? d.expectedCloseAt.toISOString().slice(0, 10) : null,
      stageId: d.stageId,
      pipelineId: d.pipelineId,
      status: d.status,
      daysInStage: daysInStage(d.stageEnteredAt, now),
      rotting: isRotting({
        status: d.status,
        stageEnteredAt: d.stageEnteredAt,
        rottingDays: d.stage.rottingDays,
        now,
      }),
      leadId: d.leadId,
      leadName: d.lead?.contactName ?? null,
      companyId: d.companyId,
      companyName: d.company?.name ?? null,
      ownerId: d.ownerId,
      ownerName: d.ownerId ? (opts?.ownerNames?.get(d.ownerId) ?? null) : null,
      chainTypes,
      invoiceStatus,
      projectId: projectByDeal.get(d.id) ?? null,
      openTaskCount: taskCounts.get(d.id) ?? 0,
    };
  });
}

/** How many deals sit in each stage of a pipeline, capped board or not. */
export async function stageTotals(
  workspaceId: string,
  pipelineId: string,
): Promise<Record<string, number>> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.deal.groupBy({
    by: ["stageId"],
    where: { pipelineId },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.stageId, r._count._all]));
}

/** Every open deal in the workspace, shaped for the forecast maths. */
export async function loadForecastDeals(
  workspaceId: string,
  opts?: { pipelineId?: string },
): Promise<Array<DealLike & { pipelineId: string }>> {
  const db = getWorkspaceClient(workspaceId);
  const deals = await db.deal.findMany({
    where: opts?.pipelineId ? { pipelineId: opts.pipelineId } : {},
    select: {
      id: true,
      value: true,
      probability: true,
      expectedCloseAt: true,
      status: true,
      pipelineId: true,
      stage: { select: { probability: true } },
    },
  });
  return deals.map((d) => ({
    id: d.id,
    value: d.value,
    probability: d.probability,
    stageProbability: d.stage.probability,
    expectedCloseAt: d.expectedCloseAt,
    status: d.status,
    pipelineId: d.pipelineId,
  }));
}

/**
 * Which leads already have a deal, so the lead board can say so and link
 * across (P4/b — "document the boundary clearly in the UI"). Two boards that
 * never mention each other is how a split like this confuses people.
 */
export async function dealChipsForLeads(
  workspaceId: string,
  leadIds: string[],
): Promise<Map<string, { dealId: string; value: number; status: string }>> {
  const out = new Map<string, { dealId: string; value: number; status: string }>();
  if (leadIds.length === 0) return out;
  const db = getWorkspaceClient(workspaceId);
  const deals = await db.deal.findMany({
    where: { leadId: { in: leadIds } },
    orderBy: { createdAt: "desc" },
    select: { id: true, leadId: true, value: true, status: true },
  });
  for (const d of deals) {
    if (!d.leadId || out.has(d.leadId)) continue;
    out.set(d.leadId, { dealId: d.id, value: d.value, status: d.status });
  }
  return out;
}

/** The deals attached to a lead, for the lead modal's cross-link (P4/b). */
export async function dealsForLead(
  db: WorkspaceClient,
  leadId: string,
): Promise<
  Array<{
    id: string;
    title: string;
    value: number;
    status: string;
    stageName: string;
    pipelineName: string;
  }>
> {
  const deals = await db.deal.findMany({
    where: { leadId },
    orderBy: { createdAt: "desc" },
    include: {
      stage: { select: { name: true } },
      pipeline: { select: { name: true } },
    },
  });
  return deals.map((d) => ({
    id: d.id,
    title: d.title,
    value: d.value,
    status: d.status,
    stageName: d.stage.name,
    pipelineName: d.pipeline.name,
  }));
}
