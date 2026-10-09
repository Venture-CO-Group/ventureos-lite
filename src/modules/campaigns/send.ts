import { loadSendingPolicy } from "../mail/sending-domains";
import { assertColdBulkDomain, ColdSenderError } from "../mail/sending-policy";
import type { WorkspaceClient } from "../../lib/db";
import { getMailProvider, MailStreamError } from "../mail/provider";
import { coldUnsubscribeLink } from "../../lib/public-links";
import { resolveColdIdentity } from "./identity";
import { slotsForLead } from "./segment";
import {
  coldEmailAllowed,
  circuitBreakerTripped,
  warmupDailyCap,
  warmupWeekIndex,
  buildRecipientSends,
  type ColdStep,
} from "./logic";
import { notifyCampaignPaused } from "../notifications/notify";

/** Thrown by every send path when cold email is not sign-off-approved. */
export class ColdGateError extends Error {
  constructor() {
    super("Cold email is locked for this workspace — record counsel sign-off first.");
    this.name = "ColdGateError";
  }
}

export function assertColdAllowed(featureFlags: unknown): void {
  if (!coldEmailAllowed(featureFlags)) throw new ColdGateError();
}

/**
 * Suppress an address across the ENTIRE workspace (shared list, spec §4.16).
 * Adds it to the suppression list and flips every matching campaign recipient —
 * so an unsubscribe or objection instantly stops it in all campaigns.
 */
export async function suppressAddress(
  db: WorkspaceClient,
  workspaceId: string,
  address: string,
  reason: string,
): Promise<number> {
  await db.suppression.upsert({
    where: { workspaceId_address: { workspaceId, address } },
    update: { reason },
    create: { workspaceId, address, reason },
  });
  const { count } = await db.campaignRecipient.updateMany({
    where: { email: address },
    data: { suppressed: true },
  });
  return count;
}

/** Bounce-rate circuit breaker: auto-pause a campaign over the threshold. */
export async function evaluateCircuitBreaker(
  db: WorkspaceClient,
  campaignId: string,
): Promise<{ tripped: boolean; sent: number; bounced: number }> {
  const [sent, bounced] = await Promise.all([
    db.campaignRecipient.count({ where: { campaignId, sentAt: { not: null } } }),
    db.campaignRecipient.count({ where: { campaignId, bounced: true } }),
  ]);
  const tripped = circuitBreakerTripped(sent, bounced);
  if (tripped) {
    await db.campaign.update({ where: { id: campaignId }, data: { status: "PAUSED" } });
    const paused = await db.campaign.findUnique({
      where: { id: campaignId },
      select: { name: true, workspaceId: true },
    });
    // P6/1 — Owners only: a tripped breaker is a deliverability incident, and
    // the Owner is who decides whether the campaign resumes.
    await notifyCampaignPaused({
      workspaceId: paused!.workspaceId,
      campaignId,
      name: paused?.name ?? "Cold campaign",
      reason: `Bounce rate over the threshold (${bounced}/${sent}).`,
    });
  }
  return { tripped, sent, bounced };
}

/** Stop-on-reply: an inbound reply marks the recipient so no further steps go out. */
export async function markReplied(
  db: WorkspaceClient,
  leadId: string,
  nowMs: number,
): Promise<void> {
  await db.campaignRecipient.updateMany({
    where: { leadId, repliedAt: null },
    data: { repliedAt: new Date(nowMs) },
  });
}

export interface SendContext {
  workspaceId: string;
  featureFlags: unknown;
  mailgunConfig: unknown;
  nowMs: number;
}

/**
 * Send the next due step of a campaign (spec §4.16). GATED — throws without
 * sign-off. Respects suppression, stop-on-reply, warm-up ramp + daily cap, sends
 * on the SEPARATE cold domain with a mandatory unsubscribe footer, then checks
 * the circuit breaker. The frame was drafted ONCE at campaign creation; this
 * path renders per-recipient with pure template fill (no AI).
 */
export async function runCampaignSend(
  db: WorkspaceClient,
  campaignId: string,
  ctx: SendContext,
): Promise<{ sent: number; skipped?: string }> {
  assertColdAllowed(ctx.featureFlags); // hard gate

  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    include: { steps: { orderBy: { stepNumber: "asc" } } },
  });
  if (!campaign) return { sent: 0, skipped: "not-found" };
  if (campaign.status !== "ACTIVE") return { sent: 0, skipped: "not-active" };
  if (campaign.steps.length === 0) return { sent: 0, skipped: "no-steps" };

  const week = warmupWeekIndex(campaign.startedAt ? campaign.startedAt.getTime() : null, ctx.nowMs);
  const dayStart = new Date(new Date(ctx.nowMs).toISOString().slice(0, 10));
  const sentToday = await db.campaignRecipient.count({
    where: { campaignId, sentAt: { gte: dayStart } },
  });
  const allowance = Math.max(0, warmupDailyCap(week, campaign.dailyCap) - sentToday);
  if (allowance === 0) return { sent: 0, skipped: "daily-cap" };

  // Eligible: not suppressed, not replied, still has a next step to send.
  const eligible = await db.campaignRecipient.findMany({
    where: {
      campaignId,
      suppressed: false,
      repliedAt: null,
      stepSent: { lt: campaign.steps.length },
    },
    take: allowance,
    orderBy: { stepSent: "asc" },
  });
  if (eligible.length === 0) return { sent: 0, skipped: "nobody-due" };

  const identity = resolveColdIdentity(ctx.mailgunConfig, ctx.featureFlags);
  // Per-workspace rule 11: the cold domain may not share a registrable domain
  // with this workspace's transactional domain, nor be another workspace's.
  // A violation is a misconfiguration — it aborts the run like a stream error.
  try {
    assertColdBulkDomain(identity.domain, await loadSendingPolicy(ctx.workspaceId));
  } catch (e) {
    if (e instanceof ColdSenderError) throw new MailStreamError(e.message);
    throw e;
  }
  const mail = getMailProvider();

  let sent = 0;
  for (const r of eligible) {
    const stepIndex = r.stepSent; // next step (0-based)
    const step = campaign.steps[stepIndex];
    const coldStep: ColdStep = { stepNumber: step.stepNumber, subject: step.subject, body: step.body };
    const slots = r.leadId ? await slotsForLead(db, r.leadId) : {};
    const unsubUrl = coldUnsubscribeLink(r.id);
    const [rendered] = buildRecipientSends(coldStep, [{ address: r.email, slots, unsubUrl }]);

    try {
      const { id } = await mail.send({
        domain: identity.domain,
        stream: "cold", // pins the cold key + cold domain; provider rejects any drift
        to: r.email,
        from: identity.from,
        subject: rendered.subject,
        html: rendered.body.replace(/\n/g, "<br>"),
        text: rendered.body,
      });
      await db.campaignRecipient.update({
        where: { id: r.id },
        data: { sentAt: new Date(ctx.nowMs), stepSent: stepIndex + 1 },
      });
      await db.emailLog.create({
        data: { workspaceId: ctx.workspaceId, leadId: r.leadId ?? undefined, to: r.email, subject: rendered.subject, mailgunId: id, status: "QUEUED" },
      });
      sent += 1;
    } catch (e) {
      // A stream/domain violation is a misconfiguration, not a flaky network:
      // swallowing it would retry a forbidden send forever. Abort the run.
      if (e instanceof MailStreamError) throw e;
      /* transient send failure — retried next run */
    }
  }

  await evaluateCircuitBreaker(db, campaignId);
  return { sent };
}
