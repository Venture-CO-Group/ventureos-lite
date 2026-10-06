import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { sendTick, processReplies, scheduleFollowups, unsubscribeByToken, type GmailLike } from "../../src/modules/outbound/sender";
import { COLD_OUTBOUND_ADDRESS } from "../../src/modules/outbound/config";
import type { CallClaudeParams, CallClaudeResult } from "../../src/lib/ai/call-claude";
import type { OutboundDraftOutput } from "../../src/lib/ai/prompts/outbound-draft";

/**
 * Sending from the cold mailbox (playbook-v6 F5 VERIFICATION). Gmail is a
 * stub that keeps the raw MIME of everything it was asked to send, so the
 * assertions are on what would actually have left.
 */
const NAMES = ["Outbound Sending A"];
let ws = "";
let senderId = "";
let productId = "";
let runId = "";
// Thursday 22 Oct 2026, 12:00 in Budapest — inside the send window.
const NOW = new Date("2026-10-22T10:00:00Z");

const SIGNOFF = { coldEmail: { signoff: { approvedBy: "Dr. Counsel", date: "2026-09-30", scopeNote: "B2B outbound, legitimate interest" }, coldDomain: "cold.ventureco.agency" } };

function gmailStub() {
  const sent: Array<{ mime: string; threadId?: string | null }> = [];
  const g: GmailLike = {
    async sendRaw(_c, input) {
      sent.push(input);
      return { providerMessageId: `m${sent.length}`, providerThreadId: input.threadId ?? `t${sent.length}` };
    },
    async getSendAsSignature() {
      return { signatureHtml: "<div>Virágh Fanni<br>Venture CO<br>+36 30 000 0000</div>" };
    },
    async getMessageIdHeader(_c, id) {
      return { messageIdHeader: `<${id}@mail.gmail.com>` };
    },
    async listMessageIds() {
      return { ids: [], nextPageToken: null };
    },
    async getMessage() {
      throw new Error("not used");
    },
  };
  return { g, sent };
}

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({ where: { name: { in: NAMES } }, select: { id: true } });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    for (const t of [
      "emailMessage",
      "emailThread",
      "mailAccount",
      "activity",
      "outreachDraft",
      "candidateEvent",
      "prospectCandidate",
      "sourcingRun",
      "candidatePool",
      "campaignRecipient",
      "campaign",
      "lead",
      "company",
      "suppression",
      "icpProfile",
      "product",
    ] as const) {
      // @ts-expect-error dynamic model access
      await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
    }
    await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
  }
  await prismaUnsafe.user.deleteMany({ where: { email: { in: ["outbound-sender@test.local"] } } });
}

beforeAll(async () => {
  await clean();
  ws = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0], featureFlags: SIGNOFF } })).id;
  senderId = (await prismaUnsafe.user.create({ data: { email: "outbound-sender@test.local", name: "Virágh Fanni", passwordHash: "x" } })).id;
});
afterAll(clean);

beforeEach(async () => {
  for (const t of ["emailMessage", "emailThread", "mailAccount", "activity", "outreachDraft", "candidateEvent", "prospectCandidate", "sourcingRun", "candidatePool", "campaignRecipient", "campaign", "lead", "company", "suppression", "icpProfile", "product"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: ws } });
  }
  await prismaUnsafe.googleCredential.deleteMany({ where: { userId: senderId } });
  await prismaUnsafe.workspace.update({ where: { id: ws }, data: { featureFlags: SIGNOFF, outboundConfig: {} } });
  const cred = await prismaUnsafe.googleCredential.create({
    data: { userId: senderId, accountEmail: COLD_OUTBOUND_ADDRESS, accessToken: "a", refreshToken: "r", expiryDate: new Date(NOW.getTime() + 3600_000) },
  });
  await prismaUnsafe.mailAccount.create({ data: { workspaceId: ws, userId: senderId, accountEmail: COLD_OUTBOUND_ADDRESS, credentialId: cred.id } });
  const db = getWorkspaceClient(ws);
  productId = (await db.product.create({ data: { workspaceId: ws, name: "Web", slug: "web", problemSolved: "Slow sites." } })).id;
  const profileId = (await db.icpProfile.create({ data: { workspaceId: ws, productId, name: "Dentists" } })).id;
  runId = (await db.sourcingRun.create({ data: { workspaceId: ws, productId, profileId, requested: 5 } })).id;
});

