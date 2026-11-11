import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { saveList } from "../../src/modules/finder/store";
import {
  advanceFinderRun,
  createFinderRun,
  estimateEnrichment,
  harvestList,
  resumeFinderRun,
  type FinderDeps,
} from "../../src/modules/finder/engine";
import type { FinderCriteriaInput } from "../../src/modules/finder/criteria";
import { enrichListContacts } from "../../src/modules/finder/contacts";
import { loadFinderRows } from "../../src/modules/finder/rows-load";
import { addResultsAsLeads, sendResultsToOutbound, suppressResults } from "../../src/modules/finder/results-ops";
import { ensureSegments } from "../../src/modules/outbound/segments";
import { fixtureApi, type FixtureApi } from "../helpers/cegadat-fixtures";

/**
 * The Company Finder end to end against the real database and the Cégadat
 * fixtures (spec: Company Finder, VERIFICATION). The registry is the real
 * client over a stub fetch serving the captured answers; the pool, the
 * results, the runs and the quota ledger are real rows.
 */
const NAMES = ["Company Finder A", "Company Finder B", "Company Finder Tight"];
let wsA = "";
let wsB = "";
let wsTight = "";
/** The last day of the month: today's batch allocation is the whole batch share. */
const NOW = new Date("2026-11-30T09:00:00Z");

/** Six companies' full names contain "Társaság"; the two sole traders' do not. */
const MICRO_BUDAPEST_EMAIL: FinderCriteriaInput = {
  keywords: ["Társaság"],
  sizeBands: ["MICRO"],
  counties: ["Budapest"],
  contactRequirement: "email",
};

const TABLES = [
  "finderResult",
  "finderRun",
  "icpProfile",
  "product",
  "registryData",
  "finderList",
  "candidatePool",
  "harvestProgress",
  "registryQuotaLedger",
  "registrySheet",
  "registrySearchCache",
  "suppression",
  "activity",
  "lead",
  "company",
  "auditLog",
] as const;

async function wipe(ids: string[]) {
  for (const t of TABLES) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
}

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({ where: { name: { in: NAMES } }, select: { id: true } });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  await wipe(ids);
  await prismaUnsafe.segment.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await clean();
  const cfg = (monthlyLimit: number) => ({ registry: { monthlyLimit, reservePct: 0 } });
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0]!, outboundConfig: cfg(1000) } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1]!, outboundConfig: cfg(1000) } })).id;
  wsTight = (await prismaUnsafe.workspace.create({ data: { name: NAMES[2]!, outboundConfig: cfg(4) } })).id;
});
afterAll(clean);
beforeEach(() => wipe([wsA, wsB, wsTight]));

function deps(f: FixtureApi, now = NOW): FinderDeps {
  return { now: () => now, registryApi: f.api, sleep: async () => {}, lookupsPerPass: 50 };
}

async function newList(ws: string, criteria: FinderCriteriaInput, cachedOnly = false) {
  const res = await saveList(getWorkspaceClient(ws), ws, { name: "Test list", criteria, cachedOnly }, null);
  if (!res.ok) throw new Error(res.error);
  return res.list;
}

async function charged(ws: string) {
  return getWorkspaceClient(ws).registryQuotaLedger.count({
    where: { cacheHit: false, outcome: { in: ["ok", "not_found", "error"] } },
  });
}

/** Drive a run the way the worker does: passes until it stops asking for another. */
async function drive(ws: string, runId: string, d: FinderDeps) {
  for (let i = 0; i < 50; i++) {
    const o = await advanceFinderRun(ws, runId, d);
    if (!o.again) return o;
  }
  throw new Error("run did not settle");
}

async function matches(ws: string, listId: string) {
  return (
    await getWorkspaceClient(ws).finderResult.findMany({ where: { listId, state: "MATCH" }, select: { taxNumber: true }, orderBy: { taxNumber: "asc" } })
  ).map((r) => r.taxNumber);
}

