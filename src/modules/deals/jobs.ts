import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { notifyProposalPending } from "@/modules/notifications/notify";
import { MIN_CALIBRATION_N, probabilityProposals, type StageWinLoss } from "./logic";

/**
 * Quarterly stage-probability recalibration (playbook-v2 P4/c).
 *
 * "Win/loss data updates stage default probabilities QUARTERLY as a Signal
 * Engine proposal (approval queue, min n=20) — never silently."
 *
 * Deterministic: no Claude call, no budget cost. The rate a stage actually
 * converts at is arithmetic, and asking a model to do arithmetic is how a
 * probability becomes a guess.
 *
 * What counts as a stage's record: every deal that has PASSED THROUGH it and
 * has since closed. We do not have a per-stage transition log, so the honest
 * proxy is the stage a closed deal sits in against the stages before it in the
 * pipeline — a deal that reached Negotiation and won also proves Qualified
 * converts. Reading only the terminal stage's own record would tell us the win
 * rate of Won (100%) and Lost (0%), which is no information at all.
 */
export async function processStageProbabilityCalibration(): Promise<number> {
  const workspaces = await prismaUnsafe.workspace.findMany({ where: { deletedAt: null }, select: { id: true } });
  let raisedTotal = 0;

  for (const ws of workspaces) {
    const db = getWorkspaceClient(ws.id);
    const pipelines = await db.pipeline.findMany({
      where: { archived: false },
      include: { stages: { orderBy: { position: "asc" } } },
    });
    if (pipelines.length === 0) continue;

    const closed = await db.deal.findMany({
      where: { status: { in: ["WON", "LOST"] } },
      select: { pipelineId: true, stageId: true, status: true },
    });
    if (closed.length === 0) continue;

    const records: StageWinLoss[] = [];
    for (const pipeline of pipelines) {
      const openStages = pipeline.stages.filter((s) => s.kind === "open");
      const positionOf = new Map(pipeline.stages.map((s) => [s.id, s.position]));

      for (const stage of openStages) {
        let won = 0;
        let lost = 0;
        for (const deal of closed) {
          if (deal.pipelineId !== pipeline.id) continue;
          const reached = positionOf.get(deal.stageId);
          // A deal that closed in a terminal stage sits past every open one, so
          // it counts for all of them; one that closed early counts only for
          // the stages it actually reached.
          if (reached === undefined || reached < stage.position) continue;
          if (deal.status === "WON") won += 1;
          else lost += 1;
        }
        records.push({
          stageId: stage.id,
          stageName: stage.name,
          pipelineName: pipeline.name,
          currentProbability: stage.probability,
          won,
          lost,
        });
      }
    }

    const proposals = probabilityProposals(records, { minN: MIN_CALIBRATION_N });
    if (proposals.length === 0) continue;

    // Idempotency, same rule as the weekly engine: never stack a second copy of
    // a proposal that is still waiting for a decision.
    const pending = await db.proposal.findMany({
      where: { status: "PENDING" },
      select: { title: true },
    });
    const pendingTitles = new Set(pending.map((p) => p.title));

    let raised = 0;
    for (const p of proposals) {
      const title = `${p.pipelineName} · ${p.stageName}: ${p.currentProbability}% → ${p.suggested}%`;
      if (pendingTitles.has(title)) continue;
      await db.proposal.create({
        data: {
          workspaceId: ws.id,
          kind: "STAGE_PROBABILITY",
          title,
          evidence:
            `${p.won} won and ${p.lost} lost out of ${p.n} closed deals that reached ` +
            `${p.stageName}. Observed ${p.observed}%, configured ${p.currentProbability}%.`,
          n: p.n,
          data: { stageId: p.stageId, probability: p.suggested },
        },
      });
      raised += 1;
    }

    if (raised > 0) {
      await notifyProposalPending({ workspaceId: ws.id, count: raised });
      raisedTotal += raised;
    }
  }

  return raisedTotal;
}