let seq = 0;
async function approvedDraft(opts: { domain?: string; tax?: string; approvedAt?: Date } = {}) {
  const db = getWorkspaceClient(ws);
  seq++;
  const domain = opts.domain ?? `ceg${seq}.example`;
  const company = await db.company.create({ data: { workspaceId: ws, name: `Cég ${seq}`, domain } });
  const lead = await db.lead.create({
    data: { workspaceId: ws, companyId: company.id, email: `anna@${domain}`, contactName: "Kovács Anna", source: "OUTBOUND_ENGINE", stage: "RESEARCHED", icpScore: 5 },
  });
  const pool = await db.candidatePool.create({ data: { workspaceId: ws, dedupeKey: `k${seq}`, name: `Cég ${seq}`, source: "NAME_HARVEST" } });
  const cand = await db.prospectCandidate.create({
    data: {
      workspaceId: ws,
      runId,
      poolId: pool.id,
      productId,
      name: `Cég ${seq}`,
      state: "APPROVED",
      leadId: lead.id,
      taxNumber: opts.tax ?? null,
      website: `https://${domain}`,
      facts: [
        { id: "audit:viewport", kind: "audit", label: "Mobile layout", value: "no viewport tag" },
        { id: "registry:founded", kind: "registry", label: "Founded", value: "2011 (15 years)" },
      ],
    },
  });
  const draft = await db.outreachDraft.create({
    data: {
      workspaceId: ws,
      candidateId: cand.id,
      productId,
      step: 0,
      variant: "named",
      templateVersion: "outbound-draft@1",
      toAddress: `anna@${domain}`,
      toName: "Kovács Anna",
      subject: "Mobilon szétesik az oldaluk",
      body: "Tisztelt Kovács Anna! Az oldaluk mobilon szétesik: no viewport tag. 15 perc?",
      originalSubject: "Mobilon szétesik az oldaluk",
      originalBody: "x",
      personalisationPoints: [{ factId: "audit:viewport", quote: "no viewport tag" }],
      status: "APPROVED",
      decidedById: senderId,
      decidedAt: opts.approvedAt ?? new Date(NOW.getTime() - 3600_000),
      scheduledFor: new Date(NOW.getTime() - 3600_000),
    },
  });
  return { cand, draft, lead, domain };
}

