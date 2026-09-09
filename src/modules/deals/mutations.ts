/**
 * Deal mutations, workspace-id in rather than session-derived (playbook-v2 P4/b).
 *
 * Split out of `actions.ts` for the same reason `leads/bulk-store.ts` is split
 * out of `leads/bulk-actions.ts`: a `"use server"` file resolves its tenant from
 * a cookie, which a test has no way to supply. The rules that matter — the
 * conversion gate, the cross-pipeline stage refusal, status following the board
 * — therefore live here, where they can be proven against a real database.
 *
 * Every path goes through the workspace-guarded client, so an id from another
 * tenant resolves to nothing (CLAUDE.md hard rule #1).
 */

import { z } from "zod";
import { getWorkspaceClient } from "@/lib/db";
import { emitWebhookEvent } from "../webhooks/emit";
import { DEAL_OWNED_LEAD_STAGES, DEFAULT_PIPELINES } from "./pipelines";
import { defaultPipeline, ensurePipelines, listPipelines } from "./store";
import { recordUndo, type UndoToken } from "@/modules/undo/store";

export type DealResult = { ok: true; dealId: string } | { ok: false; error: string };
export type MoveResult = { ok: true; undo?: UndoToken | null } | { ok: false; error: string };

export const createDealSchema = z.object({
  title: z.string().trim().min(1).max(200),
  leadId: z.string().min(1).optional(),
  companyId: z.string().min(1).optional(),
  pipelineId: z.string().min(1).optional(),
  stageId: z.string().min(1).optional(),
  value: z.number().int().min(0).max(100_000_000_000).default(0),
  expectedCloseAt: z.string().optional(),
  ownerId: z.string().min(1).optional(),
});

function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function createDealIn(
  workspaceId: string,
  actorUserId: string | null,
  raw: unknown,
): Promise<DealResult> {
  const parsed = createDealSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That deal is missing something." };
  const input = parsed.data;
  const db = getWorkspaceClient(workspaceId);

  let pipelines = await listPipelines(db);
  if (pipelines.length === 0) pipelines = await ensurePipelines(workspaceId, DEFAULT_PIPELINES);
  const pipeline = pipelines.find((p) => p.id === input.pipelineId) ?? defaultPipeline(pipelines);
  if (!pipeline) return { ok: false, error: "This workspace has no pipeline to put a deal in." };

  const stage =
    pipeline.stages.find((s) => s.id === input.stageId) ??
    pipeline.stages.find((s) => s.kind === "open");
  if (!stage) return { ok: false, error: "That pipeline has no open stage." };

  const deal = await db.deal.create({
    data: {
      workspaceId,
      title: input.title,
      leadId: input.leadId ?? null,
      companyId: input.companyId ?? null,
      pipelineId: pipeline.id,
      stageId: stage.id,
      value: input.value,
      expectedCloseAt: parseDate(input.expectedCloseAt),
      ownerId: input.ownerId ?? actorUserId,
    },
  });
  return { ok: true, dealId: deal.id };
}

/**
 * Turn a qualified lead into a deal, pre-filled from what is already known.
 *
 * Refuses a lead that has not reached the money journey: converting a
 * Researched lead would put a number on a conversation that has not happened,
 * and a forecast is only worth something if nothing in it is invented.
 */
