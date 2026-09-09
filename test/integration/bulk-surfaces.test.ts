import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { bulkSetContentStatus } from "../../src/modules/content/bulk";
import {
  bulkArchiveThreads,
  bulkLinkThreadsToLead,
  bulkMarkThreadsRead,
} from "../../src/modules/inbox/bulk";
import { bulkRemoveRecipients } from "../../src/modules/campaigns/bulk";

/**
 * The other four bulk surfaces (playbook-v5 P17/1).
 *
 * Same requirement as the task board: the per-row rule holds per row, and the
 * refusals come back named. These are the rules that would be quietly lost if
 * a bulk path were written as "update where id in (…)".
 */
const WS = "Bulk Surfaces WS";
let workspaceId = "";
let accountId = "";
let leadId = "";
let otherLeadId = "";
let campaignId = "";

beforeAll(async () => {
  const ws =
    (await prismaUnsafe.workspace.findFirst({ where: { name: WS } })) ??
    (await prismaUnsafe.workspace.create({ data: { name: WS } }));
  workspaceId = ws.id;

  await prismaUnsafe.emailThread.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.mailAccount.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.contentVariant.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.contentPost.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.campaignRecipient.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.campaign.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId } });

  leadId = (
    await prismaUnsafe.lead.create({ data: { workspaceId, contactName: "Bulk target" } })
  ).id;
  otherLeadId = (
    await prismaUnsafe.lead.create({ data: { workspaceId, contactName: "Other target" } })
  ).id;
  accountId = (
    await prismaUnsafe.mailAccount.create({
      data: { workspaceId, provider: "gmail", accountEmail: "bulk@ventureco.test", userId: "x" },
    })
  ).id;
  campaignId = (
    await prismaUnsafe.campaign.create({
      data: { workspaceId, name: "Bulk campaign" },
    })
  ).id;
});

afterAll(async () => {
  await prismaUnsafe.emailThread.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.mailAccount.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.contentVariant.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.contentPost.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.campaignRecipient.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.campaign.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.undoEntry.deleteMany({ where: { workspaceId } });
});

let n = 0;
async function thread(over: Record<string, unknown> = {}) {
  n += 1;
  return prismaUnsafe.emailThread.create({
    data: {
      workspaceId,
      accountId,
      providerThreadId: `t-${Date.now()}-${n}`,
      subject: `Thread ${n}`,
      lastMessageAt: new Date(),
      ...over,
    },
  });
}

async function post(status: "DRAFT" | "IN_REVIEW" | "APPROVED" | "PUBLISHED") {
  return prismaUnsafe.contentPost.create({
    data: { workspaceId, title: `Post ${status} ${Date.now()}${Math.random()}`, status },
  });
}

describe("content: a bulk phase change", () => {
  /**
   * A post moves through its phases in order. An illegal jump is refused for
   * one card and must be refused for forty — with the skip naming where the
   * post actually is.
   */
  it("refuses an illegal jump and names the phase it is in", async () => {
    const draft = await post("DRAFT");
    const review = await post("IN_REVIEW");
    const res = await bulkSetContentStatus(
      workspaceId,
      "actor",
      [draft.id, review.id],
      "APPROVED",
      true,
    );
    expect(res.applied).toBe(1);
    expect(res.skipped.some((s) => /cannot go straight from/i.test(s.reason))).toBe(true);
  });

  it("skips a post already in the target phase", async () => {
    const already = await post("IN_REVIEW");
    const res = await bulkSetContentStatus(workspaceId, "actor", [already.id], "IN_REVIEW", true);
    expect(res.applied).toBe(0);
    expect(res.skipped[0]!.reason).toMatch(/already in/i);
  });

  /** Approval is a capability, and it is checked for the actor once. */
  it("refuses approval for somebody who may not approve", async () => {
    const review = await post("IN_REVIEW");
    const res = await bulkSetContentStatus(workspaceId, "actor", [review.id], "APPROVED", false);
    expect(res.applied).toBe(0);
    expect(res.skipped[0]!.reason).toMatch(/approve/i);
  });

  it("records an undo that puts the phases back", async () => {
    const a = await post("DRAFT");
    const b = await post("DRAFT");
    const res = await bulkSetContentStatus(workspaceId, "actor", [a.id, b.id], "IN_REVIEW", true);
    expect(res.applied).toBe(2);
    const { undo } = await import("../../src/modules/undo/store");
    expect((await undo(workspaceId, "actor", res.undoId!)).ok).toBe(true);
    expect((await prismaUnsafe.contentPost.findUnique({ where: { id: a.id } }))!.status).toBe(
      "DRAFT",
    );
  });
});

