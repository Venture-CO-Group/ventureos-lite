import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { draftCandidate } from "../../src/modules/outbound/draft-engine";
import { approveDraft, bulkApprove, editDraft, markOpened, rejectDraft, routeToLinkedIn } from "../../src/modules/outbound/approval";
import type { CallClaudeParams, CallClaudeResult } from "../../src/lib/ai/call-claude";
import type { OutboundDraftOutput } from "../../src/lib/ai/prompts/outbound-draft";
import type { CandidateFact } from "../../src/modules/outbound/facts";

/**
 * Drafting and the approval queue against the real database (playbook-v6
 * F4 VERIFICATION). Claude is a stub that records what it was shown and
 * answers with whatever the test hands it — so "the prompt never contained
 * the pattern reference" is an assertion on the actual prompt text.
 */
const NAMES = ["Outbound Approval A"];
let ws = "";
let userId = "";
let otherUserId = "";
let productId = "";
let profileId = "";
let runId = "";

const GOOD_FACTS: CandidateFact[] = [
  { id: "audit:psi_performance", kind: "audit", label: "PageSpeed performance", value: "28 / 100" },
  { id: "registry:founded", kind: "registry", label: "Founded", value: "2011 (15 years)" },
  { id: "registry:seat", kind: "registry", label: "Seat", value: "Budapest" },
];
const GENERIC_FACTS: CandidateFact[] = [
  { id: "registry:seat", kind: "registry", label: "Seat", value: "Budapest" },
  { id: "registry:activity", kind: "registry", label: "Principal activity", value: "Fogorvosi járóbeteg-ellátás" },
];

const GOOD_DRAFT: OutboundDraftOutput = {
  subject: "A honlapjuk 28 pontot kapott",
  body: "Tisztelt Kovács Anna! A Mosoly Fogászat oldala a PageSpeed mérésén 28 / 100 pontot kapott, ami mobilon lassú betöltést jelent. A Dentalia Kft.-nél hasonló helyzetből indultunk. Nyitott lenne egy 15 perces beszélgetésre a jövő héten?",
  personalisationPoints: [{ factId: "audit:psi_performance", quote: "28 / 100" }],
};

function stubClaude(outputs: OutboundDraftOutput[]) {
  const prompts: string[] = [];
  let i = 0;
  const fn = async (p: CallClaudeParams<OutboundDraftOutput>): Promise<CallClaudeResult<OutboundDraftOutput>> => {
    prompts.push(p.messages.map((m) => m.content).join("\n"));
    const data = outputs[Math.min(i++, outputs.length - 1)]!;
    return { data, model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.01 };
  };
  return { fn, prompts, calls: () => prompts.length };
}

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({ where: { name: { in: NAMES } }, select: { id: true } });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    for (const t of [
      "activity",
      "outreachDraft",
      "candidateEvent",
      "prospectCandidate",
      "sourcingRun",
      "candidatePool",
      "lead",
      "registryData",
      "company",
      "icpProfile",
      "productReference",
      "product",
    ] as const) {
      // @ts-expect-error dynamic model access
      await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
    }
    await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
  }
  await prismaUnsafe.user.deleteMany({ where: { email: { in: ["outbound-approver@test.local", "outbound-other@test.local"] } } });
}

beforeAll(async () => {
  await clean();
  ws = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  userId = (await prismaUnsafe.user.create({ data: { email: "outbound-approver@test.local", name: "Approver", passwordHash: "x" } })).id;
  otherUserId = (await prismaUnsafe.user.create({ data: { email: "outbound-other@test.local", name: "Other", passwordHash: "x" } })).id;
});
afterAll(clean);

beforeEach(async () => {
  for (const t of ["activity", "outreachDraft", "candidateEvent", "prospectCandidate", "sourcingRun", "candidatePool", "lead", "registryData", "company", "icpProfile", "productReference", "product"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: ws } });
  }
  await prismaUnsafe.workspace.update({ where: { id: ws }, data: { icpConfig: {} } });
  const db = getWorkspaceClient(ws);
  productId = (
    await db.product.create({
      data: {
        workspaceId: ws,
        name: "Weboldal-fejlesztés",
        slug: "web",
        problemSolved: "Lassú, elavult oldalak elvesztik a foglalásokat.",
        valueProps: [{ claim: "Gyorsabb oldal", evidence: "PSI 28 → 94 a Dentaliánál" }],
      },
    })
  ).id;
  await db.productReference.createMany({
    data: [
      { workspaceId: ws, productId, companyName: "Dentalia Kft.", isClient: true, position: 0 },
      { workspaceId: ws, productId, companyName: "PwC Magyarország Kft.", isClient: false, position: 1 },
    ],
  });
  profileId = (await db.icpProfile.create({ data: { workspaceId: ws, productId, name: "Dentists", segmentKeys: ["private_clinics"] } })).id;
  runId = (await db.sourcingRun.create({ data: { workspaceId: ws, profileId, productId, requested: 5 } })).id;
});