export async function convertLeadIn(
  workspaceId: string,
  raw: unknown,
): Promise<DealResult> {
  const parsed = z
    .object({
      leadId: z.string().min(1),
      pipelineId: z.string().min(1).optional(),
      title: z.string().trim().max(200).optional(),
      value: z.number().int().min(0).max(100_000_000_000).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown lead." };
  const db = getWorkspaceClient(workspaceId);

  const lead = await db.lead.findUnique({
    where: { id: parsed.data.leadId },
    include: {
      company: { select: { id: true, name: true } },
      documents: {
        where: { type: "QUOTE" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { totals: true },
      },
    },
  });
  if (!lead) return { ok: false, error: "Lead not found." };
  if (!DEAL_OWNED_LEAD_STAGES.includes(lead.stage)) {
    return {
      ok: false,
      error:
        "Only a qualified lead becomes a deal. Move it to Qualified, Meeting booked or Handed off first.",
    };
  }

  let pipelines = await listPipelines(db);
  if (pipelines.length === 0) pipelines = await ensurePipelines(workspaceId, DEFAULT_PIPELINES);
  const pipeline =
    pipelines.find((p) => p.id === parsed.data.pipelineId) ?? defaultPipeline(pipelines);
  if (!pipeline) return { ok: false, error: "This workspace has no pipeline to put a deal in." };

  const totals = lead.documents[0]?.totals;
  const quoteNet =
    totals && typeof totals === "object" && !Array.isArray(totals)
      ? Number((totals as Record<string, unknown>).net)
      : Number.NaN;

  const created = await createDealIn(workspaceId, lead.ownerId, {
    title:
      parsed.data.title ||
      `${lead.company?.name ?? lead.contactName ?? "Untitled"} — ${pipeline.name}`,
    leadId: lead.id,
    companyId: lead.companyId ?? undefined,
    pipelineId: pipeline.id,
    value:
      parsed.data.value ?? (Number.isFinite(quoteNet) && quoteNet > 0 ? Math.round(quoteNet) : 0),
    ownerId: lead.ownerId ?? undefined,
  });

  if (created.ok) {
    await db.activity.create({
      data: {
        workspaceId,
        leadId: lead.id,
        type: "deal_created",
        payload: { dealId: created.dealId, pipeline: pipeline.name },
      },
    });
  }
  return created;
}

/**
 * Move a deal to another stage of its OWN pipeline.
 *
 * Landing on a terminal stage closes the deal, and leaving one reopens it —
 * status follows the board rather than needing a second click, because a card
 * sitting in "Won" that still counts as open is the kind of disagreement a
 * forecast never recovers from.
 */
export async function moveStageIn(
  workspaceId: string,
  actorUserId: string | null,
  dealId: string,
  stageId: string,
  opts?: { lostReason?: string; now?: Date },
): Promise<MoveResult> {
  const db = getWorkspaceClient(workspaceId);

  const deal = await db.deal.findUnique({
    where: { id: dealId },
    select: {
      id: true,
      pipelineId: true,
      stageId: true,
      leadId: true,
      // For the undo's inverse, captured before the move overwrites them.
      stageEnteredAt: true,
      status: true,
      closedAt: true,
      lostReason: true,
    },
  });
  if (!deal) return { ok: false, error: "Deal not found." };

  const stage = await db.dealStage.findUnique({
    where: { id: stageId },
    select: { id: true, pipelineId: true, kind: true, name: true },
  });
  if (!stage) return { ok: false, error: "Stage not found." };
  if (stage.pipelineId !== deal.pipelineId) {
    return { ok: false, error: "That stage belongs to a different pipeline." };
  }
  if (deal.stageId === stage.id) return { ok: true };
  if (stage.kind === "lost" && !opts?.lostReason?.trim()) {
    return { ok: false, error: "A reason is required to mark a deal lost." };
  }

  const now = opts?.now ?? new Date();
  const status = stage.kind === "won" ? "WON" : stage.kind === "lost" ? "LOST" : "OPEN";
  await db.deal.update({
    where: { id: dealId },
    data: {
      stageId: stage.id,
      stageEnteredAt: now,
      status,
      closedAt: status === "OPEN" ? null : now,
      lostReason: status === "LOST" ? (opts?.lostReason?.trim() ?? null) : null,
    },
  });

  if (deal.leadId) {
    await db.activity.create({
      data: {
        workspaceId,
        leadId: deal.leadId,
        type: "deal_stage_change",
        byUserId: actorUserId,
        payload: { dealId, to: stage.name, status },
      },
    });
  }

  // Outbound (P5/5.2). Best-effort by construction — emit swallows its own
  // failures — and queued rather than sent, so nobody's slow endpoint holds a
  // drag-and-drop open.
  await emitWebhookEvent(workspaceId, "deal.stage_changed", {
    dealId,
    from: deal.stageId,
    to: stage.id,
    stageName: stage.name,
    status,
    leadId: deal.leadId,
  });
  if (status === "WON") {
    // A separate event, because "a deal was won" is the one an integration
    // wants to route on its own and picking it out of stage_changed means
    // knowing our stage names.
    await emitWebhookEvent(workspaceId, "deal.won", {
      dealId,
      stageName: stage.name,
      leadId: deal.leadId,
      closedAt: now.toISOString(),
    });
  }

  // Undoable (P7/2). The inverse restores the status and the closed-at stamp
  // as well as the stage: dragging out of Won and back must not leave a deal
  // that says OPEN in a column called Won.
  const undoToken = actorUserId
    ? await recordUndo(workspaceId, actorUserId, {
        kind: "deal_stage",
        label: `Moved to ${stage.name}`,
        inverse: {
          entity: "deal",
          targets: [
            {
              id: dealId,
              set: {
                stageId: deal.stageId,
                stageEnteredAt: deal.stageEnteredAt.toISOString(),
                status: deal.status,
                closedAt: deal.closedAt ? deal.closedAt.toISOString() : null,
                lostReason: deal.lostReason,
              },
            },
          ],
        },
        expected: { [dealId]: { stageId: stage.id, status } },
      })
    : null;

  return { ok: true, undo: undoToken };
}
