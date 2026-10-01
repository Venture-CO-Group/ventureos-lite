import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { MockCegadatProvider } from "../../src/modules/registry/cegadat-mock";
import type { CompanyDatasheet } from "../../src/modules/registry/datasheet";
import type { CompanyRegistryApi } from "../../src/modules/registry/cegadat";
import { searchRegistry } from "../../src/modules/registry/registry-service";
import { advanceRun, type RunDeps } from "../../src/modules/outbound/run-engine";
import { createRun, estimateRunCost } from "../../src/modules/outbound/run-store";
import { harvestSegment } from "../../src/modules/outbound/sources";
import { ensureSegments } from "../../src/modules/outbound/segments";
import { toSegmentView } from "../../src/modules/outbound/catalog";
import type { VerifyResult } from "../../src/modules/verification/types";

/**
 * The sourcing pipeline end to end against the real database (playbook-v6
 * F3 VERIFICATION). The registry, the audit starter, the site reader and the
 * verifier are stubs; the pool, the candidates, the ledger and every
 * transition are real rows.
 */
const NAMES = ["Outbound Sourcing A", "Outbound Sourcing B"];
let wsA = "";
let wsB = "";
let profileId = "";
const NOW = new Date("2026-10-22T02:00:00Z");

function sheet(tax: string, name: string, over: Partial<CompanyDatasheet> = {}): CompanyDatasheet {
  return {
    taxNumber: tax,
    legalName: name,
    shortName: name,
    legalForm: "Kft.",
    registryNumber: null,
    statisticalCode: null,
    status: "Aktív",
    foundedAt: "2011-04-01",
    seat: { county: "Budapest", city: "Budapest", zip: null, oneLine: null },
    principalActivity: { code: "8623", label: "Fogorvosi járóbeteg-ellátás" },
    activities: [{ code: "8623", label: "Fogorvosi járóbeteg-ellátás" }],
    financialYear: 2025,
    netRevenue: 150_000_000n,
    equity: null,
    operatingResult: null,
    preTaxResult: null,
    afterTaxResult: null,
    balanceSheetTotal: null,
    employeeCount: 12,
    owners: [],
    managers: [],
    website: null,
    phone: null,
    email: null,
    ...over,
  };
}

const SHEETS: CompanyDatasheet[] = [
  sheet("10000001-2-41", "Alfa Fogászati Kft.", {
    website: "https://alfa.example",
    email: "info@alfa.example",
    managers: [{ name: "Dr. Alfa Anna", role: null }],
  }),
  sheet("10000002-2-41", "Béta Fogászati Kft.", {
    email: "bela.beta@beta.example",
    managers: [{ name: "Béta Béla", role: null }],
  }),
  sheet("10000003-2-41", "Céta Fogászati Kft.", { employeeCount: 400 }),
  sheet("10000004-2-41", "Delta Fogászati Kft."),
  sheet("10000005-2-41", "Epszilon Fogászati Kft."),
  sheet("10000006-2-41", "Fí Fogászati Kft.", { managers: [{ name: "Fí Ferenc", role: null }] }),
  sheet("10000007-2-41", "Gamma Autószerviz Kft.", { principalActivity: { code: "4520", label: null }, activities: [] }),
];

class CountingApi implements CompanyRegistryApi {
  readonly name = "mock";
  details: string[] = [];
  inner = new MockCegadatProvider(SHEETS);
  search(p: Parameters<CompanyRegistryApi["search"]>[0]) {
    return this.inner.search(p);
  }
  detail(t: string) {
    this.details.push(t);
    return this.inner.detail(t);
  }
}

function valid(email: string): VerifyResult {
  return { status: email.startsWith("bad") ? "invalid" : "valid", reason: email.startsWith("bad") ? "syntax" : "ok", address: email, checkedAt: NOW } as VerifyResult;
}

let auditId = "";
function deps(api: CountingApi, now = NOW): RunDeps {
  return {
    now: () => now,
    registryApi: api,
    startAudit: async () => ({ auditId, cached: true }),
    readSite: async (url) =>
      url.includes("alfa")
        ? { emails: ["info@alfa.example", "anna.alfa@alfa.example"], phones: ["+36 1 111 1111"], names: ["Dr. Alfa Anna"] }
        : null,
    verify: async (e) => valid(e),
    sleep: async () => {},
  };
}

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({ where: { name: { in: NAMES } }, select: { id: true } });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of [
    "candidateEvent",
    "prospectCandidate",
    "sourcingRun",
    "candidatePool",
    "harvestProgress",
    "registryQuotaLedger",
    "registrySheet",
    "registrySearchCache",
    "auditResult",
    "icpProfile",
    "product",
    "segment",
    "suppression",
    "company",
  ] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0], outboundConfig: { registry: { monthlyLimit: 1000, reservePct: 0 } } } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
});
afterAll(clean);