describe("sending (spec §4.43.9)", () => {
  it("sends an approved draft from the cold address with the account signature and an unsubscribe", async () => {
    const { draft, cand, lead } = await approvedDraft();
    const { g, sent } = gmailStub();
    expect(await sendTick(ws, { now: () => NOW, gmail: g })).toBe("sent");
    expect(sent).toHaveLength(1);
    const mime = sent[0]!.mime;
    expect(mime).toContain(`<${COLD_OUTBOUND_ADDRESS}>`);
    expect(mime).toContain("List-Unsubscribe: <");
    expect(mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(mime).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(mime).toContain("Virágh Fanni\nVenture CO\n+36 30 000 0000");
    expect(mime).toContain("itt leiratkozhat: ");
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?/);

    const db = getWorkspaceClient(ws);
    expect(await db.outreachDraft.findUnique({ where: { id: draft.id } })).toMatchObject({ status: "SENT", sentFrom: COLD_OUTBOUND_ADDRESS, gmailMessageId: "m1" });
    expect((await db.prospectCandidate.findUnique({ where: { id: cand.id } }))!.state).toBe("SENT");
    expect((await db.lead.findUnique({ where: { id: lead.id } }))!.stage).toBe("CONTACTED");
  });

  it("never sends from a .group mailbox — with only that one connected there is nothing to send from", async () => {
    await prismaUnsafe.mailAccount.deleteMany({ where: { workspaceId: ws } });
    const cred = await prismaUnsafe.googleCredential.create({ data: { userId: senderId, accountEmail: "fanni@ventureco.group", accessToken: "a" } });
    await prismaUnsafe.mailAccount.create({ data: { workspaceId: ws, userId: senderId, accountEmail: "fanni@ventureco.group", credentialId: cred.id } });
    await approvedDraft();
    const { g, sent } = gmailStub();
    expect(await sendTick(ws, { now: () => NOW, gmail: g })).toBe("no_mailbox");
    expect(sent).toHaveLength(0);
  });

  it("refuses without the counsel sign-off", async () => {
    await prismaUnsafe.workspace.update({ where: { id: ws }, data: { featureFlags: {} } });
    await approvedDraft();
    const { g, sent } = gmailStub();
    expect(await sendTick(ws, { now: () => NOW, gmail: g })).toBe("gate_closed");
    expect(sent).toHaveLength(0);
  });

  it("stays quiet outside business hours", async () => {
    await approvedDraft();
    const { g } = gmailStub();
    expect(await sendTick(ws, { now: () => new Date("2026-10-22T20:00:00Z"), gmail: g })).toBe("outside_window");
    expect(await sendTick(ws, { now: () => new Date("2026-10-24T10:00:00Z"), gmail: g })).toBe("outside_window"); // Saturday
  });

  it("blocks the 11th send on the mailbox's first day", async () => {
    const db = getWorkspaceClient(ws);
    for (let i = 0; i < 10; i++) {
      const { draft } = await approvedDraft();
      await db.outreachDraft.update({ where: { id: draft.id }, data: { status: "SENT", sentAt: new Date(NOW.getTime() - (i + 1) * 600_000) } });
    }
    await approvedDraft();
    const { g, sent } = gmailStub();
    expect(await sendTick(ws, { now: () => NOW, gmail: g })).toBe("cap_reached");
    expect(sent).toHaveLength(0);
  });

  it("spaces sends instead of bursting", async () => {
    await approvedDraft();
    await approvedDraft();
    const { g, sent } = gmailStub();
    expect(await sendTick(ws, { now: () => NOW, gmail: g })).toBe("sent");
    expect(await sendTick(ws, { now: () => new Date(NOW.getTime() + 30_000), gmail: g })).toBe("spacing");
    expect(await sendTick(ws, { now: () => new Date(NOW.getTime() + 8 * 60_000), gmail: g })).toBe("sent");
    expect(sent).toHaveLength(2);
  });
});

describe("the hook gate at send time (rule 10, generation-time only)", () => {
  it("sends a human-edited draft with zero personalisation points", async () => {
    const { draft } = await approvedDraft();
    const db = getWorkspaceClient(ws);
    await db.outreachDraft.update({
      where: { id: draft.id },
      data: { body: "Tisztelt Kovács Anna! Saját szavaimmal írok: beszélhetnénk 15 percet?", personalisationPoints: [], edited: true },
    });
    const { g, sent } = gmailStub();
    expect(await sendTick(ws, { now: () => NOW, gmail: g })).toBe("sent");
    expect(sent).toHaveLength(1);
    expect((await db.outreachDraft.findUnique({ where: { id: draft.id } }))!.status).toBe("SENT");
  });

  it("does not send an unedited machine draft without a hook", async () => {
    const { draft } = await approvedDraft();
    const db = getWorkspaceClient(ws);
    const generic = "Tisztelt Kovács Anna! Weboldalakat készítünk. 15 perc?";
    await db.outreachDraft.update({ where: { id: draft.id }, data: { body: generic, originalBody: generic, originalSubject: draft.subject } });
    const { g, sent } = gmailStub();
    expect(await sendTick(ws, { now: () => NOW, gmail: g })).toBe("nothing_due");
    expect(sent).toHaveLength(0);
    expect(await db.outreachDraft.findUnique({ where: { id: draft.id } })).toMatchObject({ status: "FAILED" });
  });
});

