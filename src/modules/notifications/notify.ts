/**
 * The emitters (playbook-v2 P6/1): one function per event that actually
 * happens in this codebase.
 *
 * Call sites are one-liners on purpose, and NONE OF THESE THROW. A notification
 * is a side effect of something that has already happened — a reply that
 * arrived, a quote that was accepted, a campaign that paused. Letting the bell
 * fail that event would trade a real outcome for a cosmetic one, so every
 * emitter swallows and logs.
 *
 * Each type here is wired to a real emitter. The playbook also lists "meeting
 * cancelled" and "import failure"; neither has an event in this codebase, and
 * the reasoning is recorded in types.ts rather than stubbed here.
 */

import { getWorkspaceClient } from "@/lib/db";
import { deliverNotification, type DeliverInput } from "./store";
import { sendPushToUsers } from "./push";
import { allMembers, leadAndOwners, leadRecipients, workspaceOwners } from "./recipients";
import { sendNotificationEmails } from "./email-now";

/**
 * Deliver in-app, then push to whoever asked for it.
 *
 * The store returns the push audience rather than sending itself, so it can
 * stay free of network I/O and testable. Push failure is swallowed separately
 * from in-app failure: a dead phone endpoint must not lose the bell entry.
 */
/**
 * Exported for the workflow engine (v2 P7/5), which raises a notification for
 * an event this module has no opinion about. Everything else in here goes
 * through a named helper below, and should keep doing so — a named helper is
 * where the copy and the dedupe rule for a notification type live.
 */
export async function safeDeliver(input: DeliverInput): Promise<void> {
  let pushUserIds: string[] = [];
  let emailUserIds: string[] = [];
  try {
    ({ pushUserIds, emailUserIds } = await deliverNotification(input));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[notify] ${input.type} failed`, e);
    return;
  }

  /**
   * The immediate-email channel (P8/2).
   *
   * Fired before push, because it is the one that reaches somebody who does
   * not have the app open — which is the whole reason it exists. Its own
   * module swallows every failure, so no `try` is needed here beyond the one
   * around the delivery itself.
   */
  if (emailUserIds.length > 0) {
    await sendNotificationEmails(input.workspaceId, emailUserIds, {
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      href: input.href,
    });
  }

  if (pushUserIds.length === 0) return;
  try {
    await sendPushToUsers(input.workspaceId, pushUserIds, {
      title: input.title,
      body: input.body ?? null,
      href: input.href,
      tag: input.type,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[notify] push for ${input.type} failed`, e);
  }
}

/** A lead's display name, for copy. Never throws — falls back to something. */
async function leadLabel(workspaceId: string, leadId: string | null): Promise<string> {
  if (!leadId) return "a lead";
  try {
    const db = getWorkspaceClient(workspaceId);
    const lead = await db.lead.findUnique({
      where: { id: leadId },
      select: { contactName: true, company: { select: { name: true } } },
    });
    return lead?.contactName ?? lead?.company?.name ?? "a lead";
  } catch {
    return "a lead";
  }
}

// ---- inbox ---------------------------------------------------------------

export async function notifyReplyReceived(params: {
  workspaceId: string;
  leadId: string | null;
  threadId: string;
  snippet: string | null;
}): Promise<void> {
  // A reply on nothing is not news — only threads matched to a lead notify.
  if (!params.leadId) return;
  const [name, userIds] = await Promise.all([
    leadLabel(params.workspaceId, params.leadId),
    leadRecipients(params.workspaceId, params.leadId),
  ]);
  await safeDeliver({
    workspaceId: params.workspaceId,
    userIds,
    type: "reply_received",
    title: `${name} replied`,
    body: params.snippet?.slice(0, 160) ?? null,
    href: `/inbox?lead=${params.leadId}`,
    entityType: "lead",
    entityId: params.leadId,
    // One per MESSAGE, not per thread: two replies are two pieces of news.
    discriminator: params.threadId,
  });
}

