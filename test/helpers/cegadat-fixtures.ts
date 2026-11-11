import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CegadatProvider } from "../../src/modules/registry/cegadat";

/**
 * The real Cégadat client, served by the captured fixtures instead of the
 * network ("the test API key fixtures"). Detail answers are the fixture files
 * byte for byte; search answers are built from the same files, matching the
 * name the way `sensitivity=1` does (partial, case- and accent-insensitive),
 * honouring businessType, status and paging. Every call is counted, so a test
 * can prove what was — and was not — paid for.
 */
const DIR = join(__dirname, "..", "fixtures", "cegadat");

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

export interface FixtureApi {
  api: CegadatProvider;
  detailCalls: string[];
  searchCalls: string[];
  /** Answer the next N detail calls with the quota error (code 7 / HTTP 429). */
  failQuotaNext: (n: number) => void;
}

export function fixtureCompanies(): Array<Record<string, unknown>> {
  return readdirSync(DIR)
    .filter((f) => /^detail-\d{11}\.json$/.test(f))
    .map((f) => (JSON.parse(readFileSync(join(DIR, f), "utf8")) as { response: { results: Record<string, unknown> } }).response.results);
}

export function fixtureApi(): FixtureApi {
  const detailCalls: string[] = [];
  const searchCalls: string[] = [];
  let quotaFailures = 0;
  const companies = fixtureCompanies();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const doFetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    const q = u.searchParams;
    if (u.pathname === "/v1/detail") {
      const id = q.get("id") ?? "";
      detailCalls.push(id);
      if (quotaFailures > 0) {
        quotaFailures--;
        return new Response(readFileSync(join(DIR, "error-quota.json"), "utf8"), { status: 429 });
      }
      try {
        return new Response(readFileSync(join(DIR, `detail-${id}.json`), "utf8"), { status: 200 });
      } catch {
        return new Response(readFileSync(join(DIR, "detail-unknown.json"), "utf8"), { status: 200 });
      }
    }
    if (u.pathname === "/v1/search") {
      searchCalls.push(q.toString());
      const name = fold(q.get("name") ?? "");
      const bt = q.get("businessType") ?? "company";
      const status = q.get("status");
      const limit = Number(q.get("limit") ?? 50);
      const page = Number(q.get("page") ?? 1);
      const hits = companies.filter((c) => {
        const individual = String(c.legalForm ?? "").toLowerCase().includes("egyéni vállalkozás");
        if (bt === "company" && individual) return false;
        if (bt === "individualEntrepreneur" && !individual) return false;
        if (status && c.status !== status) return false;
        return fold(`${c.fullName ?? ""} ${c.shortName ?? ""}`).includes(name);
      });
      const slice = hits.slice((page - 1) * limit, page * limit);
      return json({
        status: true,
        response: {
          meta: { current: page, total_pages: Math.max(1, Math.ceil(hits.length / limit)), total_results: hits.length, size: limit },
          results: slice.map((c) => ({
            id: c.vatNumber,
            vatNumber: c.vatNumber,
            businessType: "Társas vállalkozás",
            fullName: c.fullName,
            shortName: c.shortName ?? null,
            status: c.status,
          })),
        },
      });
    }
    return json({ status: false, error: "Unknown endpoint", errorCode: 404, statusCode: 404 }, 404);
  }) as typeof fetch;

  return {
    api: new CegadatProvider("test-key", doFetch, "https://api.cegadatapi.hu"),
    detailCalls,
    searchCalls,
    failQuotaNext: (n) => {
      quotaFailures = n;
    },
  };
}