describe("phase 1 — harvest and pre-filter", () => {
  it("harvests into the shared pool, deduplicated by tax number, and spends no quota", async () => {
    const f = fixtureApi();
    const list = await newList(wsA, MICRO_BUDAPEST_EMAIL);
    const r = await harvestList(wsA, list.id, deps(f));

    expect(r.stats.candidates).toBe(6);
    expect(r.stats.cached).toBe(0);
    expect(r.stats.metered).toBe(6);
    expect(f.detailCalls).toEqual([]);
    expect(await charged(wsA)).toBe(0);
    expect(await getWorkspaceClient(wsA).registryQuotaLedger.count()).toBe(0);

    // The motor's pool, not a parallel one: one row per tax number, tagged
    // with the keyword's harvest key.
    const pool = await getWorkspaceClient(wsA).candidatePool.findMany();
    expect(pool).toHaveLength(6);
    expect(new Set(pool.map((p) => p.dedupeKey)).size).toBe(6);
    expect(pool.every((p) => (p.segmentKeys as string[]).includes("kw:tarsasag"))).toBe(true);
    expect((await prismaUnsafe.finderList.findUnique({ where: { id: list.id } }))!.status).toBe("READY");
  });

  it("drops CRM companies, suppressed ones and implausible legal forms before any lookup", async () => {
    const f = fixtureApi();
    const db = getWorkspaceClient(wsA);
    await db.company.create({ data: { workspaceId: wsA, name: "WellData Kft.", taxId: "32305964-2-43" } });
    await db.suppression.create({ data: { workspaceId: wsA, address: "tax:14945083241" } });
    // The pool keeps the short name ("… Kft."), which states the legal form:
    // a Zrt.-only list drops the three remaining Kft.s for free.
    const list = await newList(wsA, { keywords: ["Társaság"], legalForms: ["Zrt."] });
    const r = await harvestList(wsA, list.id, deps(f));
    expect(r.stats.excluded).toEqual({ IN_CRM: 1, SUPPRESSED: 1, LEGAL_FORM: 3 });
    expect(r.stats.metered).toBe(1); // Budapest Film Zrt.
    expect(f.detailCalls).toEqual([]);
  });

  it("filters candidates with a cached datasheet for free", async () => {
    const f = fixtureApi();
    const first = await newList(wsA, MICRO_BUDAPEST_EMAIL);
    await harvestList(wsA, first.id, deps(f));
    const run = await createFinderRun(getWorkspaceClient(wsA), wsA, {
      listId: first.id,
      maxLookups: 10,
      estimate: await estimateEnrichment(wsA, first.id, 10, NOW),
      userId: null,
    });
    await drive(wsA, run.id, deps(f));
    const spent = await charged(wsA);

    // A second list over the same companies: everything is in the cache now.
    const second = await newList(wsA, { keywords: ["Társaság"], counties: ["Pest"] });
    const r = await harvestList(wsA, second.id, deps(f));
    expect(r.stats.cached).toBe(6);
    expect(r.stats.metered).toBe(0);
    expect(await charged(wsA)).toBe(spent);
    expect(await matches(wsA, second.id)).toEqual(["10886861244"]); // Coca-Cola HBC, Dunaharaszti (Pest)
  });
});