async function candidate(facts: CandidateFact[], over: { contactKind?: string; state?: "CONTACT_RESOLVED" } = {}) {
  const db = getWorkspaceClient(ws);
  const pool = await db.candidatePool.create({
    data: { workspaceId: ws, dedupeKey: `tax:${Math.random()}`, name: "Mosoly Fogászat Kft.", source: "NAME_HARVEST", segmentKeys: ["private_clinics"] },
  });
  return db.prospectCandidate.create({
    data: {
      workspaceId: ws,
      runId,
      poolId: pool.id,
      productId,
      profileId,
      name: "Mosoly Fogászat Kft.",
      state: over.state ?? "CONTACT_RESOLVED",
      matchedSegment: "private_clinics",
      website: "https://mosoly.example",
      facts: facts as object[],
      contact: {
        kind: over.contactKind ?? "named",
        name: "Kovács Anna",
        email: "kovacs.anna@mosoly.example",
        phone: null,
        source: "impresszum",
        managerName: "Kovács Anna",
        verify: { status: "valid", reason: "ok" },
        trail: [],
      },
    },
  });
}

async function draftFor(c: { id: string }) {
  return getWorkspaceClient(ws).outreachDraft.findFirstOrThrow({ where: { candidateId: c.id } });
}

describe("drafting and the hook gate (CLAUDE.md hard rule 10)", () => {
  it("drops a candidate with only generic facts as NO_HOOK without calling Claude", async () => {
    const c = await candidate(GENERIC_FACTS);
    const claude = stubClaude([GOOD_DRAFT]);
    expect(await draftCandidate(ws, c.id, { claude: claude.fn })).toBe("no_hook");
    expect(claude.calls()).toBe(0);
    const after = await getWorkspaceClient(ws).prospectCandidate.findUnique({ where: { id: c.id } });
    expect(after).toMatchObject({ state: "FILTERED_OUT", reason: "NO_HOOK" });
    expect(await getWorkspaceClient(ws).outreachDraft.count()).toBe(0);
  });

  it("refuses a personalisation point that does not match stored data, once retried", async () => {
    const c = await candidate(GOOD_FACTS);
    const invented = { ...GOOD_DRAFT, personalisationPoints: [{ factId: "registry:revenue", quote: "28 / 100" }] };
    const claude = stubClaude([invented, invented]);
    expect(await draftCandidate(ws, c.id, { claude: claude.fn })).toBe("no_hook");
    expect(claude.calls()).toBe(2);
    const after = await getWorkspaceClient(ws).prospectCandidate.findUnique({ where: { id: c.id } });
    expect(after!.reasonDetail).toContain("registry:revenue");
  });

  it("shows the model only true clients, and refuses copy that names a pattern reference", async () => {
    const c = await candidate(GOOD_FACTS);
    const leaky = { ...GOOD_DRAFT, body: `${GOOD_DRAFT.body} A PwC is így dolgozik.` };
    const claude = stubClaude([leaky, GOOD_DRAFT]);
    expect(await draftCandidate(ws, c.id, { claude: claude.fn })).toBe("drafted");
    expect(claude.prompts[0]).toContain("Dentalia Kft.");
    expect(claude.prompts[0]).not.toContain("PwC");
    // The retry was told why, and the stored draft is the clean one.
    expect(claude.prompts[1]).toContain("targeting pattern");
    const d = await draftFor(c);
    expect(d.body).not.toContain("PwC");
    expect(d.status).toBe("PENDING");
    const after = await getWorkspaceClient(ws).prospectCandidate.findUnique({ where: { id: c.id } });
    expect(after!.state).toBe("PENDING_APPROVAL");
  });
});

