/**
 * Sending approved outbound mail from the cold Gmail mailbox (playbook-v6
 * F5, spec §4.43.9).
 *
 * `sendTick` runs every few minutes and sends AT MOST ONE message: the next
 * approved draft that is due, if the mailbox is connected, the counsel
 * sign-off is recorded, sending is not paused, it is business hours, today's
 * warm-up cap has room, and the jittered gap since the last send has passed.
 * One per tick is the spacing — a burst is the one thing a warming mailbox
 * must never do.
 *
 * The same tick then reads what came back: bounces (circuit breaker),
 * replies (stop the sequence, move the lead), and follow-ups that are due to
 * be drafted — which enter the approval queue like everything else. Nothing
 * leaves the system unreviewed.
 *
 * Every path here sends through Gmail as the cold identity, asserted
 * immediately before the call (CLAUDE.md hard rule 11). This module imports
 * nothing from the Mailgun campaign sender.
 */
import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getWorkspaceClient, prismaUnsafe, type WorkspaceClient } from "@/lib/db";
import { appLink } from "@/lib/public-links";
import { GmailProvider } from "@/modules/email/gmail";
import { MailAuthError, MailRateLimitError, type MailCredentials, type FetchedMessage, type MessagePage, type RefreshedCredentials } from "@/modules/email/provider";
import { htmlToText } from "@/modules/email/sanitize";
import { coldEmailAllowed } from "@/modules/campaigns/logic";
import { isRecipientSuppressed, isCompanySuppressed, domainSuppressionEntry, taxSuppressionEntry } from "@/modules/mail/suppression";
import { gateThresholdFromConfig } from "@/modules/leads/scoring";
import { onLeadStageChanged } from "@/modules/workflow/triggers";
import { safeDeliver } from "@/modules/notifications/notify";
import { workspaceOwners } from "@/modules/notifications/recipients";
import { brandFrom } from "@/modules/workspaces/brand";
import { COLD_OUTBOUND_ADDRESS, parseOutboundConfig, warmupDailyCap, type OutboundConfig } from "./config";
import { composeMessage, signatureFor, signatureHtmlToText } from "./compose";
import {
  asksToStop,
  assertColdSender,
  bouncedAddresses,
  buildColdMime,
  inSendWindow,
  isFreemail,
  localClock,
  shouldTripBreaker,
  spacingSeconds,
  ColdSenderError,
} from "./send-rules";
import { transition } from "./state";
import { domainOf } from "./pool";
import { draftFollowup, type DraftDeps } from "./draft-engine";
import { hookRequiredAndMissing, type PersonalisationPoint } from "./draft";

/** What the sender needs from Gmail — the real provider in production, a stub in tests. */
export interface GmailLike {
  sendRaw(creds: MailCredentials, input: { mime: string; threadId?: string | null }): Promise<{ providerMessageId: string; providerThreadId: string; refreshed?: RefreshedCredentials }>;
  getSendAsSignature(creds: MailCredentials, email: string): Promise<{ signatureHtml: string | null; refreshed?: RefreshedCredentials }>;
  getMessageIdHeader(creds: MailCredentials, id: string): Promise<{ messageIdHeader: string | null; refreshed?: RefreshedCredentials }>;
  listMessageIds(creds: MailCredentials, query: string, pageToken?: string): Promise<MessagePage>;
  getMessage(creds: MailCredentials, id: string): Promise<{ message: FetchedMessage; refreshed?: RefreshedCredentials }>;
}

export interface SendDeps {
  now: () => Date;
  gmail?: GmailLike;
  draft?: DraftDeps;
}

export type SendOutcome =
  | "sent"
  | "nothing_due"
  | "gate_closed"
  | "paused"
  | "no_mailbox"
  | "outside_window"
  | "cap_reached"
  | "spacing"
  | "reconnect"
  | "rate_limited"
  | "refused_sender"
  | "failed";

const SIGNATURE_TTL_MS = 24 * 3_600_000;

async function loadWorkspace(workspaceId: string) {
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { outboundConfig: true, featureFlags: true, brand: true, icpConfig: true },
  });
  return { ws, cfg: parseOutboundConfig(ws?.outboundConfig) };
}