describe("phase 2 — metered enrichment", () => {
  it("returns exactly the micro Budapest companies with an email, and the estimate matches the spend", async () => {
    const f = fixtureApi();
    const list = await newList(wsA, MICRO_BUDAPEST_EMAIL);
    await harvestList(wsA, list.id, deps(f));
    const estimate = await estimateEnrichment(wsA, list.id, 100, NOW);
    expect(estimate).toMatchObject({ pending: 6, cachedNow: 0, meteredNeeded: 6, expected: 6, expectedToday: 6, exceedsToday: false });
    expect(estimate.monthShare).toBeCloseTo(6 / 1000);

    const run = await createFinderRun(getWorkspaceClient(wsA), wsA, { listId: list.id, maxLookups: 100, estimate, userId: null });
    const o = await drive(wsA, run.id, deps(f));
    expect(o.status).toBe("DONE");

    expect(await matches(wsA, list.id)).toEqual(["99999998241"]);
    expect(await charged(wsA)).toBe(estimate.expected);
    expect(f.detailCalls).toHaveLength(estimate.expected);
    const after = await prismaUnsafe.finderRun.findUnique({ where: { id: run.id } });
    expect(after).toMatchObject({ lookupsSpent: 6, paidMatches: 1, matches: 1, status: "DONE" });

    // The refusals name the rule: WellData and DAYTON are micro and in Budapest, but have no email.
    const contact = await getWorkspaceClient(wsA).finderResult.findMany({ where: { listId: list.id, reason: "CONTACT" } });
    expect(contact.map((c) => c.taxNumber).sort()).toEqual(["14945083241", "32305964243"]);
    // And every contact field on the match records its source.
    const m = await getWorkspaceClient(wsA).finderResult.findFirst({ where: { listId: list.id, state: "MATCH" } });
    expect(m!.contacts).toEqual({ email: { value: "iroda@arviztuero.example", source: "registry" } });
  });

  it("stops after the first batch so the yield can be judged, then continues", async () => {
    const f = fixtureApi();
    const list = await newList(wsA, { keywords: ["Társaság"] });
    await harvestList(wsA, list.id, deps(f));
    const db = getWorkspaceClient(wsA);
    const estimate = await estimateEnrichment(wsA, list.id, 50, NOW);
    const run = await createFinderRun(db, wsA, { listId: list.id, maxLookups: 50, estimate, userId: null });
    await db.finderRun.update({ where: { id: run.id }, data: { checkpointAt: 2 } });

    const o = await drive(wsA, run.id, deps(f));
    expect(o.status).toBe("CHECKPOINT");
    expect(o.message).toMatch(/matches per 100 lookups/);
    expect(await charged(wsA)).toBe(2);

    expect((await resumeFinderRun(db, run.id)).ok).toBe(true);
    const done = await drive(wsA, run.id, deps(f));
    expect(done.status).toBe("DONE");
    expect(await charged(wsA)).toBe(6);
    expect(new Set(f.detailCalls).size).toBe(f.detailCalls.length);
  });

  it("pauses cleanly when the day's allocation runs out and resumes without paying twice", async () => {
    const f = fixtureApi();
    const list = await newList(wsTight, { keywords: ["Társaság"] });
    await harvestList(wsTight, list.id, deps(f));
    const db = getWorkspaceClient(wsTight);
    const estimate = await estimateEnrichment(wsTight, list.id, 100, NOW);
    expect(estimate).toMatchObject({ expected: 6, expectedToday: 4, exceedsToday: true });

    const run = await createFinderRun(db, wsTight, { listId: list.id, maxLookups: 100, estimate, userId: null });
    const paused = await drive(wsTight, run.id, deps(f));
    expect(paused.status).toBe("PAUSED_QUOTA");
    expect(await charged(wsTight)).toBe(4);
    expect((await prismaUnsafe.finderList.findUnique({ where: { id: list.id } }))!.status).toBe("PAUSED_QUOTA");
    expect(await db.finderResult.count({ where: { listId: list.id, state: "PENDING" } })).toBe(2);

    // Next month's budget (or a bigger plan): resume the same list.
    await prismaUnsafe.workspace.update({ where: { id: wsTight }, data: { outboundConfig: { registry: { monthlyLimit: 10, reservePct: 0 } } } });
    expect((await resumeFinderRun(db, run.id)).ok).toBe(true);
    const done = await drive(wsTight, run.id, deps(f));
    expect(done.status).toBe("DONE");
    expect(await charged(wsTight)).toBe(6);
    expect(f.detailCalls).toHaveLength(6);
    expect(new Set(f.detailCalls).size).toBe(6);
  });

  it("treats the provider's own limit answer as a pause, not a failure, and does not charge it", async () => {
    const f = fixtureApi();
    const list = await newList(wsA, { keywords: ["Társaság"] });
    await harvestList(wsA, list.id, deps(f));
    const db = getWorkspaceClient(wsA);
    const run = await createFinderRun(db, wsA, { listId: list.id, maxLookups: 20, estimate: await estimateEnrichment(wsA, list.id, 20, NOW), userId: null });
    f.failQuotaNext(1);
    expect((await drive(wsA, run.id, deps(f))).status).toBe("PAUSED_QUOTA");
    expect(await charged(wsA)).toBe(0);
    await resumeFinderRun(db, run.id);
    expect((await drive(wsA, run.id, deps(f))).status).toBe("DONE");
    expect(await charged(wsA)).toBe(6);
  });

  it("keeps workspaces apart: another workspace's cache, pool and results are invisible", async () => {
    const f = fixtureApi();
    const list = await newList(wsA, MICRO_BUDAPEST_EMAIL);
    await harvestList(wsA, list.id, deps(f));
    const run = await createFinderRun(getWorkspaceClient(wsA), wsA, { listId: list.id, maxLookups: 10, estimate: await estimateEnrichment(wsA, list.id, 10, NOW), userId: null });
    await drive(wsA, run.id, deps(f));

    const other = await newList(wsB, MICRO_BUDAPEST_EMAIL);
    const r = await harvestList(wsB, other.id, deps(f));
    // B harvests its own pool and finds nothing cached: A's datasheets are A's.
    expect(r.stats.cached).toBe(0);
    expect(r.stats.metered).toBe(6);
    expect(await getWorkspaceClient(wsB).finderResult.count({ where: { listId: list.id } })).toBe(0);
    expect(await getWorkspaceClient(wsB).finderList.findUnique({ where: { id: list.id } })).toBeNull();
  });
});

