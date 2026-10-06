import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { draftCandidate } from "../../src/modules/outbound/draft-engine";
import { rejectDraft } from "../../src/modules/outbound/approval";
import { recordUndo, undo } from "../../src/modules/undo/store";
import { previewRestore, restoreCandidate, cancelFollowups, type RestoreDeps } from "../../src/modules/outbound/restore";
import { listHistory, loadCandidateDetail } from "../../src/modules/outbound/history";
import { scheduleFollowups } from "../../src/modules/outbound/sender";
import { outboundFunnel } from "../../src/modules/outbound/metrics";
import type { CallClaudeParams, CallClaudeResult } from "../../src/lib/ai/call-claude";
import type { OutboundDraftOutput } from "../../src/lib/ai/prompts/outbound-draft";
import type { VerifyResult } from "../../src/modules/verification/types";

/**
 * History, undo and restore against the real database (tracking & recovery
 * VERIFICATION).
 */
const NAMES = ["Outbound History A"];
let ws = "";
let userId = "";
let productId = "";
let profileId = "";
let runId = "";
const NOW = new Date("2026-10-22T10:00:00Z");

const FACTS = [
  { id: "audit:viewport", kind: "audit", label: "Mobile layout", value: "no viewport tag" },
  { id: "registry:founded", kind: "registry", label: "Founded", value: "2011 (15 years)" },
];
const DRAFT: OutboundDraftOutput = {
  subject: "Mobilon szétesik az oldaluk",
  body: "Tisztelt Kovács Anna! Az oldaluk mobilon szétesik: no viewport tag. Nyitott lenne egy 15 perces hívásra?",
  personalisationPoints: [{ factId: "audit:viewport", quote: "no viewport tag" }],
};
const claude = async (_p: CallClaudeParams<OutboundDraftOutput>): Promise<CallClaudeResult<OutboundDraftOutput>> => ({
  data: DRAFT,
  model: "claude-sonnet-4-6",
  usage: { input_tokens: 1, output_tokens: 1 },
  costUsd: 0.01,
});
const TABLES = ["registrySheet", "auditLog", "undoEntry", "activity", "outreachDraft", "candidateEvent", "prospectCandidate", "sourcingRun", "candidatePool", "suppression", "lead", "company", "icpProfile", "product"] as const;

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({ where: { name: { in: NAMES } }, select: { id: true } });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    for (const t of TABLES) {
      // @ts-expect-error dynamic model access
      await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
    }
    await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
  }
  await prismaUnsafe.user.deleteMany({ where: { email: "outbound-history@test.local" } });
}

beforeAll(async () => {
  await clean();
  ws = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  userId = (await prismaUnsafe.user.create({ data: { email: "outbound-history@test.local", name: "Reviewer", passwordHash: "x" } })).id;
});
afterAll(clean);

beforeEach(async () => {
  for (const t of TABLES) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: ws } });
  }
  const db = getWorkspaceClient(ws);
  productId = (await db.product.create({ data: { workspaceId: ws, name: "Web", slug: "web", problemSolved: "Slow sites." } })).id;
  profileId = (await db.icpProfile.create({ data: { workspaceId: ws, productId, name: "Dentists" } })).id;
  runId = (await db.sourcingRun.create({ data: { workspaceId: ws, productId, profileId, requested: 5 } })).id;
});

let seq = 0;
async function queued() {
  const db = getWorkspaceClient(ws);
  seq++;
  const pool = await db.candidatePool.create({ data: { workspaceId: ws, dedupeKey: `k${seq}`, name: `Mosoly ${seq} Kft.`, source: "NAME_HARVEST", domain: `mosoly${seq}.example` } });
  const c = await db.prospectCandidate.create({
    data: {
      workspaceId: ws,
      runId,
      poolId: pool.id,
      productId,
      profileId,
      name: `Mosoly ${seq} Kft.`,
      taxNumber: `1234567${String(seq).padStart(4, "0")}`,
      state: "CONTACT_RESOLVED",
      website: `https://mosoly${seq}.example`,
      matchedSegment: "private_clinics",
      facts: FACTS,
      contact: { kind: "named", name: "Kovács Anna", email: `anna@mosoly${seq}.example`, source: "impresszum", verify: { status: "valid", reason: "ok" }, trail: [] },
      contactName: "Kovács Anna",
      contactEmail: `anna@mosoly${seq}.example`,
    },
  });
  // A fresh datasheet, so the restore's freshness check has nothing to refresh.
  await db.registrySheet.create({
    data: {
      workspaceId: ws,
      taxNumber: c.taxNumber!,
      provider: "mock",
      sheet: { taxNumber: c.taxNumber, legalName: c.name, status: "Aktív", seat: { county: null, city: "Budapest", zip: null, oneLine: null }, managers: [], activities: [], owners: [] },
      fetchedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 90 * 86_400_000),
    },
  });
  await draftCandidate(ws, c.id, { claude });
  const d = await db.outreachDraft.findFirstOrThrow({ where: { candidateId: c.id } });
  return { c, d };
}