async function saveConfig(workspaceId: string, cfg: OutboundConfig): Promise<void> {
  await prismaUnsafe.workspace.update({ where: { id: workspaceId }, data: { outboundConfig: cfg as unknown as Prisma.InputJsonValue } });
}

/** The cold mailbox and its credentials, or null when it is not connected. */
async function coldMailbox(workspaceId: string) {
  const account = await prismaUnsafe.mailAccount.findFirst({
    where: { workspaceId, accountEmail: COLD_OUTBOUND_ADDRESS, enabled: true },
  });
  if (!account?.credentialId || account.health === "reconnect_needed") return null;
  const credential = await prismaUnsafe.googleCredential.findUnique({ where: { id: account.credentialId } });
  if (!credential) return null;
  const user = await prismaUnsafe.user.findUnique({ where: { id: account.userId }, select: { name: true } });
  return {
    account,
    credentialId: credential.id,
    senderName: user?.name ?? null,
    creds: { accessToken: credential.accessToken, refreshToken: credential.refreshToken, expiryDate: credential.expiryDate } as MailCredentials,
  };
}

async function persistRefresh(credentialId: string, refreshed?: RefreshedCredentials): Promise<void> {
  if (!refreshed?.accessToken) return;
  await prismaUnsafe.googleCredential.update({
    where: { id: credentialId },
    data: { accessToken: refreshed.accessToken, ...(refreshed.expiryDate ? { expiryDate: refreshed.expiryDate } : {}) },
  });
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ---- the send ---------------------------------------------------------------------

export async function sendTick(workspaceId: string, deps: SendDeps): Promise<SendOutcome> {
  const now = deps.now();
  const db = getWorkspaceClient(workspaceId);
  const { ws, cfg } = await loadWorkspace(workspaceId);

  // The counsel sign-off gates this channel exactly as it gates campaigns.
  if (!coldEmailAllowed(ws?.featureFlags)) return "gate_closed";
  if (cfg.sending.pausedAt) return "paused";
  const due = await db.outreachDraft.findMany({
    where: { status: "APPROVED", OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }] },
    orderBy: [{ step: "desc" }, { scheduledFor: "asc" }, { decidedAt: "asc" }],
    take: 20,
  });
  if (due.length === 0) return "nothing_due";
  const box = await coldMailbox(workspaceId);
  if (!box) return "no_mailbox";
  if (!inSendWindow(now, cfg.schedule.timezone, cfg.sending.windowStartHour, cfg.sending.windowEndHour)) return "outside_window";

  const sentToday = await db.outreachDraft.count({ where: { status: "SENT", sentAt: { gte: startOfUtcDay(now) } } });
  if (sentToday >= warmupDailyCap(cfg.warmup, now)) return "cap_reached";

  const last = await db.outreachDraft.findFirst({ where: { status: "SENT" }, orderBy: { sentAt: "desc" }, select: { id: true, sentAt: true } });
  if (last?.sentAt) {
    const gap = spacingSeconds(last.id, cfg.sending.spacingMinSec, cfg.sending.spacingMaxSec) * 1000;
    if (now.getTime() - last.sentAt.getTime() < gap) return "spacing";
  }

  const suppressed = (await db.suppression.findMany({ select: { address: true } })).map((s) => s.address);
  const threshold = gateThresholdFromConfig(ws?.icpConfig);
  const gmail = deps.gmail ?? new GmailProvider();

  for (const d of due) {
    const c = await db.prospectCandidate.findUnique({ where: { id: d.candidateId } });
    if (!c) {
      await db.outreachDraft.update({ where: { id: d.id }, data: { status: "CANCELLED", sendError: "candidate gone" } });
      continue;
    }
    const expected = d.step === 0 ? "APPROVED" : "SENT";
    if (c.state !== expected) {
      await db.outreachDraft.update({ where: { id: d.id }, data: { status: "CANCELLED", sendError: `candidate is ${c.state.toLowerCase()}` } });
      continue;
    }
    // Suppression is checked at the last moment: an unsubscribe between
    // approval and send wins.
    const domain = d.toAddress.split("@")[1] ?? null;
    if (isRecipientSuppressed(d.toAddress, suppressed) || isCompanySuppressed({ domain: domainOf(c.website) ?? domain, taxNumber: c.taxNumber }, suppressed)) {
      await db.outreachDraft.update({ where: { id: d.id }, data: { status: "CANCELLED", sendError: "suppressed" } });
      continue;
    }
    const lead = c.leadId ? await db.lead.findUnique({ where: { id: c.leadId }, select: { id: true, stage: true, icpScore: true } }) : null;
    if (d.step === 0 && lead?.stage === "RESEARCHED" && (lead.icpScore ?? 0) < threshold) {
      await db.outreachDraft.update({ where: { id: d.id }, data: { status: "FAILED", sendError: "below the ICP score gate" } });
      continue;
    }
    // Hook gate at send time (rule 10) — for the machine's own text only. A
    // draft a person edited goes out on its approval; an unedited machine
    // draft that somehow lost its grounding never does.
    const points = Array.isArray(d.personalisationPoints) ? (d.personalisationPoints as unknown as PersonalisationPoint[]) : [];
    if (hookRequiredAndMissing(d, points)) {
      await db.outreachDraft.update({
        where: { id: d.id },
        data: { status: "FAILED", sendError: "unedited machine draft without a company-specific fact" },
      });
      continue;
    }
    return sendOne(db, workspaceId, { draft: d, candidate: c, lead, box, cfg, ws, gmail, now });
  }
  return "nothing_due";
}

