"use server";

import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";
import { proposalEffect, type ProposalKind } from "./logic";

export interface ProposalView {
  id: string;
  kind: ProposalKind;
  title: string;
  evidence: string;
  n: number;
  status: string;
  createdAt: string;
}

export async function listProposals(): Promise<ProposalView[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.proposal.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  return rows.map((p) => ({
    id: p.id,
    kind: p.kind,
    title: p.title,
    evidence: p.evidence,
    n: p.n,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
  }));
}

/**
 * Approve a proposal (spec §4.13). This is the ONLY path that mutates the frame
 * library or score weights — the weekly job never does. Owner-gated and audited.
 */
export async function approveProposal(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireGrant("signal_engine.approve");
  } catch {
    return { ok: false, error: "Only an Owner can approve proposals." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const proposal = await db.proposal.findUnique({ where: { id } });
  if (!proposal) return { ok: false, error: "Proposal not found." };
  if (proposal.status !== "PENDING") return { ok: false, error: "Proposal already decided." };

  const data = (proposal.data ?? {}) as Record<string, unknown>;

  if (proposal.kind === "FRAME_PROMOTION") {
    const frameId = data.frameId ? String(data.frameId) : null;
    if (!frameId) return { ok: false, error: "The referenced frame no longer exists." };
    const frame = await db.frame.findUnique({ where: { id: frameId }, select: { version: true } });
    if (!frame) return { ok: false, error: "The referenced frame no longer exists." };
    const effect = proposalEffect("FRAME_PROMOTION", data, "approve", {
      currentFrameVersion: frame.version,
    });
    if (effect?.type !== "frame") return { ok: false, error: "Invalid proposal." };
    // Versions the frame library — the approved frame supersedes prior versions.
    await db.frame.update({
      where: { id: frameId },
      data: { version: effect.version, status: "APPROVED" },
    });
  } else if (proposal.kind === "STAGE_PROBABILITY") {
    // v2 P4/c. The stage is looked up through the guarded client, so an
    // approval cannot reach a stage in another workspace even if the stored
    // proposal data were tampered with.
    const effect = proposalEffect("STAGE_PROBABILITY", data, "approve", {});
    if (effect?.type !== "stage_probability") return { ok: false, error: "Invalid proposal." };
    const stage = await db.dealStage.findUnique({
      where: { id: effect.stageId },
      select: { id: true },
    });
    if (!stage) return { ok: false, error: "That pipeline stage no longer exists." };
    await db.dealStage.update({
      where: { id: effect.stageId },
      data: { probability: effect.probability },
    });
  } else {
    const effect = proposalEffect("SCORE_WEIGHT", data, "approve", {});
    if (effect?.type !== "weight") return { ok: false, error: "Invalid proposal." };
    // Updates score weights in the workspace ICP config.
    const ws = await prismaUnsafe.workspace.findUnique({
      where: { id: workspaceId },
      select: { icpConfig: true },
    });
    const cfg =
      ws?.icpConfig && typeof ws.icpConfig === "object" && !Array.isArray(ws.icpConfig)
        ? (ws.icpConfig as Record<string, unknown>)
        : {};
    const weights =
      cfg.scoreWeights && typeof cfg.scoreWeights === "object" && !Array.isArray(cfg.scoreWeights)
        ? (cfg.scoreWeights as Record<string, number>)
        : {};
    weights[effect.criterion] = effect.weight;
    await prismaUnsafe.workspace.update({
      where: { id: workspaceId },
      data: { icpConfig: { ...cfg, scoreWeights: weights } },
    });
  }

  await db.proposal.update({
    where: { id },
    data: { status: "APPROVED", decidedAt: new Date(), decidedByUserId: userId },
  });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "proposal.approve",
      entityType: "Proposal",
      entityId: id,
      meta: { kind: proposal.kind, title: proposal.title, n: proposal.n },
    },
  });

  revalidatePath("/settings");
  revalidatePath("/");
  revalidatePath("/analytics");
  return { ok: true };
}

/** Reject a proposal — records the decision, mutates nothing. */
export async function rejectProposal(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireGrant("signal_engine.approve");
  } catch {
    return { ok: false, error: "Only an Owner can reject proposals." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const proposal = await db.proposal.findUnique({ where: { id }, select: { status: true } });
  if (!proposal) return { ok: false, error: "Proposal not found." };
  if (proposal.status !== "PENDING") return { ok: false, error: "Proposal already decided." };

  await db.proposal.update({
    where: { id },
    data: { status: "REJECTED", decidedAt: new Date(), decidedByUserId: userId },
  });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "proposal.reject",
      entityType: "Proposal",
      entityId: id,
    },
  });
  revalidatePath("/settings");
  return { ok: true };
}

/** Latest daily insight for the Dashboard card (falls back to weekly digest). */
export async function getLatestInsight(): Promise<{ body: string; kind: string } | null> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const daily = await db.insight.findFirst({
    where: { kind: "DAILY" },
    orderBy: { createdAt: "desc" },
    select: { body: true },
  });
  if (daily) return { body: daily.body, kind: "DAILY" };
  const weekly = await db.insight.findFirst({
    where: { kind: "WEEKLY" },
    orderBy: { createdAt: "desc" },
    select: { body: true },
  });
  return weekly ? { body: weekly.body, kind: "WEEKLY" } : null;
}