export async function notifyEscalation(params: {
  workspaceId: string;
  leadId: string;
  reason: string;
}): Promise<void> {
  const [name, userIds] = await Promise.all([
    leadLabel(params.workspaceId, params.leadId),
    leadAndOwners(params.workspaceId, params.leadId),
  ]);
  await safeDeliver({
    workspaceId: params.workspaceId,
    userIds,
    type: "escalation",
    title: `${name} mentioned ${params.reason}`,
    body: "Money talk — this one is escalated to the Owner.",
    href: `/inbox?lead=${params.leadId}`,
    entityType: "lead",
    entityId: params.leadId,
  });
}

// ---- calls ---------------------------------------------------------------

export async function notifyCallbackDue(params: {
  workspaceId: string;
  leadId: string;
  callId: string;
  byUserId: string | null;
}): Promise<void> {
  const name = await leadLabel(params.workspaceId, params.leadId);
  // The person who promised the callback owes it; if the call was logged
  // without a user, it falls to whoever owns the lead.
  const userIds = params.byUserId
    ? [params.byUserId]
    : await leadRecipients(params.workspaceId, params.leadId);
  await safeDeliver({
    workspaceId: params.workspaceId,
    userIds,
    type: "callback_due",
    title: `Callback due — ${name}`,
    body: "You scheduled a callback for now.",
    href: "/calls",
    entityType: "call",
    entityId: params.callId,
  });
}

// ---- tasks ---------------------------------------------------------------

export async function notifyTaskDue(params: {
  workspaceId: string;
  taskId: string;
  title: string;
  assigneeId: string | null;
  overdue: boolean;
  /** Date stamp, so an overdue task nags once a day rather than once ever. */
  day: string;
}): Promise<void> {
  // Unassigned tasks belong to everyone, exactly as the Today Queue shows them.
  const userIds = params.assigneeId
    ? [params.assigneeId]
    : await allMembers(params.workspaceId);
  await safeDeliver({
    workspaceId: params.workspaceId,
    userIds,
    type: "task_due",
    title: params.overdue ? `Overdue: ${params.title}` : `Due now: ${params.title}`,
    body: params.overdue ? "This task is past its due time." : null,
    href: "/",
    entityType: "task",
    entityId: params.taskId,
    discriminator: params.day,
  });
}

// ---- documents -----------------------------------------------------------

export async function notifyQuoteAccepted(params: {
  workspaceId: string;
  documentId: string;
  leadId: string | null;
  number: string;
  acceptedBy: string;
}): Promise<void> {
  const userIds = await leadAndOwners(params.workspaceId, params.leadId);
  await safeDeliver({
    workspaceId: params.workspaceId,
    userIds,
    type: "quote_accepted",
    title: `Quote ${params.number} accepted`,
    body: `${params.acceptedBy} accepted it. The contract can be generated now.`,
    href: `/documents/${params.documentId}`,
    entityType: "document",
    entityId: params.documentId,
  });
}

export async function notifyQuoteDeclined(params: {
  workspaceId: string;
  documentId: string;
  leadId: string | null;
  number: string;
}): Promise<void> {
  const userIds = await leadAndOwners(params.workspaceId, params.leadId);
  await safeDeliver({
    workspaceId: params.workspaceId,
    userIds,
    type: "quote_declined",
    title: `Quote ${params.number} declined`,
    href: `/documents/${params.documentId}`,
    entityType: "document",
    entityId: params.documentId,
  });
}

// ---- meetings ------------------------------------------------------------

export async function notifyMeetingBooked(params: {
  workspaceId: string;
  meetingId: string;
  leadId: string | null;
  hostUserId: string | null;
  scheduledAt: Date;
}): Promise<void> {
  const owners = await workspaceOwners(params.workspaceId);
  const userIds = [...new Set([...(params.hostUserId ? [params.hostUserId] : []), ...owners])];
  const name = await leadLabel(params.workspaceId, params.leadId);
  await safeDeliver({
    workspaceId: params.workspaceId,
    userIds,
    type: "meeting_booked",
    title: `Meeting booked — ${name}`,
    body: params.scheduledAt.toISOString().slice(0, 16).replace("T", " "),
    href: "/meetings",
    entityType: "meeting",
    entityId: params.meetingId,
  });
}