describe("inbox: bulk actions on threads", () => {
  it("marks the unread ones read and skips the rest", async () => {
    const unread = await thread({ unread: true });
    const read = await thread({ unread: false });
    const res = await bulkMarkThreadsRead(workspaceId, [unread.id, read.id], false);
    expect(res.applied).toBe(1);
    expect(res.skipped[0]!.reason).toMatch(/already read/i);
  });

  it("archives, and says so when one already is", async () => {
    const open = await thread();
    const gone = await thread({ archivedAt: new Date() });
    const res = await bulkArchiveThreads(workspaceId, [open.id, gone.id], true);
    expect(res.applied).toBe(1);
    expect(res.skipped[0]!.reason).toMatch(/already archived/i);
  });

  it("links unlinked threads to a lead", async () => {
    const a = await thread();
    const b = await thread();
    const res = await bulkLinkThreadsToLead(workspaceId, [a.id, b.id], leadId);
    expect(res.applied).toBe(2);
    expect((await prismaUnsafe.emailThread.findUnique({ where: { id: a.id } }))!.leadId).toBe(
      leadId,
    );
  });

  /**
   * The rule worth having: a thread already pointing at a DIFFERENT lead is
   * skipped, not relinked. Reassigning correspondence to another company is a
   * decision, and a bulk action must not make it quietly.
   */
  it("refuses to relink a thread that already belongs to another lead", async () => {
    const taken = await thread({ leadId: otherLeadId });
    const res = await bulkLinkThreadsToLead(workspaceId, [taken.id], leadId);
    expect(res.applied).toBe(0);
    expect(res.skipped[0]!.reason).toMatch(/different lead/i);
    expect((await prismaUnsafe.emailThread.findUnique({ where: { id: taken.id } }))!.leadId).toBe(
      otherLeadId,
    );
  });

  it("refuses a lead that does not exist", async () => {
    const t = await thread();
    const res = await bulkLinkThreadsToLead(workspaceId, [t.id], "no-such-lead");
    expect(res.applied).toBe(0);
  });
});

describe("campaigns: removing recipients", () => {
  async function recipient(over: Record<string, unknown> = {}) {
    return prismaUnsafe.campaignRecipient.create({
      data: { workspaceId, campaignId, email: `r${Math.random()}@example.com`, ...over },
    });
  }

  it("deletes the ones that have not been sent to", async () => {
    const fresh = await recipient();
    const res = await bulkRemoveRecipients(workspaceId, [fresh.id]);
    expect(res.applied).toBe(1);
    expect(await prismaUnsafe.campaignRecipient.count({ where: { id: fresh.id } })).toBe(0);
  });

  /**
   * THE RULE THAT MATTERS: a recipient who has already been sent to is
   * SUPPRESSED, not deleted. The row is the record that mail went to that
   * address — suppression, bounce handling and the complaint circuit breaker
   * all read it, and deleting it would leave a cold-email programme unable to
   * prove what it had sent. The report says which of the two happened.
   */
  it("suppresses rather than deletes a recipient already sent to, and says so", async () => {
    const sent = await recipient({ sentAt: new Date(), stepSent: 1 });
    const res = await bulkRemoveRecipients(workspaceId, [sent.id]);
    expect(res.applied).toBe(1);
    expect(res.skipped[0]!.reason).toMatch(/suppressed instead of removed/i);

    const after = await prismaUnsafe.campaignRecipient.findUnique({ where: { id: sent.id } });
    expect(after).not.toBeNull();
    expect(after!.suppressed).toBe(true);
  });

  it("does nothing to one that is already sent and already suppressed", async () => {
    const done = await recipient({ sentAt: new Date(), stepSent: 1, suppressed: true });
    const res = await bulkRemoveRecipients(workspaceId, [done.id]);
    expect(res.applied).toBe(0);
    expect(res.skipped[0]!.reason).toMatch(/already suppressed/i);
  });
});
