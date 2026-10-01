import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { getDatasheet, searchRegistry, quotaMeter } from "../../src/modules/registry/registry-service";
import { MockCegadatProvider } from "../../src/modules/registry/cegadat-mock";
import { RegistryQuotaError, type CompanyRegistryApi } from "../../src/modules/registry/cegadat";
import { quotaMonth } from "../../src/modules/registry/quota";

/**
 * The registry quota against the real database (playbook-v6 F2, CLAUDE.md
 * hard rule 12). The provider is a counting mock so "did it spend a unit" is
 * a number, not an inference.
 */
const NAMES = ["Registry Quota A", "Registry Quota B"];
let wsA = "";
let wsB = "";
// 22 Oct → ten days left in the month including today.
const NOW = new Date("2026-10-22T10:00:00Z");
const TAX = "11111111-2-41"; // a mock company

class CountingApi implements CompanyRegistryApi {
  readonly name = "mock";
  details = 0;
  searches = 0;
  inner = new MockCegadatProvider();
  async search(p: Parameters<CompanyRegistryApi["search"]>[0]) {
    this.searches++;
    return this.inner.search(p);
  }
  async detail(t: string) {
    this.details++;
    return this.inner.detail(t);
  }
}

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({ where: { name: { in: NAMES } }, select: { id: true } });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of ["registryQuotaLedger", "registrySheet", "registrySearchCache"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await clean();
  // Limit 1000, no reserve: today's batch allocation is exactly 100.
  const cfg = { registry: { monthlyLimit: 1000, reservePct: 0 } };
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0], outboundConfig: cfg } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1], outboundConfig: cfg } })).id;
});
afterAll(clean);
beforeEach(async () => {
  for (const t of ["registryQuotaLedger", "registrySheet", "registrySearchCache"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  }
});

async function spend(ws: string, n: number, purpose: "NIGHTLY_RUN" | "INTERACTIVE", at = NOW) {
  await prismaUnsafe.registryQuotaLedger.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      workspaceId: ws,
      month: quotaMonth(at),
      taxNumber: String(10000000000 + i),
      purpose,
      cacheHit: false,
      outcome: "ok",
      at,
    })),
  });
}

describe("detail lookups", () => {
  it("spends one unit, then serves the cache for free and ledgers the hit", async () => {
    const api = new CountingApi();
    const first = await getDatasheet(wsA, TAX, { purpose: "NIGHTLY_RUN", api, now: NOW });
    expect(first).toMatchObject({ status: "ok", fromCache: false });
    const second = await getDatasheet(wsA, TAX, { purpose: "NIGHTLY_RUN", api, now: NOW });
    expect(second).toMatchObject({ status: "ok", fromCache: true });
    expect(api.details).toBe(1);

    const rows = await getWorkspaceClient(wsA).registryQuotaLedger.findMany({ orderBy: { id: "asc" } });
    expect(rows.map((r) => r.cacheHit).sort()).toEqual([false, true]);
    const meter = await quotaMeter(wsA, NOW);
    expect(meter.usedMonth).toBe(1);
    expect(meter.cacheHitsMonth).toBe(1);
  });

  it("caches a not-found answer so a dead tax number is paid for once", async () => {
    const api = new CountingApi();
    expect((await getDatasheet(wsA, "99999998-2-41", { purpose: "INTERACTIVE", api, now: NOW })).status).toBe("not_found");
    expect((await getDatasheet(wsA, "99999998-2-41", { purpose: "INTERACTIVE", api, now: NOW })).status).toBe("not_found");
    expect(api.details).toBe(1);
  });

  it("blocks the 101st batch call when the allocation is 100 — as a result, not a throw", async () => {
    await spend(wsA, 100, "NIGHTLY_RUN");
    const api = new CountingApi();
    const res = await getDatasheet(wsA, TAX, { purpose: "NIGHTLY_RUN", api, now: NOW });
    expect(res).toEqual({ status: "quota_exhausted", scope: "daily" });
    expect(api.details).toBe(0);
  });

  it("protects interactive lookups with the reserve once batch has spent its share", async () => {
    await prismaUnsafe.workspace.update({
      where: { id: wsB },
      data: { outboundConfig: { registry: { monthlyLimit: 1000, reservePct: 15 } } },
    });
    // Batch has used its whole 850 this month, earlier in the month.
    await spend(wsB, 850, "NIGHTLY_RUN", new Date("2026-10-05T10:00:00Z"));
    const api = new CountingApi();
    expect(await getDatasheet(wsB, TAX, { purpose: "NIGHTLY_RUN", api, now: NOW })).toEqual({ status: "quota_exhausted", scope: "daily" });
    expect((await getDatasheet(wsB, TAX, { purpose: "INTERACTIVE", api, now: NOW })).status).toBe("ok");
    expect(api.details).toBe(1);
  });

  it("spends exactly one unit on a manual refresh, cache or not", async () => {
    const api = new CountingApi();
    await getDatasheet(wsA, TAX, { purpose: "INTERACTIVE", api, now: NOW });
    const before = (await quotaMeter(wsA, NOW)).usedMonth;
    const res = await getDatasheet(wsA, TAX, { purpose: "MANUAL_REFRESH", api, now: NOW, forceRefresh: true });
    expect(res).toMatchObject({ status: "ok", fromCache: false });
    expect((await quotaMeter(wsA, NOW)).usedMonth).toBe(before + 1);
    expect(api.details).toBe(2);
  });

  it("pauses on the provider's own limit answer and does not charge it", async () => {
    const api: CompanyRegistryApi = {
      name: "mock",
      search: async () => ({ hits: [], page: 1, totalPages: 1, totalResults: 0 }),
      detail: async () => {
        throw new RegistryQuotaError();
      },
    };
    expect(await getDatasheet(wsA, TAX, { purpose: "NIGHTLY_RUN", api, now: NOW })).toEqual({ status: "quota_exhausted", scope: "provider" });
    expect((await quotaMeter(wsA, NOW)).usedMonth).toBe(0);
  });

  it("keeps one workspace's cache and ledger out of another's", async () => {
    const api = new CountingApi();
    await getDatasheet(wsA, TAX, { purpose: "INTERACTIVE", api, now: NOW });
    expect(await getWorkspaceClient(wsB).registrySheet.count()).toBe(0);
    const res = await getDatasheet(wsB, TAX, { purpose: "INTERACTIVE", api, now: NOW });
    expect(res).toMatchObject({ fromCache: false });
  });
});

describe("search", () => {
  it("is free and cached for a week", async () => {
    const api = new CountingApi();
    const a = await searchRegistry(wsA, { name: "Fogászati", sensitivity: 1 }, { api, now: NOW });
    const b = await searchRegistry(wsA, { name: "fogászati", sensitivity: 1 }, { api, now: NOW });
    expect(a.ok && a.page.hits.length).toBe(1);
    expect(b).toMatchObject({ ok: true, fromCache: true });
    expect(api.searches).toBe(1);
    expect((await quotaMeter(wsA, NOW)).usedMonth).toBe(0);
  });
});