describe("unsubscribe, replies and follow-ups", () => {
  it("unsubscribes the whole company across every campaign", async () => {
    const a = await approvedDraft({ domain: "kozos.example", tax: "12345678242" });
    const { g } = gmailStub();
    await sendTick(ws, { now: () => NOW, gmail: g });
    // A second contact at the same company is approved and waiting, and the
    // same domain sits in a Mailgun campaign audience.
    const b = await approvedDraft({ domain: "kozos.example" });
    const db = getWorkspaceClient(ws);
    const campaign = await db.campaign.create({ data: { workspaceId: ws, name: "C", segmentQuery: {} } as never });
    await db.campaignRecipient.create({ data: { workspaceId: ws, campaignId: campaign.id, email: "bela@kozos.example" } });

    const token = (await db.outreachDraft.findUnique({ where: { id: a.draft.id } }))!.unsubscribeToken!;
    expect((await unsubscribeByToken(token)).ok).toBe(true);
    const entries = (await db.suppression.findMany()).map((s) => s.address).sort();
    expect(entries).toEqual(["@kozos.example", "anna@kozos.example", "tax:12345678242"]);
    expect((await db.outreachDraft.findUnique({ where: { id: b.draft.id } }))!.status).toBe("CANCELLED");
    expect((await db.campaignRecipient.findFirst({ where: { email: "bela@kozos.example" } }))!.suppressed).toBe(true);
    expect((await unsubscribeByToken("nonsense-token-that-does-not-exist")).ok).toBe(false);
  });

  it("drafts a follow-up into the approval queue — it does not send itself", async () => {
    const { cand } = await approvedDraft();
    const { g, sent } = gmailStub();
    await sendTick(ws, { now: () => NOW, gmail: g });
    const claude = async (): Promise<CallClaudeResult<OutboundDraftOutput>> => ({
      data: {
        subject: "Re: Mobilon szétesik az oldaluk",
        body: "Tisztelt Kovács Anna! Az előző levelemhez: a 2011 (15 years) óta működő rendelőnek ma a mobil a fő csatorna. Rövid hívás?",
        personalisationPoints: [{ factId: "registry:founded", quote: "2011 (15 years)" }],
      },
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1, output_tokens: 1 },
      costUsd: 0.01,
    });
    // Four days later, the first follow-up falls due.
    const later = new Date(NOW.getTime() + 4 * 86_400_000);
    expect(await scheduleFollowups(ws, { now: () => later, draft: { claude: claude as (p: CallClaudeParams<OutboundDraftOutput>) => Promise<CallClaudeResult<OutboundDraftOutput>> } })).toBe(1);
    const fu = await getWorkspaceClient(ws).outreachDraft.findFirst({ where: { candidateId: cand.id, step: 1 } });
    expect(fu!.status).toBe("PENDING");
    expect(await sendTick(ws, { now: () => later, gmail: g })).toBe("nothing_due");
    expect(sent).toHaveLength(1);
  });

  it("a reply stops the sequence and moves the lead to Replied", async () => {
    const { cand, lead, domain } = await approvedDraft();
    const { g } = gmailStub();
    await sendTick(ws, { now: () => NOW, gmail: g });
    const db = getWorkspaceClient(ws);
    // A follow-up is already approved and waiting when the reply arrives.
    await db.outreachDraft.create({
      data: {
        workspaceId: ws, candidateId: cand.id, productId, step: 1, variant: "named", templateVersion: "x", toAddress: `anna@${domain}`,
        subject: "Re", body: "b", originalSubject: "Re", originalBody: "b", status: "APPROVED", scheduledFor: new Date(NOW.getTime() + 86_400_000),
      },
    });
    const account = await prismaUnsafe.mailAccount.findFirstOrThrow({ where: { workspaceId: ws } });
    const thread = await db.emailThread.create({ data: { workspaceId: ws, accountId: account.id, providerThreadId: "t1", lastMessageAt: NOW } });
    await db.emailMessage.create({
      data: { workspaceId: ws, threadId: thread.id, providerMessageId: "r1", direction: "INBOUND", fromAddress: `anna@${domain}`, toAddresses: [COLD_OUTBOUND_ADDRESS], sentAt: new Date(NOW.getTime() + 3600_000), bodyText: "Köszönöm, beszéljünk." },
    });
    expect(await processReplies(ws, { now: () => new Date(NOW.getTime() + 2 * 3600_000) })).toBe(1);
    expect((await db.prospectCandidate.findUnique({ where: { id: cand.id } }))!.state).toBe("REPLIED");
    expect((await db.lead.findUnique({ where: { id: lead.id } }))!.stage).toBe("REPLIED");
    expect((await db.outreachDraft.findFirst({ where: { candidateId: cand.id, step: 1 } }))!.status).toBe("CANCELLED");
  });
});