async function rejectWithUndo(d: { id: string; candidateId: string }) {
  const db = getWorkspaceClient(ws);
  await rejectDraft(db, ws, { draftId: d.id, userId, reason: "WEAK_COPY", now: NOW });
  return recordUndo(ws, userId, {
    kind: "outbound_reject",
    label: "Rejected",
    inverse: { entity: "prospectCandidate", targets: [{ id: d.candidateId, set: { state: "PENDING_APPROVAL" } }] },
    expected: { [d.candidateId]: { state: "REJECTED" } },
    nowMs: NOW.getTime(),
  });
}

const deps = (drafted: string[] = []): RestoreDeps => ({
  now: () => NOW,
  draft: async (w, id) => {
    drafted.push(id);
    return draftCandidate(w, id, { claude });
  },
  readSite: async () => null,
  verify: async (e) => ({ status: "valid", reason: "ok", address: e, checkedAt: NOW }) as VerifyResult,
});

describe("undo after a reject", () => {
  it("puts the card back and records no rejection reason", async () => {
    const { c, d } = await queued();
    const token = await rejectWithUndo(d);
    expect(token).not.toBeNull();
    expect(await undo(ws, userId, token!.id, NOW.getTime() + 3000)).toMatchObject({ ok: true, restored: 1 });

    const db = getWorkspaceClient(ws);
    expect(await db.prospectCandidate.findUnique({ where: { id: c.id } })).toMatchObject({ state: "PENDING_APPROVAL", reason: null });
    expect(await db.outreachDraft.findUnique({ where: { id: d.id } })).toMatchObject({ status: "PENDING", rejectReason: null, decidedById: null });
    const rejection = await db.candidateEvent.findFirst({ where: { candidateId: c.id, toState: "REJECTED" } });
    expect(rejection!.retractedAt).not.toBeNull();
    // Out of the learning data: no rejection, no reason in the statistics.
    const funnel = await outboundFunnel(db);
    expect(funnel.total.rejected).toBe(0);
    expect(funnel.total.rejectionReasons).toEqual({});
  });

  it("declines to undo when the candidate has moved on since", async () => {
    const { c, d } = await queued();
    const token = await rejectWithUndo(d);
    await getWorkspaceClient(ws).prospectCandidate.update({ where: { id: c.id }, data: { state: "FILTERED_OUT" } });
    expect((await undo(ws, userId, token!.id, NOW.getTime() + 3000)).ok).toBe(false);
  });
});

describe("restore", () => {
  it("requeues a recently rejected candidate, flagged and audit-logged", async () => {
    const { c, d } = await queued();
    await rejectDraft(getWorkspaceClient(ws), ws, { draftId: d.id, userId, reason: "BAD_TIMING", now: NOW });
    const r = await restoreCandidate(getWorkspaceClient(ws), ws, { candidateId: c.id, userId, note: "timing is fine now" }, deps());
    expect(r).toEqual({ ok: true, mode: "requeue", state: "PENDING_APPROVAL" });
    const db = getWorkspaceClient(ws);
    expect(await db.prospectCandidate.findUnique({ where: { id: c.id } })).toMatchObject({ restoredById: userId, restoreNote: "timing is fine now", restoreCount: 1, reason: null });
    expect((await db.outreachDraft.findUnique({ where: { id: d.id } }))!.status).toBe("PENDING");
    const log = await db.auditLog.findFirst({ where: { action: "outbound.candidate.restored", entityId: c.id } });
    expect(log).toMatchObject({ actorUserId: userId });
    expect(log!.meta).toMatchObject({ from: "REJECTED", fromReason: "BAD_TIMING", mode: "requeue", note: "timing is fine now" });
  });

  it("re-runs suppression and CRM checks and reports what blocks it", async () => {
    const db = getWorkspaceClient(ws);
    const a = await queued();
    await rejectDraft(db, ws, { draftId: a.d.id, userId, reason: "WEAK_COPY", now: NOW });
    await db.suppression.create({ data: { workspaceId: ws, address: `@mosoly${seq}.example` } });
    const p1 = await previewRestore(db, ws, a.c.id, NOW);
    expect(p1.restorable).toBe(false);
    expect(p1.blockers.join(" ")).toContain("suppression");

    const b = await queued();
    await rejectDraft(db, ws, { draftId: b.d.id, userId, reason: "WEAK_COPY", now: NOW });
    await db.company.create({ data: { workspaceId: ws, name: "Mosoly Client Kft.", taxId: b.c.taxNumber, clientStatus: "CLIENT" } });
    const r = await restoreCandidate(db, ws, { candidateId: b.c.id, userId }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blockers.join(" ")).toContain("already a client");
    expect((await db.prospectCandidate.findUnique({ where: { id: b.c.id } }))!.state).toBe("REJECTED");
  });

  it("offers regeneration for a draft rejected 40 days ago, never the stale copy", async () => {
    const db = getWorkspaceClient(ws);
    const { c, d } = await queued();
    await rejectDraft(db, ws, { draftId: d.id, userId, reason: "BAD_TIMING", now: NOW });
    const old = new Date(NOW.getTime() - 40 * 86_400_000);
    await prismaUnsafe.outreachDraft.update({ where: { id: d.id }, data: { createdAt: old } });

    const preview = await previewRestore(db, ws, c.id, NOW);
    expect(preview).toMatchObject({ restorable: true, mode: "regenerate", draftAgeDays: 40 });

    const drafted: string[] = [];
    const r = await restoreCandidate(db, ws, { candidateId: c.id, userId }, deps(drafted));
    expect(r).toEqual({ ok: true, mode: "regenerate", state: "PENDING_APPROVAL" });
    expect(drafted).toEqual([c.id]);
    const drafts = await db.outreachDraft.findMany({ where: { candidateId: c.id }, orderBy: { createdAt: "asc" } });
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.supersededAt).not.toBeNull();
    expect(drafts[1]).toMatchObject({ status: "PENDING", supersededAt: null });
  });

  it("restores a filtered-out candidate by drafting it", async () => {
    const db = getWorkspaceClient(ws);
    const pool = await db.candidatePool.create({ data: { workspaceId: ws, dedupeKey: "f1", name: "Szűrt Kft.", source: "NAME_HARVEST" } });
    const c = await db.prospectCandidate.create({
      data: {
        workspaceId: ws, runId, poolId: pool.id, productId, profileId, name: "Szűrt Kft.", state: "FILTERED_OUT", reason: "SIZE",
        reasonDetail: "employeeCount 400", facts: FACTS,
        contact: { kind: "named", name: "Nagy Péter", email: "peter@szurt.example", source: "registry", trail: [] },
      },
    });
    const r = await restoreCandidate(db, ws, { candidateId: c.id, userId }, deps());
    expect(r).toEqual({ ok: true, mode: "redraft", state: "PENDING_APPROVAL" });
  });
});