beforeEach(async () => {
  for (const t of [
    "candidateEvent",
    "prospectCandidate",
    "sourcingRun",
    "candidatePool",
    "harvestProgress",
    "registryQuotaLedger",
    "registrySheet",
    "registrySearchCache",
    "auditResult",
    "icpProfile",
    "product",
    "suppression",
    "company",
  ] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  }
  const db = getWorkspaceClient(wsA);
  await ensureSegments(db, wsA);
  const seg = await db.segment.findFirst({ where: { key: "private_clinics" } });
  await db.segment.update({ where: { id: seg!.id }, data: { fragments: ["Fogászati"], seedList: [] } });
  const product = await db.product.create({ data: { workspaceId: wsA, name: "Web", slug: "web", problemSolved: "Slow sites." } });
  profileId = (
    await db.icpProfile.create({
      data: {
        workspaceId: wsA,
        productId: product.id,
        name: "Dentists, small",
        segmentKeys: ["private_clinics"],
        sizeBands: ["MICRO", "SMALL"],
        dailyQuota: 10,
      },
    })
  ).id;
  // Delta is already a company in the CRM; Epszilon has unsubscribed.
  await db.company.create({ data: { workspaceId: wsA, name: "Delta Fogászati Kft.", taxId: "10000004241" } });
  await db.suppression.create({ data: { workspaceId: wsA, address: "tax:10000005241" } });
  auditId = (
    await db.auditResult.create({
      data: {
        workspaceId: wsA,
        url: "https://alfa.example",
        status: "done",
        score: 72,
        verdict: "STRONG",
        flags: ["slow site"],
        checks: [{ key: "psi_performance", label: "PageSpeed performance", pass: false, detail: "28 / 100" }],
        screenshots: {},
        expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
      },
    })
  ).id;
});

async function harvest(api: CountingApi) {
  const db = getWorkspaceClient(wsA);
  const seg = toSegmentView((await db.segment.findFirst({ where: { key: "private_clinics" } }))!);
  return harvestSegment(db, wsA, seg, {
    search: (p) => searchRegistry(wsA, p, { api, now: NOW }),
    sleep: async () => {},
    now: NOW,
  });
}

async function runToEnd(api: CountingApi, requested = 10, now = NOW) {
  const db = getWorkspaceClient(wsA);
  const run = await createRun(db, wsA, { profileId, requested, channel: "all", trigger: "NIGHTLY" });
  let outcome = await advanceRun(wsA, run.id, deps(api, now));
  for (let i = 0; i < 5 && outcome.again; i++) outcome = await advanceRun(wsA, run.id, deps(api, now));
  return { runId: run.id, outcome };
}

async function candidate(name: string) {
  return getWorkspaceClient(wsA).prospectCandidate.findFirst({ where: { name: { startsWith: name } } });
}

describe("channel A: name-fragment harvest", () => {
  it("fills the pool from the free search without spending any quota", async () => {
    const api = new CountingApi();
    const report = await harvest(api);
    const pool = await getWorkspaceClient(wsA).candidatePool.findMany();
    // Six names contain the fragment; the car repair does not.
    expect(pool.map((p) => p.name).sort()).toHaveLength(6);
    expect(pool.every((p) => p.source === "NAME_HARVEST")).toBe(true);
    expect((pool[0]!.hits as Array<{ fragment: string }>)[0]!.fragment).toBe("Fogászati");
    expect(report.created).toBe(6);
    expect(api.details).toEqual([]);
    expect(await getWorkspaceClient(wsA).registryQuotaLedger.count()).toBe(0);
  });
});