describe("the approval queue (spec §4.43.8)", () => {
  async function queued() {
    const c = await candidate(GOOD_FACTS);
    await draftCandidate(ws, c.id, { claude: stubClaude([GOOD_DRAFT]).fn });
    return { c, d: await draftFor(c) };
  }

  it("approval creates an outbound lead at Researched and records who approved", async () => {
    const { c, d } = await queued();
    const r = await approveDraft(getWorkspaceClient(ws), ws, { draftId: d.id, userId });
    expect(r).toEqual({ ok: true });
    const db = getWorkspaceClient(ws);
    const cand = await db.prospectCandidate.findUnique({ where: { id: c.id } });
    expect(cand!.state).toBe("APPROVED");
    const lead = await db.lead.findUnique({ where: { id: cand!.leadId! } });
    expect(lead).toMatchObject({ source: "OUTBOUND_ENGINE", stage: "RESEARCHED", email: "kovacs.anna@mosoly.example", contactName: "Kovács Anna" });
    expect(lead!.icpScore).toBeGreaterThanOrEqual(3);
    expect(await db.outreachDraft.findUnique({ where: { id: d.id } })).toMatchObject({ status: "APPROVED", decidedById: userId });
  });

  it("refuses an edit that removes every company-specific fact", async () => {
    const { d } = await queued();
    const r = await approveDraft(getWorkspaceClient(ws), ws, {
      draftId: d.id,
      userId,
      subject: "Bemutatkozás",
      body: "Tisztelt Kovács Anna! Weboldalakat készítünk. Beszélhetnénk 15 percet?",
    });
    expect(r.ok).toBe(false);
  });

  it("stores the edited text and keeps the original", async () => {
    const { d } = await queued();
    const db = getWorkspaceClient(ws);
    const body = d.body.replace("Nyitott lenne", "Lenne kedve");
    expect(await editDraft(db, d.id, { subject: d.subject, body })).toEqual({ ok: true });
    await approveDraft(db, ws, { draftId: d.id, userId });
    const after = await db.outreachDraft.findUnique({ where: { id: d.id } });
    expect(after).toMatchObject({ body, edited: true, originalBody: d.body });
  });

  it("cannot reject without a reason, or with Other and no note", async () => {
    const { d } = await queued();
    const db = getWorkspaceClient(ws);
    // @ts-expect-error — the point is a missing reason
    expect((await rejectDraft(db, ws, { draftId: d.id, userId, reason: undefined })).ok).toBe(false);
    expect((await rejectDraft(db, ws, { draftId: d.id, userId, reason: "OTHER" })).ok).toBe(false);
    expect(await rejectDraft(db, ws, { draftId: d.id, userId, reason: "WRONG_TARGETING" })).toEqual({ ok: true });
    const cand = await db.prospectCandidate.findUnique({ where: { id: d.candidateId } });
    expect(cand).toMatchObject({ state: "REJECTED", reason: "WRONG_TARGETING" });
    expect(cand!.leadId).toBeNull();
  });

  it("bulk-approves only the cards the same reviewer opened", async () => {
    const a = await queued();
    const b = await queued();
    const db = getWorkspaceClient(ws);
    await markOpened(db, a.d.id, userId);
    await markOpened(db, b.d.id, otherUserId);
    const r = await bulkApprove(db, ws, { draftIds: [a.d.id, b.d.id], userId });
    expect(r.approved).toEqual([a.d.id]);
    expect(r.skipped).toEqual([{ id: b.d.id, reason: "not opened by you" }]);
  });

  it("refuses approval when the lead would fail the score gate", async () => {
    await prismaUnsafe.workspace.update({ where: { id: ws }, data: { icpConfig: { gateThreshold: 5 } } });
    const c = await candidate(GOOD_FACTS, { contactKind: "generic" });
    await draftCandidate(ws, c.id, { claude: stubClaude([GOOD_DRAFT]).fn });
    const d = await draftFor(c);
    const r = await approveDraft(getWorkspaceClient(ws), ws, { draftId: d.id, userId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("cannot enter Contacted");
  });

  it("routes a company to the LinkedIn queue with L", async () => {
    const { c, d } = await queued();
    expect(await routeToLinkedIn(getWorkspaceClient(ws), ws, { draftId: d.id, userId })).toEqual({ ok: true });
    expect((await getWorkspaceClient(ws).prospectCandidate.findUnique({ where: { id: c.id } }))!.state).toBe("LINKEDIN_QUEUE");
  });
});