async function sendOne(
  db: WorkspaceClient,
  workspaceId: string,
  x: {
    draft: Prisma.OutreachDraftGetPayload<object>;
    candidate: Prisma.ProspectCandidateGetPayload<object>;
    lead: { id: string; stage: string; icpScore: number | null } | null;
    box: NonNullable<Awaited<ReturnType<typeof coldMailbox>>>;
    cfg: OutboundConfig;
    ws: { brand: Prisma.JsonValue } | null;
    gmail: GmailLike;
    now: Date;
  },
): Promise<SendOutcome> {
  const { draft: d, candidate: c, box, gmail, now } = x;
  let cfg = x.cfg;

  // THE guard. Asserted on the mailbox the message is about to leave from.
  let from: string;
  try {
    from = assertColdSender(box.account.accountEmail);
  } catch (e) {
    if (e instanceof ColdSenderError) {
      await db.outreachDraft.update({ where: { id: d.id }, data: { sendError: e.message } });
      return "refused_sender";
    }
    throw e;
  }

  try {
    // The signature, fetched at most daily: the API does not add it on send.
    const fetchedAt = cfg.sending.signatureFetchedAt ? Date.parse(cfg.sending.signatureFetchedAt) : 0;
    if (!fetchedAt || now.getTime() - fetchedAt > SIGNATURE_TTL_MS) {
      const sig = await gmail.getSendAsSignature(box.creds, from);
      await persistRefresh(box.credentialId, sig.refreshed);
      cfg = {
        ...cfg,
        sending: { ...cfg.sending, cachedSignature: sig.signatureHtml ? signatureHtmlToText(sig.signatureHtml) : null, signatureFetchedAt: now.toISOString() },
      };
      await saveConfig(workspaceId, cfg);
    }
    const brand = brandFrom(x.ws?.brand);
    const signature = signatureFor(cfg.sending, { senderName: box.senderName ?? "", company: brand.name });
    const token = d.unsubscribeToken ?? randomBytes(32).toString("base64url");
    const unsubscribeUrl = appLink(`/api/outbound/unsubscribe/${token}`);
    const text = composeMessage({ body: d.body, signature, language: d.language, unsubscribeUrl });

    // Follow-ups thread under the first message, for us and for them.
    let threadId: string | null = null;
    let inReplyTo: string | null = null;
    if (d.step > 0) {
      const previous = await db.outreachDraft.findFirst({ where: { candidateId: c.id, status: "SENT" }, orderBy: { step: "desc" } });
      threadId = previous?.gmailThreadId ?? null;
      if (previous?.gmailMessageId) {
        const h = await gmail.getMessageIdHeader(box.creds, previous.gmailMessageId);
        inReplyTo = h.messageIdHeader;
      }
    }

    const mime = buildColdMime({
      from,
      fromName: box.senderName,
      to: d.toAddress,
      toName: d.toName,
      subject: d.subject,
      text,
      unsubscribeUrl,
      inReplyTo,
    });
    const res = await gmail.sendRaw(box.creds, { mime, threadId });
    await persistRefresh(box.credentialId, res.refreshed);

    await db.outreachDraft.update({
      where: { id: d.id },
      data: {
        status: "SENT",
        sentAt: now,
        sentFrom: from,
        unsubscribeToken: token,
        gmailMessageId: res.providerMessageId,
        gmailThreadId: res.providerThreadId,
        sendError: null,
      },
    });
    if (d.step === 0) {
      await transition(db, workspaceId, c, "SENT", { detail: res.providerMessageId, at: now });
      if (x.lead && x.lead.stage === "RESEARCHED") {
        await db.lead.update({ where: { id: x.lead.id }, data: { stage: "CONTACTED", stageEnteredAt: now, lastActivityAt: now } });
        await onLeadStageChanged(workspaceId, x.lead.id);
      }
    } else {
      await db.candidateEvent.create({
        data: { workspaceId, candidateId: c.id, fromState: "SENT", toState: "SENT", detail: `follow-up ${d.step} sent` },
      });
    }
    if (x.lead) {
      await db.lead.update({ where: { id: x.lead.id }, data: { lastActivityAt: now } });
      await db.activity.create({
        data: { workspaceId, leadId: x.lead.id, type: "outbound_sent", payload: { draftId: d.id, step: d.step, subject: d.subject, from } },
      });
    }
    // The ramps count from the first real send.
    if (!cfg.warmup.startedAt || !cfg.cap.startedAt) {
      await saveConfig(workspaceId, {
        ...cfg,
        warmup: { ...cfg.warmup, startedAt: cfg.warmup.startedAt ?? now.toISOString() },
        cap: { ...cfg.cap, startedAt: cfg.cap.startedAt ?? now.toISOString() },
      });
    }
    return "sent";
  } catch (e) {
    if (e instanceof MailAuthError) {
      await prismaUnsafe.mailAccount.update({ where: { id: box.account.id }, data: { health: "reconnect_needed", lastError: e.message } });
      return "reconnect";
    }
    if (e instanceof MailRateLimitError) return "rate_limited";
    await db.outreachDraft.update({ where: { id: d.id }, data: { status: "FAILED", sendError: (e as Error).message.slice(0, 300) } });
    return "failed";
  }
}

