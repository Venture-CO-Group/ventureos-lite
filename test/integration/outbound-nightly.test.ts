import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { runNightFor } from "../../src/modules/outbound/schedule";
import { advanceRun, type RunDeps } from "../../src/modules/outbound/run-engine";
import { buildBriefing } from "../../src/modules/outbound/briefing";
import { fragmentYields, fragmentRetirementCandidates, outboundFunnel } from "../../src/modules/outbound/metrics";
import { processOutboundRetention } from "../../src/modules/outbound/retention";
import { eraseLeadData } from "../../src/modules/gdpr/erase";
import { MockCegadatProvider } from "../../src/modules/registry/cegadat-mock";
import { RegistryRequestError, type CompanyRegistryApi } from "../../src/modules/registry/cegadat";
import type { VerifyResult } from "../../src/modules/verification/types";

/**
 * The nightly fill, the briefing, measurement and retention against the real
 * database (playbook-v6 F6 VERIFICATION).
 */
const NAMES = ["Outbound Nightly A"];
let ws = "";
let productId = "";
let profileId = "";
// Thursday 22 Oct 2026, 03:10 Budapest.
const NIGHT = new Date("2026-10-22T01:10:00Z");

async function wipe(ids: string[]) {
  for (const t of [
    "activity",
    "outreachDraft",
    "candidateEvent",
    "prospectCandidate",
    "sourcingRun",
    "candidatePool",
    "registryQuotaLedger",
    "registrySheet",
    "registrySearchCache",
    "harvestProgress",
    "suppression",
    "lead",
    "company",
    "icpProfile",
    "product",
    "segment",
  ] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
}

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({ where: { name: { in: NAMES } }, select: { id: true } });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  await wipe(ids);
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await clean();
  ws = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
});
afterAll(clean);

beforeEach(async () => {
  await wipe([ws]);
  await prismaUnsafe.workspace.update({
    where: { id: ws },
    data: { outboundConfig: { schedule: { enabled: true, hour: 3, minute: 0 }, registry: { monthlyLimit: 1000, reservePct: 0 } } },
  });
  const db = getWorkspaceClient(ws);
  productId = (await db.product.create({ data: { workspaceId: ws, name: "Web", slug: "web", problemSolved: "Slow sites.", priority: 1 } })).id;
  profileId = (
    await db.icpProfile.create({ data: { workspaceId: ws, productId, name: "Dentists", segmentKeys: ["private_clinics"], dailyQuota: 15 } })
  ).id;
  // A pool large enough not to be exhausted.
  await db.candidatePool.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      workspaceId: ws,
      dedupeKey: `tax:${10000000000 + i}`,
      taxNumber: String(10000000000 + i),
      name: `Fogászat ${i} Kft.`,
      source: "NAME_HARVEST" as const,
      segmentKeys: ["private_clinics"],
      hits: [{ segment: "private_clinics", fragment: i < 25 ? "fogászat" : "rendelő", version: 1, at: NIGHT.toISOString() }],
    })),
  });
});

async function pendingDrafts(n: number) {
  const db = getWorkspaceClient(ws);
  const run = await db.sourcingRun.create({ data: { workspaceId: ws, productId, profileId, requested: n, status: "DONE" } });
  const pool = await db.candidatePool.findMany({ take: n });
  for (const p of pool) {
    const c = await db.prospectCandidate.create({
      data: { workspaceId: ws, runId: run.id, poolId: p.id, productId, profileId, name: p.name, state: "PENDING_APPROVAL" },
    });
    await db.outreachDraft.create({
      data: { workspaceId: ws, candidateId: c.id, productId, variant: "named", templateVersion: "x", toAddress: "a@b.example", subject: "s", body: "b", originalSubject: "s", originalBody: "b" },
    });
  }
}

describe("the nightly fill (spec §4.43.10)", () => {
  it("with 12 unreviewed drafts and a target of 15, plans a run for exactly 3", async () => {
    await pendingDrafts(12);
    const r = await runNightFor(ws, NIGHT, { enqueue: false });
    expect(r!.plan.allocations).toEqual([{ productId, profileId, requested: 3 }]);
    const runs = await getWorkspaceClient(ws).sourcingRun.findMany({ where: { trigger: "NIGHTLY" } });
    expect(runs.map((x) => x.requested)).toEqual([3]);
  });

  it("runs once per night, however often the sweep fires", async () => {
    expect(await runNightFor(ws, NIGHT, { enqueue: false })).not.toBeNull();
    expect(await runNightFor(ws, new Date(NIGHT.getTime() + 15 * 60_000), { enqueue: false })).toBeNull();
    expect(await getWorkspaceClient(ws).sourcingRun.count({ where: { trigger: "NIGHTLY" } })).toBe(1);
  });

  it("resumes a run paused on yesterday's quota", async () => {
    await getWorkspaceClient(ws).sourcingRun.create({ data: { workspaceId: ws, productId, profileId, requested: 5, status: "PAUSED_QUOTA" } });
    const r = await runNightFor(ws, NIGHT, { enqueue: false });
    expect(r!.resumed).toBe(1);
  });

  it("parks a failing candidate and finishes the run without it", async () => {
    const db = getWorkspaceClient(ws);
    const flaky: CompanyRegistryApi = {
      name: "mock",
      search: (p) => new MockCegadatProvider([]).search(p),
      detail: async (t) => {
        if (t === "10000000000") throw new RegistryRequestError("Cégadat error 3: internal", 3, true);
        return null;
      },
    };
    const deps: RunDeps = {
      now: () => NIGHT,
      registryApi: flaky,
      startAudit: async () => ({ auditId: "none", cached: true }),
      readSite: async () => null,
      verify: async (e) => ({ status: "valid", reason: "ok", address: e, checkedAt: NIGHT }) as VerifyResult,
      sleep: async () => {},
      maxLookupsPerPass: 40,
    };
    const run = await db.sourcingRun.create({ data: { workspaceId: ws, productId, profileId, requested: 3, passes: 1 } });
    const out = await advanceRun(ws, run.id, deps);
    expect(out.status).toBe("DONE");
    const parked = await db.prospectCandidate.findFirst({ where: { runId: run.id, taxNumber: "10000000000" } });
    expect(parked!.parkedUntil!.getTime()).toBeGreaterThan(NIGHT.getTime());
    expect(parked!.state).toBe("SOURCED");
  });
});