describe("cached-only mode", () => {
  it("filters the datasheets already in the cache and spends zero lookups", async () => {
    const f = fixtureApi();
    // Build up the cache with an ordinary run first.
    const seed = await newList(wsA, { keywords: ["Társaság"] });
    await harvestList(wsA, seed.id, deps(f));
    const seedRun = await createFinderRun(getWorkspaceClient(wsA), wsA, { listId: seed.id, maxLookups: 10, estimate: await estimateEnrichment(wsA, seed.id, 10, NOW), userId: null });
    await drive(wsA, seedRun.id, deps(f));
    const detailBefore = f.detailCalls.length;
    const searchBefore = f.searchCalls.length;
    const ledgerBefore = await getWorkspaceClient(wsA).registryQuotaLedger.count();

    const list = await newList(wsA, { sizeBands: ["MICRO"], counties: ["Budapest"], contactRequirement: "email" }, true);
    const r = await harvestList(wsA, list.id, deps(f));
    expect(r.stats.metered).toBe(0);
    expect(r.message).toMatch(/no quota spent/);
    expect(await matches(wsA, list.id)).toEqual(["99999998241"]);
    expect(f.detailCalls.length).toBe(detailBefore);
    expect(f.searchCalls.length).toBe(searchBefore);
    expect(await getWorkspaceClient(wsA).registryQuotaLedger.count()).toBe(ledgerBefore);
  });

  it("matches keywords against cached names and includes expired sheets", async () => {
    const f = fixtureApi();
    const seed = await newList(wsA, { keywords: ["Társaság"] });
    await harvestList(wsA, seed.id, deps(f));
    const seedRun = await createFinderRun(getWorkspaceClient(wsA), wsA, { listId: seed.id, maxLookups: 10, estimate: await estimateEnrichment(wsA, seed.id, 10, NOW), userId: null });
    await drive(wsA, seedRun.id, deps(f));
    await getWorkspaceClient(wsA).registrySheet.updateMany({ data: { expiresAt: new Date(NOW.getTime() - 86_400_000) } });

    const list = await newList(wsA, { keywords: ["tükörfúró"] }, true);
    await harvestList(wsA, list.id, deps(f));
    expect(await matches(wsA, list.id)).toEqual(["99999998241"]);
    expect(await getWorkspaceClient(wsA).finderResult.count({ where: { listId: list.id } })).toBe(1);
  });
});

describe("contact enrichment from imprint pages", () => {
  it("fills missing contacts with their source and rescues contact-only refusals, spending nothing", async () => {
    const f = fixtureApi();
    const list = await newList(wsA, { keywords: ["Társaság"], counties: ["Budapest"], contactRequirement: "phone" });
    await harvestList(wsA, list.id, deps(f));
    const run = await createFinderRun(getWorkspaceClient(wsA), wsA, { listId: list.id, maxLookups: 10, estimate: await estimateEnrichment(wsA, list.id, 10, NOW), userId: null });
    await drive(wsA, run.id, deps(f));
    // Only the synthetic dental clinic has a registry phone.
    expect(await matches(wsA, list.id)).toEqual(["99999999242"]);
    const ledger = await getWorkspaceClient(wsA).registryQuotaLedger.count();
    const detail = f.detailCalls.length;

    const read: string[] = [];
    const r = await enrichListContacts(wsA, list.id, {
      now: () => NOW,
      readSite: async (url) => {
        read.push(url);
        return url.includes("arviztuero")
          ? { emails: ["info@arviztuero.example", "valaki@gmail.com"], phones: ["+36 1 222 3333"] }
          : null;
      },
    });
    // The registry email's domain located the site of the company that had no website listed.
    expect(read).toEqual(["https://arviztuero.example"]);
    expect(r.rescued).toBe(1);
    expect(await matches(wsA, list.id)).toEqual(["99999998241", "99999999242"]);
    const rescued = await getWorkspaceClient(wsA).finderResult.findFirst({ where: { listId: list.id, taxNumber: "99999998241" } });
    expect(rescued!.contacts).toEqual({
      email: { value: "iroda@arviztuero.example", source: "registry" },
      phone: { value: "+36 1 222 3333", source: "impresszum" },
      website: { value: "https://arviztuero.example", source: "impresszum" },
    });
    expect(await getWorkspaceClient(wsA).registryQuotaLedger.count()).toBe(ledger);
    expect(f.detailCalls.length).toBe(detail);

    // A second pass has nothing left to read.
    const again = await enrichListContacts(wsA, list.id, { now: () => NOW, readSite: async () => { throw new Error("must not read"); } });
    expect(again).toMatchObject({ checked: 0, remaining: 0 });
  });
});

