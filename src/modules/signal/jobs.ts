import { prismaUnsafe, getWorkspaceClient } from "../../lib/db";
import { callClaude } from "../../lib/ai/call-claude";
import {
  SIGNAL_ENGINE_SYSTEM,
  signalEngineSchema,
  buildSignalMessage,
  type SignalEngineOutput,
} from "../../lib/ai/prompts/signal-engine";
import {
  DAILY_INSIGHT_SYSTEM,
  dailyInsightSchema,
  buildDailyMessage,
  type DailyInsight,
} from "../../lib/ai/prompts/daily-insight";
import { aggregateWeek, filterEligibleProposals, type ProposalDraft, type ProposalKind } from "./logic";
import { getWeekFacts, weekWindow } from "./data";
import { notifyProposalPending } from "../notifications/notify";
import { outboundSignal } from "../outbound/signal";

/**
 * Weekly Signal Engine (spec §4.13). ONE Sonnet call per workspace on the
 * week's aggregates → a WEEKLY Insight digest + PENDING proposals (n>=20 only).
 * Nothing self-modifies: proposals wait for Owner approval. Returns workspaces
 * processed.
 */
export async function processSignalEngine(nowMs: number = Date.now()): Promise<number> {
  const { sinceMs, untilMs } = weekWindow(nowMs);
  const workspaces = await prismaUnsafe.workspace.findMany({ select: { id: true } });

  let processed = 0;
  for (const ws of workspaces) {
    const db = getWorkspaceClient(ws.id);
    const facts = await getWeekFacts(db, sinceMs, untilMs);
    // The outbound motor's week joins the same analysis (playbook-v6 F6/4).
    const outbound = await outboundSignal(db, new Date(sinceMs)).catch(() => ({ stats: [], proposals: [] }));
    const stats = [...aggregateWeek(facts), ...outbound.stats];

    let output: SignalEngineOutput | null = null;
    try {
      const { data } = await callClaude<SignalEngineOutput>({
        useCase: "signal_engine",
        workspaceId: ws.id,
        system: SIGNAL_ENGINE_SYSTEM,
        schema: signalEngineSchema,
        messages: [{ role: "user", content: buildSignalMessage(stats) }],
      });
      output = data as SignalEngineOutput;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[signal] weekly analysis failed for ${ws.id}`, e);
      continue;
    }

    // Weekly digest → Insight (WEEKLY). The Dashboard's daily card rotates over this.
    await db.insight.create({
      data: {
        workspaceId: ws.id,
        kind: "WEEKLY",
        body: output.digest,
        data: { window: { sinceMs, untilMs }, proposalCount: output.proposals.length },
      },
    });

    // Build proposal drafts, resolve frame names, GATE at n>=20 (code, not model).
    const drafts: ProposalDraft[] = [];
    for (const p of output.proposals) {
      if (p.kind === "FRAME_PROMOTION") {
        if (!p.frameName) continue;
        const frame = await db.frame.findFirst({ where: { name: p.frameName }, select: { id: true } });
        drafts.push({
          kind: "FRAME_PROMOTION",
          title: p.title,
          evidence: p.evidence,
          n: p.n,
          data: { frameName: p.frameName, frameId: frame?.id ?? null },
        });
      } else {
        if (!p.criterion || p.weight == null) continue;
        drafts.push({
          kind: "SCORE_WEIGHT",
          title: p.title,
          evidence: p.evidence,
          n: p.n,
          data: { criterion: p.criterion, weight: p.weight },
        });
      }
    }
    // Outbound proposals are computed, not generated, and pass the same n≥20 gate.
    const eligible = filterEligibleProposals([...drafts, ...outbound.proposals]);

    // Idempotency: don't duplicate a still-pending proposal with the same title.
    const pending = await db.proposal.findMany({
      where: { status: "PENDING" },
      select: { title: true },
    });
    const pendingTitles = new Set(pending.map((p) => p.title));
    let raised = 0;
    for (const d of eligible) {
      if (pendingTitles.has(d.title)) continue;
      await db.proposal.create({
        data: {
          workspaceId: ws.id,
          kind: d.kind as ProposalKind,
          title: d.title,
          evidence: d.evidence,
          n: d.n,
          data: d.data,
        },
      });
      raised += 1;
    }
    // P6/1 — one notification for the batch, not one per proposal: the Owner
    // reviews the queue, not each row.
    await notifyProposalPending({ workspaceId: ws.id, count: raised });
    processed += 1;
  }
  return processed;
}

/**
 * Daily insight (spec §4.13). ONE Haiku call per workspace, rotating over the
 * latest weekly digest — no re-analysis. Writes a DAILY Insight for the
 * Dashboard card. Idempotent per day. Returns workspaces updated.
 */
export async function processDailyInsight(nowMs: number = Date.now()): Promise<number> {
  const workspaces = await prismaUnsafe.workspace.findMany({ select: { id: true } });
  const today = new Date(nowMs);
  const dayStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const dayIndex = today.getUTCDay();

  let updated = 0;
  for (const ws of workspaces) {
    const db = getWorkspaceClient(ws.id);

    // Skip if a daily insight already exists today (one call/day).
    const existing = await db.insight.findFirst({
      where: { kind: "DAILY", createdAt: { gte: new Date(dayStart) } },
      select: { id: true },
    });
    if (existing) continue;

    const weekly = await db.insight.findFirst({
      where: { kind: "WEEKLY" },
      orderBy: { createdAt: "desc" },
      select: { body: true },
    });
    if (!weekly) continue;

    try {
      const { data } = await callClaude<DailyInsight>({
        useCase: "daily_insight",
        workspaceId: ws.id,
        system: DAILY_INSIGHT_SYSTEM,
        schema: dailyInsightSchema,
        messages: [{ role: "user", content: buildDailyMessage(weekly.body, dayIndex) }],
      });
      const insight = data as DailyInsight;
      await db.insight.create({
        data: { workspaceId: ws.id, kind: "DAILY", body: insight.insight },
      });
      updated += 1;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[signal] daily insight failed for ${ws.id}`, e);
    }
  }
  return updated;
}