describe("briefing and measurement", () => {
  it("the briefing reconciles with the funnel and the queue", async () => {
    await pendingDrafts(4);
    const db = getWorkspaceClient(ws);
    const b = await buildBriefing(db, ws, NIGHT);
    const funnel = await outboundFunnel(db);
    expect(b.active).toBe(true);
    expect(b.pending.total).toBe(4);
    expect(b.pending.byProduct).toEqual([{ name: "Web", n: 4 }]);
    expect(funnel.total.drafted).toBe(4);
  });

  it("ranks fragments by yield and proposes retiring one that never gets approved", async () => {
    const db = getWorkspaceClient(ws);
    const run = await db.sourcingRun.create({ data: { workspaceId: ws, productId, profileId, requested: 30, status: "DONE" } });
    const pool = await db.candidatePool.findMany({ orderBy: { name: "asc" } });
    for (const p of pool) {
      const fragment = (p.hits as Array<{ fragment: string }>)[0]!.fragment;
      await db.prospectCandidate.create({
        data: {
          workspaceId: ws,
          runId: run.id,
          poolId: p.id,
          productId,
          profileId,
          name: p.name,
          // Every "fogászat" company is rejected; every "rendelő" one approved.
          state: fragment === "fogászat" ? "REJECTED" : "APPROVED",
          reason: fragment === "fogászat" ? "WRONG_TARGETING" : null,
        },
      });
    }
    const yields = (await fragmentYields(db)).private_clinics!;
    expect(yields.find((y) => y.fragment === "rendelő")).toMatchObject({ sourced: 5, approved: 5 });
    expect(yields.find((y) => y.fragment === "fogászat")).toMatchObject({ sourced: 25, approved: 0 });
    expect(await fragmentRetirementCandidates(db)).toEqual([{ segmentKey: "private_clinics", fragment: "fogászat", sourced: 25, decided: 25 }]);
  });
});

describe("GDPR (CLAUDE.md hard rule 9)", () => {
  it("erasing a lead removes its candidate and drafts but keeps the suppression", async () => {
    const db = getWorkspaceClient(ws);
    const company = await db.company.create({ data: { workspaceId: ws, name: "X" } });
    const lead = await db.lead.create({ data: { workspaceId: ws, companyId: company.id, email: "anna@x.example", source: "OUTBOUND_ENGINE" } });
    const run = await db.sourcingRun.create({ data: { workspaceId: ws, productId, profileId, requested: 1 } });
    const pool = await db.candidatePool.findFirstOrThrow();
    const c = await db.prospectCandidate.create({ data: { workspaceId: ws, runId: run.id, poolId: pool.id, name: "X", state: "SENT", leadId: lead.id, contact: { name: "Anna" } } });
    await db.outreachDraft.create({ data: { workspaceId: ws, candidateId: c.id, variant: "named", templateVersion: "x", toAddress: "anna@x.example", subject: "s", body: "b", originalSubject: "s", originalBody: "b", status: "SENT" } });
    await db.suppression.create({ data: { workspaceId: ws, address: "@x.example" } });
    await eraseLeadData(db, lead.id, { eraseDocuments: true });
    expect(await db.prospectCandidate.count({ where: { id: c.id } })).toBe(0);
    expect(await db.outreachDraft.count({ where: { candidateId: c.id } })).toBe(0);
    expect(await db.suppression.count({ where: { address: "@x.example" } })).toBe(1);
  });

  it("deletes candidates a year without interaction, and stale datasheets", async () => {
    const db = getWorkspaceClient(ws);
    const run = await db.sourcingRun.create({ data: { workspaceId: ws, productId, profileId, requested: 1 } });
    const pool = await db.candidatePool.findFirstOrThrow();
    const old = await db.prospectCandidate.create({ data: { workspaceId: ws, runId: run.id, poolId: pool.id, name: "Old", state: "FILTERED_OUT" } });
    await prismaUnsafe.$executeRawUnsafe(`UPDATE prospect_candidates SET updated_at = NOW() - INTERVAL '400 days' WHERE id = '${old.id}'`);
    await db.registrySheet.create({
      data: { workspaceId: ws, taxNumber: "99999999999", provider: "mock", sheet: {}, expiresAt: new Date(Date.now() - 200 * 86_400_000) },
    });
    const r = await processOutboundRetention(new Date());
    expect(r.candidates).toBeGreaterThanOrEqual(1);
    expect(await db.prospectCandidate.count({ where: { id: old.id } })).toBe(0);
    expect(await db.registrySheet.count({ where: { taxNumber: "99999999999" } })).toBe(0);
  });
});
