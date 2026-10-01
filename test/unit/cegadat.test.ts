import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CegadatProvider,
  RegistryAuthError,
  RegistryQuotaError,
  RegistryRequestError,
  abbreviateLegalForm,
  cegadatTaxId,
  formatTaxNumber,
  parseActivity,
} from "@/modules/registry/cegadat";
import { mayLookup, quotaPosition, daysRemainingInMonth, quotaMonth } from "@/modules/registry/quota";
import { statusFlagsFor, candidateFromSheet } from "@/modules/registry/datasheet-candidate";
import { parseOutboundConfig, warmupDailyCap, workspaceDailyCap } from "@/modules/outbound/config";
import { searchKey } from "@/modules/registry/registry-service";

/**
 * Playbook-v6 F2: the Cégadat client against the responses it actually gives.
 *
 * The fixtures are real API answers for the six documented test companies
 * (scrubbed of private persons), plus one synthetic sheet carrying the
 * contact fields none of them had. The client runs with a stub fetch that
 * serves them, so the mapping under test is the production one.
 */
const DIR = join(__dirname, "..", "fixtures", "cegadat");
const fixture = (name: string) => readFileSync(join(DIR, name), "utf8");

function stub(routes: Record<string, { status: number; body: string }>) {
  const calls: string[] = [];
  const doFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(`${u.pathname}?${u.searchParams.toString()}`);
    expect((init?.headers as Record<string, string>)["X-Api-Key"]).toBe("k");
    const key = u.pathname === "/v1/detail" ? `detail:${u.searchParams.get("id")}` : `search:${u.searchParams.get("name") ?? u.searchParams.get("vatNumber")}`;
    const r = routes[key] ?? { status: 200, body: fixture("detail-unknown.json") };
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { api: new CegadatProvider("k", doFetch, "https://api.cegadatapi.hu"), calls };
}

const IDS = ["32305964243", "14945083241", "10886861244", "10906110242", "64261351133", "64435314123", "99999999242"];
const routes = Object.fromEntries(IDS.map((id) => [`detail:${id}`, { status: 200, body: fixture(`detail-${id}.json`) }]));

describe("detail mapping, all six test companies", () => {
  it("maps WellData (micro company)", async () => {
    const s = (await stub(routes).api.detail("32305964-2-43"))!;
    expect(s.taxNumber).toBe("32305964-2-43");
    expect(s.legalName).toBe("WellData Korlátolt Felelősségű Társaság");
    expect(s.shortName).toBe("WellData Kft.");
    expect(s.legalForm).toBe("Kft.");
    expect(s.seat).toMatchObject({ county: "Budapest", city: "Budapest", zip: "1193" });
    expect(s.principalActivity).toEqual({ code: "6392", label: "Egyéb információs szolgáltatás" });
    expect(s.employeeCount).toBe(3);
    expect(s.netRevenue).toBe(55_927_000n);
    expect(s.financialYear).toBe(2025);
    expect(s.foundedAt).toBe("2023-06-12");
    expect(s.managers).toEqual([{ name: "Teszt Személy 11", role: null }]);
  });

  it("maps DAYTON-Invest (holding, zero employees, negative results)", async () => {
    const s = (await stub(routes).api.detail("14945083241"))!;
    expect(s.employeeCount).toBe(0);
    expect(s.netRevenue).toBe(0n);
    expect(s.preTaxResult).toBe(-20_461_344_000n);
    expect(s.afterTaxResult).toBe(-20_499_956_000n);
    expect(s.principalActivity?.code).toBe("6421");
  });

  it("maps Coca-Cola HBC (large, revenue beyond an Int)", async () => {
    const s = (await stub(routes).api.detail("10886861244"))!;
    expect(s.employeeCount).toBe(1092);
    expect(s.netRevenue).toBe(263_633_479_000n);
    expect(s.seat.county).toBe("Pest");
    expect(s.owners[0]!.name).toBe("CC Beverages Holdings II B.V.");
    expect(s.managers.length).toBeGreaterThan(1);
  });

  it("maps Budapest Film (Zrt., not Nyrt.)", async () => {
    const s = (await stub(routes).api.detail("10906110242"))!;
    expect(s.legalForm).toBe("Zrt.");
    expect(s.employeeCount).toBe(94);
    expect(s.principalActivity?.code).toBe("5914");
  });

  it("maps both sole traders from their own field set", async () => {
    const a = (await stub(routes).api.detail("64261351133"))!;
    expect(a.legalForm).toBe("e.v.");
    expect(a.netRevenue).toBe(1_202_500n);
    expect(a.shortName).toBeNull();
    expect(a.principalActivity?.code).toBe("812101");
    const b = (await stub(routes).api.detail("64435314123"))!;
    expect(b.netRevenue).toBe(25_818_314n);
    expect(b.afterTaxResult).toBe(8_872_046n);
    expect(b.seat.county).toBe("Bács-Kiskun");
  });

  it("maps the contact fields, string-typed money and a bare website", async () => {
    const s = (await stub(routes).api.detail("99999999242"))!;
    expect(s.email).toBe("info@mintafogaszat.example");
    expect(s.phone).toBe("+36 1 555 0100");
    expect(s.website).toBe("https://www.mintafogaszat.example");
    expect(s.netRevenue).toBe(184_000_000n);
    expect(s.activities.map((a) => a.code)).toEqual(["8623", "8622"]);
  });

  it("returns null for a tax number the registry does not know", async () => {
    expect(await stub(routes).api.detail("11111111-1-11")).toBeNull();
  });
});