async function matchedList(ws: string, criteria: FinderCriteriaInput) {
  const f = fixtureApi();
  const list = await newList(ws, criteria);
  await harvestList(ws, list.id, deps(f));
  const run = await createFinderRun(getWorkspaceClient(ws), ws, { listId: list.id, maxLookups: 20, estimate: await estimateEnrichment(ws, list.id, 20, NOW), userId: null });
  await drive(ws, run.id, deps(f));
  return list;
}

describe("results", () => {
  it("builds full rows from the cache, with each contact's source", async () => {
    const list = await matchedList(wsA, { keywords: ["Társaság"], counties: ["Budapest"] });
    const rows = await loadFinderRows(getWorkspaceClient(wsA), list.id);
    expect(rows.map((r) => r.taxNumber).sort()).toEqual(["10906110-2-42", "14945083-2-41", "32305964-2-43", "99999998-2-41", "99999999-2-42"]);
    const welldata = rows.find((r) => r.taxNumber === "32305964-2-43")!;
    expect(welldata).toMatchObject({
      legalForm: "Kft.",
      street: "Derkovits Gyula utca 53.",
      employeeCount: 3,
      employeeCountDate: "2026-09-08",
      reportDate: "2025-12-31",
      sizeBand: "MICRO",
      email: null,
    });
    expect(welldata.bankAccounts).toBeUndefined();
    const minta = rows.find((r) => r.taxNumber === "99999999-2-42")!;
    expect(minta).toMatchObject({ emailSource: "registry", phoneSource: "registry", websiteSource: "registry", website: "https://www.mintafogaszat.example" });
  });

  it("adds matches as leads with source COMPANY_FINDER, once", async () => {
    const list = await matchedList(wsA, MICRO_BUDAPEST_EMAIL);
    const db = getWorkspaceClient(wsA);
    const ids = (await db.finderResult.findMany({ where: { listId: list.id, state: "MATCH" } })).map((r) => r.id);
    const first = await addResultsAsLeads(db, wsA, list.id, ids);
    expect(first.created).toBe(1);
    const lead = await db.lead.findUnique({ where: { id: first.leadIds[0]! }, include: { company: true } });
    expect(lead).toMatchObject({ source: "COMPANY_FINDER", email: "iroda@arviztuero.example", contactName: "Teszt Személy 93" });
    expect(lead!.company).toMatchObject({ taxId: "99999998241", source: "company_finder" });
    const again = await addResultsAsLeads(db, wsA, list.id, ids);
    expect(again).toMatchObject({ created: 0, skipped: [{ reason: "already in the CRM" }] });
  });

  it("sends matches to an outbound product's pool and suppresses by tax number", async () => {
    const list = await matchedList(wsA, { keywords: ["Társaság"], counties: ["Budapest"] });
    const db = getWorkspaceClient(wsA);
    await ensureSegments(db, wsA);
    const product = await db.product.create({ data: { workspaceId: wsA, name: "Web", slug: "web", problemSolved: "Slow sites." } });
    const profile = await db.icpProfile.create({ data: { workspaceId: wsA, productId: product.id, name: "Budapest", segmentKeys: ["private_clinics"], dailyQuota: 5 } });
    const ids = (await db.finderResult.findMany({ where: { listId: list.id, state: "MATCH" } })).map((r) => r.id);

    const sent = await sendResultsToOutbound(db, wsA, list.id, ids, profile.id, NOW);
    expect(sent).toMatchObject({ ok: true, created: 0, updated: 5, segmentKey: "private_clinics" });
    const pool = await db.candidatePool.findMany({ where: { taxNumber: "99999998241" } });
    expect(pool[0]!.segmentKeys).toEqual(expect.arrayContaining(["kw:tarsasag", "private_clinics"]));

    const one = ids.slice(0, 1);
    expect(await suppressResults(db, wsA, list.id, one)).toEqual({ added: 1 });
    expect(await db.suppression.count()).toBe(1);
    expect(await db.finderResult.count({ where: { listId: list.id, state: "MATCH" } })).toBe(4);
  });
});