describe("a run through the whole pipeline", () => {
  it("pre-filters before spending, filters with measured reasons, and resolves contacts", async () => {
    const api = new CountingApi();
    await harvest(api);
    const estimate = await estimateRunCost(getWorkspaceClient(wsA), wsA, { profileId, requested: 10, channel: "all" }, NOW);
    expect(estimate!.eligible).toBe(6);

    const { outcome } = await runToEnd(api);
    expect(outcome.status).toBe("DONE");

    // The CRM duplicate and the suppressed company never cost a lookup.
    expect(api.details.sort()).toEqual(["10000001241", "10000002241", "10000003241", "10000006241"]);
    expect((await candidate("Delta"))).toMatchObject({ state: "FILTERED_OUT", reason: "IN_CRM" });
    expect((await candidate("Epszilon"))).toMatchObject({ state: "FILTERED_OUT", reason: "SUPPRESSED" });

    // The size refusal names the measured value.
    const ceta = await candidate("Céta");
    expect(ceta).toMatchObject({ state: "FILTERED_OUT", reason: "SIZE" });
    expect(ceta!.reasonDetail).toContain("employeeCount 400");

    // Alfa: audited, a named contact from the impresszum, audit facts to cite.
    const alfa = await candidate("Alfa");
    expect(alfa!.state).toBe("CONTACT_RESOLVED");
    expect(alfa!.contact).toMatchObject({ kind: "named", source: "impresszum", email: "anna.alfa@alfa.example", name: "Dr. Alfa Anna" });
    expect((alfa!.facts as Array<{ id: string }>).map((f) => f.id)).toContain("audit:psi_performance");

    // Béta: no website — skips the audit, carries the no-website hook, and
    // its personal registry address belongs to its manager.
    const beta = await candidate("Béta");
    expect(beta!.auditId).toBeNull();
    expect((beta!.facts as Array<{ id: string }>).map((f) => f.id)).toContain("site:none");
    expect(beta!.contact).toMatchObject({ kind: "named", source: "registry", name: "Béta Béla" });

    // Fí: nothing to write to → the LinkedIn queue, with the name to look for.
    const fi = await candidate("Fí");
    expect(fi!.state).toBe("LINKEDIN_QUEUE");
    expect(fi!.contact).toMatchObject({ kind: "none", managerName: "Fí Ferenc" });

    // The estimate was an upper bound on what the run actually spent.
    const charged = await getWorkspaceClient(wsA).registryQuotaLedger.count({ where: { cacheHit: false } });
    expect(charged).toBe(4);
    expect(charged).toBeLessThanOrEqual(estimate!.expectedLookups);

    // Every transition left an event.
    const events = await getWorkspaceClient(wsA).candidateEvent.findMany({ where: { candidateId: alfa!.id }, orderBy: { at: "asc" } });
    expect(events.map((e) => e.toState)).toEqual(["SOURCED", "ENRICHED", "FILTERED_IN", "AUDITED", "CONTACT_RESOLVED"]);
  });

  it("does not source a company again while it is being worked", async () => {
    const api = new CountingApi();
    await harvest(api);
    await runToEnd(api);
    const second = await estimateRunCost(getWorkspaceClient(wsA), wsA, { profileId, requested: 10, channel: "all" }, NOW);
    // Everything was either refused (90-day memory) or is in flight.
    expect(second!.eligible).toBe(0);
  });

  it("pauses on the day's allocation and resumes without spending twice", async () => {
    // 20 a month, 10 days left: two lookups a day.
    await prismaUnsafe.workspace.update({ where: { id: wsA }, data: { outboundConfig: { registry: { monthlyLimit: 20, reservePct: 0 } } } });
    try {
      const api = new CountingApi();
      await harvest(api);
      const { runId, outcome } = await runToEnd(api);
      expect(outcome.status).toBe("PAUSED_QUOTA");
      expect(api.details).toHaveLength(2);

      const tomorrow = new Date(NOW.getTime() + 86_400_000);
      let next = await advanceRun(wsA, runId, deps(api, tomorrow));
      for (let i = 0; i < 3 && next.again; i++) next = await advanceRun(wsA, runId, deps(api, tomorrow));
      expect(api.details).toHaveLength(4);
      // No tax number was ever paid for twice.
      expect(new Set(api.details).size).toBe(api.details.length);
    } finally {
      await prismaUnsafe.workspace.update({ where: { id: wsA }, data: { outboundConfig: { registry: { monthlyLimit: 1000, reservePct: 0 } } } });
    }
  });

  it("keeps one workspace's pool and runs out of another's", async () => {
    const api = new CountingApi();
    await harvest(api);
    await runToEnd(api);
    const b = getWorkspaceClient(wsB);
    expect(await b.candidatePool.count()).toBe(0);
    expect(await b.prospectCandidate.count()).toBe(0);
    expect(await b.sourcingRun.count()).toBe(0);
  });
});