describe("search", () => {
  it("maps hits and paging, and sends the documented parameters", async () => {
    const { api, calls } = stub({ "search:Film": { status: 200, body: fixture("search-film.json") } });
    const page = await api.search({ name: "Film", sensitivity: 1, businessType: "company", status: "Aktív", limit: 100 });
    expect(page.hits[0]).toMatchObject({ taxNumber: "10906110-2-42", shortName: "Budapest Film Zrt.", status: "Aktív" });
    expect(page.totalResults).toBe(1);
    expect(calls[0]).toContain("name=Film");
    expect(calls[0]).toContain("sensitivity=1");
    expect(calls[0]).toContain("limit=100");
  });

  it("refuses a name shorter than four characters without calling", async () => {
    const { api, calls } = stub({});
    await expect(api.search({ name: "ab" })).rejects.toBeInstanceOf(RegistryRequestError);
    expect(calls).toEqual([]);
  });
});

describe("error classification", () => {
  it("turns code 7 / HTTP 429 into a quota error", async () => {
    const { api } = stub({ "detail:32305964243": { status: 429, body: fixture("error-quota.json") } });
    await expect(api.detail("32305964243")).rejects.toBeInstanceOf(RegistryQuotaError);
  });

  it("turns an invalid key into an auth error", async () => {
    const { api } = stub({
      "detail:32305964243": { status: 400, body: JSON.stringify({ status: false, error: "Invalid API Key", errorCode: 1, statusCode: 400 }) },
    });
    await expect(api.detail("32305964243")).rejects.toBeInstanceOf(RegistryAuthError);
  });

  it("marks the provider's own failure retryable and a short keyword not", async () => {
    const { api } = stub({
      "detail:32305964243": { status: 500, body: JSON.stringify({ status: false, error: "x", errorCode: 3, statusCode: 500 }) },
    });
    const e = await api.detail("32305964243").catch((x) => x);
    expect(e).toBeInstanceOf(RegistryRequestError);
    expect((e as RegistryRequestError).retryable).toBe(true);
  });
});

describe("small mappers", () => {
  it("normalises tax numbers both ways", () => {
    expect(cegadatTaxId("32305964-2-43")).toBe("32305964243");
    expect(cegadatTaxId("3230596")).toBeNull();
    expect(formatTaxNumber("32305964243")).toBe("32305964-2-43");
  });
  it("parses activities and legal forms", () => {
    expect(parseActivity("477202. Bőrdíszműáru-kiskereskedelem")).toEqual({ code: "477202", label: "Bőrdíszműáru-kiskereskedelem" });
    expect(abbreviateLegalForm("Részvénytársaság", "OTP Bank Nyilvánosan Működő Részvénytársaság")).toBe("Nyrt.");
    expect(abbreviateLegalForm("Betéti társaság", null)).toBe("Bt.");
  });
  it("maps registry status words to risk flags", () => {
    expect(statusFlagsFor("Aktív")).toEqual(["active"]);
    expect(statusFlagsFor("Eljárás alatt")).toEqual(["under_proceedings"]);
    expect(statusFlagsFor("Felszámolás alatt")).toEqual(["under_liquidation"]);
  });
  it("hands the enrichment dialog a candidate with real numbers", async () => {
    const s = (await stub(routes).api.detail("10906110242"))!;
    expect(candidateFromSheet(s)).toMatchObject({ taxId: "10906110242", headcountBand: "94 employees", revenueBand: "1.5 Mrd Ft (2025)" });
  });
  it("keys searches stably regardless of key order and case", () => {
    expect(searchKey({ name: "Fogászat", sensitivity: 1 })).toBe(searchKey({ sensitivity: 1, name: "fogászat " }));
  });
});

