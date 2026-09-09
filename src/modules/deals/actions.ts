"use server";

import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { workspaceMembers } from "@/modules/leads/table";
import { DEFAULT_PIPELINES } from "./pipelines";
import { onDealStageChanged } from "@/modules/workflow/triggers";
import {
  createDealIn,
  convertLeadIn,
  moveStageIn,
  type DealResult,
  type MoveResult,
} from "./mutations";
import {
  defaultPipeline,
  ensurePipelines,
  listPipelines,
  loadPipelineBoard,
  stageTotals,
  DEAL_STAGE_PAGE_SIZE,
  type DealCardView,
  type PipelineView,
} from "./store";

/**
 * The session-facing surface of the deals layer (playbook-v2 P4/b).
 *
 * Thin by design: every rule lives in `mutations.ts`, where a test can reach it
 * without a cookie. What is left here is resolving the tenant from the session
 * and telling Next which pages to revalidate.
 */

export interface DealsBoardData {
  pipelines: PipelineView[];
  activePipelineId: string | null;
  cards: DealCardView[];
  members: Array<{ id: string; name: string }>;
  /** Deals per stage, so a capped column can say what it is hiding (P6/3). */
  totals: Record<string, number>;
  shown: number;
  pageSize: number;
}

export async function getDealsBoard(
  pipelineId?: string,
  perStage?: number,
): Promise<DealsBoardData> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  let pipelines = await listPipelines(db);
  // A workspace created before P4 has no pipelines. Provisioning on first view
  // rather than only in a migration means a brand-new workspace is never
  // staring at an empty screen it cannot fix from the UI.
  if (pipelines.length === 0) pipelines = await ensurePipelines(workspaceId, DEFAULT_PIPELINES);

  const active = pipelines.find((p) => p.id === pipelineId) ?? defaultPipeline(pipelines) ?? null;
  const members = await workspaceMembers(workspaceId);
  const ownerNames = new Map(members.map((m) => [m.id, m.name]));

  const shown = Math.max(1, Math.min(400, perStage || DEAL_STAGE_PAGE_SIZE));
  return {
    pipelines,
    activePipelineId: active?.id ?? null,
    cards: active
      ? await loadPipelineBoard(workspaceId, active.id, { ownerNames, perStage: shown })
      : [],
    members,
    totals: active ? await stageTotals(workspaceId, active.id) : {},
    shown,
    pageSize: DEAL_STAGE_PAGE_SIZE,
  };
}


export async function convertLeadToDeal(raw: unknown): Promise<DealResult> {
  const { workspaceId } = await getActiveContext();
  const res = await convertLeadIn(workspaceId, raw);
  if (res.ok) {
    revalidatePath("/deals");
    revalidatePath("/leads");
    revalidatePath("/pipeline");
  }
  return res;
}

export async function moveDealStage(
  dealId: string,
  stageId: string,
  opts?: { lostReason?: string },
): Promise<MoveResult> {
  const { workspaceId, userId } = await getActiveContext();
  const res = await moveStageIn(workspaceId, userId, dealId, stageId, opts);
  if (res.ok) {
    await onDealStageChanged(workspaceId, dealId);
    revalidatePath("/deals");
    revalidatePath("/analytics");
  }
  return res;
}


export interface LeadDealLink {
  id: string;
  title: string;
  value: number;
  status: string;
  stageName: string;
  pipelineName: string;
}

/** The deals hanging off one lead, for the lead modal's cross-link. */
export async function getDealsForLead(leadId: string): Promise<LeadDealLink[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const deals = await db.deal.findMany({
    where: { leadId },
    orderBy: { createdAt: "desc" },
    include: { stage: { select: { name: true } }, pipeline: { select: { name: true } } },
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