// ---- campaigns -----------------------------------------------------------

export async function notifyCampaignPaused(params: {
  workspaceId: string;
  campaignId: string;
  name: string;
  reason: string;
}): Promise<void> {
  const userIds = await workspaceOwners(params.workspaceId);
  await safeDeliver({
    workspaceId: params.workspaceId,
    userIds,
    type: "campaign_paused",
    title: `Campaign paused — ${params.name}`,
    body: params.reason,
    href: "/campaigns",
    entityType: "campaign",
    entityId: params.campaignId,
    // A campaign that trips, is resumed and trips again is news each time.
    discriminator: new Date().toISOString().slice(0, 10),
  });
}

// ---- mailbox sync --------------------------------------------------------

export async function notifySyncFailed(params: {
  workspaceId: string;
  accountId: string;
  userId: string;
  address: string;
  health: string;
}): Promise<void> {
  const reconnect = params.health === "reconnect_needed";
  await safeDeliver({
    workspaceId: params.workspaceId,
    // Only the mailbox's owner: nobody else can fix it, and nobody else should
    // be told about the state of someone's personal mail connection.
    userIds: [params.userId],
    type: "sync_failed",
    title: reconnect ? `Reconnect ${params.address}` : `Mailbox sync problem`,
    body: reconnect
      ? "The connection expired — reconnect it in Settings → Email."
      : `${params.address} stopped syncing.`,
    href: "/settings?tab=email",
    entityType: "mailAccount",
    entityId: params.accountId,
    // Once a day while it stays broken, rather than every two minutes.
    discriminator: new Date().toISOString().slice(0, 10),
  });
}

// ---- signal engine -------------------------------------------------------

/**
 * A sign-in happened on this account (playbook-v2 P6/2).
 *
 * Addressed to the account owner and nobody else — this is the one notification
 * that is about the person rather than about the work, and a colleague seeing
 * where you signed in from is a privacy problem, not a security feature.
 *
 * The dedupe discriminator is device + IP + day: signing in three times from
 * the same laptop on one morning is one event worth telling you about, and a
 * bell that fills with your own logins is a bell nobody reads.
 */
export async function notifyNewLogin(params: {
  workspaceId: string;
  userId: string;
  device: string;
  ip: string | null;
  at: Date;
}): Promise<void> {
  const where = params.ip ? ` from ${params.ip}` : "";
  await safeDeliver({
    workspaceId: params.workspaceId,
    userIds: [params.userId],
    type: "new_login",
    title: `New sign-in — ${params.device}`,
    body: `Signed in${where} at ${params.at.toISOString().slice(0, 16).replace("T", " ")}. If this was not you, change your password and revoke the session.`,
    href: "/settings?security=password",
    entityType: "session",
    entityId: params.userId,
    discriminator: `${params.device}|${params.ip ?? "-"}|${params.at.toISOString().slice(0, 10)}`,
  });
}

export async function notifyProposalPending(params: {
  workspaceId: string;
  count: number;
}): Promise<void> {
  if (params.count === 0) return;
  const userIds = await workspaceOwners(params.workspaceId);
  await safeDeliver({
    workspaceId: params.workspaceId,
    userIds,
    type: "proposal_pending",
    title: `${params.count} Signal Engine proposal${params.count === 1 ? "" : "s"} waiting`,
    body: "The weekly analysis suggested changes that need approval.",
    href: "/settings?tab=signal",
    entityType: "proposal",
    entityId: "weekly",
    discriminator: new Date().toISOString().slice(0, 10),
  });
}