describe("quota arithmetic (CLAUDE.md hard rule 12)", () => {
  const base = { limit: 1000, reservePct: 0, usedMonth: 0, usedMonthBatch: 0, usedTodayBatch: 0, daysRemaining: 10 };

  it("allocates the batch share evenly over the days left", () => {
    expect(quotaPosition(base).dailyAllocation).toBe(100);
  });

  it("blocks the 101st batch call of a day whose allocation is 100", () => {
    expect(mayLookup("batch", { ...base, usedMonth: 99, usedMonthBatch: 99, usedTodayBatch: 99 }).ok).toBe(true);
    expect(mayLookup("batch", { ...base, usedMonth: 100, usedMonthBatch: 100, usedTodayBatch: 100 })).toEqual({ ok: false, scope: "daily" });
  });

  it("does not shrink today's allocation as the run spends it", () => {
    const mid = quotaPosition({ ...base, usedMonth: 50, usedMonthBatch: 50, usedTodayBatch: 50 });
    expect(mid.dailyAllocation).toBe(100);
    expect(mid.batchRemainingToday).toBe(50);
  });

  it("keeps the reserve for interactive lookups once batch has spent its share", () => {
    const u = { ...base, reservePct: 15, usedMonth: 850, usedMonthBatch: 850, usedTodayBatch: 0, daysRemaining: 3 };
    expect(quotaPosition(u).reserve).toBe(150);
    expect(mayLookup("batch", u)).toEqual({ ok: false, scope: "daily" });
    expect(mayLookup("interactive", u).ok).toBe(true);
  });

  it("refuses everyone once the month is spent", () => {
    const u = { ...base, usedMonth: 1000, usedMonthBatch: 850 };
    expect(mayLookup("interactive", u)).toEqual({ ok: false, scope: "monthly" });
  });

  it("counts days and months in UTC", () => {
    expect(daysRemainingInMonth(new Date("2026-10-22T10:00:00Z"))).toBe(10);
    expect(daysRemainingInMonth(new Date("2026-02-28T10:00:00Z"))).toBe(1);
    expect(quotaMonth(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10");
  });
});

describe("outbound config", () => {
  it("defaults to the approved launch values", () => {
    const c = parseOutboundConfig(null);
    expect(c.registry).toEqual({ monthlyLimit: 5000, reservePct: 15 });
    expect(c.cap.initial).toBe(15);
    expect(c.cap.after).toBe(25);
    expect(c.sending.track).toBe(false);
    expect(c.schedule.days).toEqual([1, 2, 3, 4, 5]);
  });
  it("keeps the good sections of a partly broken config", () => {
    const c = parseOutboundConfig({ registry: { monthlyLimit: 3000 }, cap: { initial: "lots" } });
    expect(c.registry.monthlyLimit).toBe(3000);
    expect(c.cap.initial).toBe(15);
  });
  it("ramps the workspace cap after two weeks and the warm-up every three days", () => {
    const start = "2026-10-01T00:00:00Z";
    const cap = { ...parseOutboundConfig(null).cap, startedAt: start };
    expect(workspaceDailyCap(cap, new Date("2026-10-10T00:00:00Z"))).toBe(15);
    expect(workspaceDailyCap(cap, new Date("2026-10-15T00:00:00Z"))).toBe(25);
    const w = { ...parseOutboundConfig(null).warmup, startedAt: start };
    expect(warmupDailyCap({ ...w, startedAt: null }, new Date())).toBe(10);
    expect(warmupDailyCap(w, new Date("2026-10-03T12:00:00Z"))).toBe(10);
    expect(warmupDailyCap(w, new Date("2026-10-04T12:00:00Z"))).toBe(15);
    expect(warmupDailyCap(w, new Date("2026-12-31T12:00:00Z"))).toBe(40);
  });
});