describe("the history view", () => {
  it("lists by tab with decision time and actor, and searches contacts", async () => {
    const db = getWorkspaceClient(ws);
    const a = await queued();
    await queued();
    await rejectDraft(db, ws, { draftId: a.d.id, userId, reason: "WRONG_TARGETING", now: NOW });
    const rejected = await listHistory(db, ws, { tab: "rejected" });
    expect(rejected.rows).toHaveLength(1);
    expect(rejected.rows[0]).toMatchObject({ company: a.c.name, decidedBy: "Reviewer", reason: "WRONG_TARGETING", product: "Web", campaign: "Dentists" });
    expect((await listHistory(db, ws, { tab: "pending" })).rows).toHaveLength(1);
    expect((await listHistory(db, ws, { tab: "rejected", q: "kovács" })).rows).toHaveLength(1);
    expect((await listHistory(db, ws, { tab: "rejected", reason: "WEAK_COPY" })).rows).toHaveLength(0);
    const detail = await loadCandidateDetail(db, ws, a.c.id);
    expect(detail!.events.map((e) => e.to)).toContain("REJECTED");
    expect(detail!.events.find((e) => e.to === "REJECTED")!.actor).toBe("Reviewer");
  });

  it("shows follow-up state on the Sent tab, and cancelling stops the sequence without touching the lead", async () => {
    const db = getWorkspaceClient(ws);
    const { c, d } = await queued();
    const company = await db.company.create({ data: { workspaceId: ws, name: "Lead Co" } });
    const lead = await db.lead.create({ data: { workspaceId: ws, companyId: company.id, email: "anna@x.example", stage: "CONTACTED", source: "OUTBOUND_ENGINE" } });
    await db.prospectCandidate.update({ where: { id: c.id }, data: { state: "SENT", leadId: lead.id } });
    await db.outreachDraft.update({ where: { id: d.id }, data: { status: "SENT", sentAt: NOW } });
    await db.outreachDraft.create({
      data: {
        workspaceId: ws, candidateId: c.id, productId, step: 1, variant: "named", templateVersion: "x", toAddress: d.toAddress,
        subject: "Re", body: "b", originalSubject: "Re", originalBody: "b", status: "APPROVED", scheduledFor: new Date(NOW.getTime() + 4 * 86_400_000),
      },
    });
    const sent = await listHistory(db, ws, { tab: "sent" });
    expect(sent.rows[0]!.followup).toMatchObject({ touchesSent: 1, next: { step: 1, drafted: true, status: "APPROVED" }, stoppedOnReply: false });

    expect(await cancelFollowups(db, ws, c.id, userId, NOW)).toEqual({ ok: true, cancelled: 1 });
    const after = await listHistory(db, ws, { tab: "sent" });
    expect(after.rows[0]!.followup).toMatchObject({ cancelled: true, next: null });
    expect(await scheduleFollowups(ws, { now: () => new Date(NOW.getTime() + 10 * 86_400_000), draft: { claude } })).toBe(0);
    expect(await db.lead.findUnique({ where: { id: lead.id } })).toMatchObject({ stage: "CONTACTED" });
    expect(await db.auditLog.count({ where: { action: "outbound.followups.cancelled", entityId: c.id } })).toBe(1);
  });
});