// ---- what came back ------------------------------------------------------------------

async function stopSequence(db: WorkspaceClient, candidateId: string, why: string): Promise<void> {
  await db.outreachDraft.updateMany({
    where: { candidateId, status: { in: ["PENDING", "APPROVED"] } },
    data: { status: "CANCELLED", sendError: why },
  });
}

/** Mark bounces, suppress the address, and trip the breaker when the rate says so. */
export async function processBounces(workspaceId: string, deps: SendDeps): Promise<{ bounced: number; tripped: boolean }> {
  const db = getWorkspaceClient(workspaceId);
  const box = await coldMailbox(workspaceId);
  if (!box) return { bounced: 0, tripped: false };
  const gmail = deps.gmail ?? new GmailProvider();
  const now = deps.now();
  let bounced = 0;
  const page = await gmail.listMessageIds(box.creds, "from:(mailer-daemon OR postmaster) newer_than:3d");
  await persistRefresh(box.credentialId, page.refreshed);
  for (const { messageId } of page.ids.slice(0, 25)) {
    const { message } = await gmail.getMessage(box.creds, messageId);
    const text = `${message.bodyText ?? ""}\n${htmlToText(message.bodyHtml ?? "")}`;
    for (const address of bouncedAddresses(text)) {
      const drafts = await db.outreachDraft.findMany({ where: { toAddress: address, status: "SENT", bouncedAt: null } });
      for (const d of drafts) {
        await db.outreachDraft.update({ where: { id: d.id }, data: { bouncedAt: now } });
        await stopSequence(db, d.candidateId, "bounced");
        bounced++;
      }
      if (drafts.length > 0) {
        await db.suppression.upsert({
          where: { workspaceId_address: { workspaceId, address } },
          create: { workspaceId, address, reason: "bounce" },
          update: {},
        });
      }
    }
  }

  const recent = await db.outreachDraft.findMany({
    where: { status: "SENT", sentAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
    orderBy: { sentAt: "desc" },
    take: 50,
    select: { bouncedAt: true },
  });
  const { cfg } = await loadWorkspace(workspaceId);
  const nBounced = recent.filter((r) => r.bouncedAt).length;
  if (!cfg.sending.pausedAt && shouldTripBreaker(recent.length, nBounced, cfg.sending.bounceThreshold)) {
    const reason = `Bounce rate ${Math.round((nBounced / Math.max(1, recent.length)) * 1000) / 10}% over the last ${recent.length} sends (limit ${cfg.sending.bounceThreshold * 100}%).`;
    await saveConfig(workspaceId, { ...cfg, sending: { ...cfg.sending, pausedAt: now.toISOString(), pausedReason: reason } });
    await safeDeliver({
      workspaceId,
      userIds: await workspaceOwners(workspaceId),
      type: "campaign_paused",
      title: "Outbound sending paused",
      body: reason,
      href: "/settings/admin/outbound",
      entityType: "outbound",
      entityId: workspaceId,
      discriminator: now.toISOString().slice(0, 10),
    });
    return { bounced, tripped: true };
  }
  return { bounced, tripped: false };
}

/**
 * A reply stops the sequence at once and moves the lead to Replied. The
 * Inbox already has the message (email sync); intent analysis and the
 * price-mention escalation happen there, unchanged. A reply that asks us to
 * stop is treated as an unsubscribe of the whole company.
 */
export async function processReplies(workspaceId: string, deps: SendDeps): Promise<number> {
  const db = getWorkspaceClient(workspaceId);
  const now = deps.now();
  const sent = await db.prospectCandidate.findMany({ where: { state: "SENT" }, take: 500 });
  let replied = 0;
  for (const c of sent) {
    const first = await db.outreachDraft.findFirst({ where: { candidateId: c.id, status: "SENT" }, orderBy: { step: "asc" } });
    if (!first?.sentAt) continue;
    const raw = first.toAddress.split("@")[1] ?? "";
    // A gmail.com recipient's "company domain" is everyone on Gmail.
    const domain = isFreemail(raw) ? "" : raw;
    const inbound = await db.emailMessage.findFirst({
      where: {
        direction: "INBOUND",
        sentAt: { gt: first.sentAt },
        OR: [{ fromAddress: first.toAddress }, ...(domain ? [{ fromAddress: { endsWith: `@${domain}` } }] : [])],
      },
      orderBy: { sentAt: "asc" },
      select: { id: true, bodyText: true, snippet: true },
    });
    if (!inbound) continue;
    await stopSequence(db, c.id, "replied");
    await transition(db, workspaceId, c, "REPLIED", { detail: inbound.id, at: now });
    if (c.leadId) {
      const lead = await db.lead.findUnique({ where: { id: c.leadId }, select: { stage: true } });
      if (lead && (lead.stage === "CONTACTED" || lead.stage === "RESEARCHED" || lead.stage === "ACCEPTED")) {
        await db.lead.update({ where: { id: c.leadId }, data: { stage: "REPLIED", stageEnteredAt: now, lastActivityAt: now } });
        await onLeadStageChanged(workspaceId, c.leadId);
      }
    }
    if (asksToStop(`${inbound.snippet ?? ""}\n${inbound.bodyText ?? ""}`)) {
      await suppressCompany(db, workspaceId, { address: first.toAddress, taxNumber: c.taxNumber, website: c.website, reason: "reply asked to stop" });
    }
    replied++;
  }
  return replied;
}

/** Draft the follow-ups that fall due within a day, so they can be reviewed in time. */
export async function scheduleFollowups(workspaceId: string, deps: SendDeps, limit = 5): Promise<number> {
  const db = getWorkspaceClient(workspaceId);
  const now = deps.now();
  const { cfg } = await loadWorkspace(workspaceId);
  const offsets = cfg.followups.offsetsDays;
  if (offsets.length === 0) return 0;
  const sent = await db.prospectCandidate.findMany({ where: { state: "SENT" }, take: 500 });
  let drafted = 0;
  for (const c of sent) {
    if (drafted >= limit) break;
    const drafts = await db.outreachDraft.findMany({ where: { candidateId: c.id }, orderBy: { step: "asc" } });
    const sentDrafts = drafts.filter((d) => d.status === "SENT");
    const nextStep = sentDrafts.length;
    if (nextStep === 0 || nextStep > offsets.length) continue;
    if (drafts.some((d) => d.step === nextStep)) continue;
    // A bounced or cancelled sequence gets no follow-up.
    if (sentDrafts.some((d) => d.bouncedAt)) continue;
    const lastSent = sentDrafts[sentDrafts.length - 1]!;
    const dueAt = new Date(lastSent.sentAt!.getTime() + offsets[nextStep - 1]! * 86_400_000);
    if (dueAt.getTime() - now.getTime() > 86_400_000) continue;
    const r = await draftFollowup(workspaceId, c.id, nextStep as 1 | 2, dueAt, deps.draft);
    if (r === "drafted") drafted++;
    if (r === "budget") break;
  }
  return drafted;
}

// ---- unsubscribe ----------------------------------------------------------------------

async function suppressCompany(
  db: WorkspaceClient,
  workspaceId: string,
  x: { address: string; taxNumber: string | null; website: string | null; reason: string },
): Promise<void> {
  const own = x.address.split("@")[1]?.toLowerCase() ?? null;
  // Never suppress all of gmail.com because one person there unsubscribed.
  const domain = own && !isFreemail(own) ? own : null;
  const entries = [
    x.address.toLowerCase(),
    ...(domain ? [domainSuppressionEntry(domain)] : []),
    ...(x.website && domainOf(x.website) && domainOf(x.website) !== domain ? [domainSuppressionEntry(domainOf(x.website)!)] : []),
    ...(x.taxNumber ? [taxSuppressionEntry(x.taxNumber)] : []),
  ];
  for (const address of entries) {
    await db.suppression.upsert({
      where: { workspaceId_address: { workspaceId, address } },
      create: { workspaceId, address, reason: x.reason },
      update: {},
    });
  }
  // Every channel, every contact at the company: outbound drafts waiting to
  // go, and Mailgun campaign recipients alike.
  const affected = await db.prospectCandidate.findMany({
    where: {
      OR: [...(x.taxNumber ? [{ taxNumber: x.taxNumber }] : []), ...(domain ? [{ website: { contains: domain } }] : [])],
    },
    select: { id: true },
  });
  const ids = new Set(affected.map((a) => a.id));
  const byAddress = domain ? await db.outreachDraft.findMany({ where: { toAddress: { endsWith: `@${domain}` } }, select: { candidateId: true } }) : [];
  for (const b of byAddress) ids.add(b.candidateId);
  for (const id of ids) await stopSequence(db, id, "unsubscribed");
  if (domain) {
    await db.campaignRecipient.updateMany({ where: { email: { endsWith: `@${domain}` } }, data: { suppressed: true } });
  }
}

/**
 * The public unsubscribe (RFC 8058 one-click and the link in the footer).
 * The token is the capability; an unknown one changes nothing and is told
 * nothing. Suppresses the address, the company's domain and its tax number,
 * across every campaign and every contact there.
 */
export async function unsubscribeByToken(token: string): Promise<{ ok: boolean; brand: unknown }> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { ok: false, brand: null };
  const d = await prismaUnsafe.outreachDraft.findUnique({ where: { unsubscribeToken: token } });
  if (!d) return { ok: false, brand: null };
  const db = getWorkspaceClient(d.workspaceId);
  const c = await db.prospectCandidate.findUnique({ where: { id: d.candidateId } });
  await suppressCompany(db, d.workspaceId, {
    address: d.toAddress,
    taxNumber: c?.taxNumber ?? null,
    website: c?.website ?? null,
    reason: "unsubscribe",
  });
  if (c?.leadId) {
    await db.activity.create({ data: { workspaceId: d.workspaceId, leadId: c.leadId, type: "outbound_unsubscribed", payload: { draftId: d.id } } });
  }
  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: d.workspaceId }, select: { brand: true } });
  return { ok: true, brand: ws?.brand ?? null };
}

export { localClock };
