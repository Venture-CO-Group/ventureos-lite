/**
 * Building result rows on the server: the result row (state, contacts and
 * their sources) joined with the cached datasheet by tax number. The sheet is
 * read from the cache whatever its age — a list's results must not vanish
 * because a sheet passed its 90-day refresh date — and the fetch date travels
 * with the row so a reader can judge it.
 */
import type { FinderResultState } from "@prisma/client";
import type { WorkspaceClient } from "@/lib/db";
import { formatTaxNumber } from "@/modules/registry/cegadat";
import { activityCodes, reviveDatasheet, type CompanyDatasheet } from "@/modules/registry/datasheet";
import { resolveSizeBand } from "@/modules/outbound/size-band";
import { stringArray } from "@/modules/outbound/catalog";
import { parseContacts } from "./evaluate";
import type { FinderRow } from "./row";
import { keywordSegmentKey } from "./engine";
import { nameHasKeyword, parseCriteria } from "./criteria";

const num = (v: bigint | null | undefined) => (v === null || v === undefined ? null : Number(v));
const activity = (a: { code: string; label: string | null } | null) => (a ? [a.code, a.label].filter(Boolean).join(" ") : null);

export function rowFromSheet(
  id: string,
  taxNumber: string,
  fallbackName: string,
  sheet: CompanyDatasheet | null,
  extra: { contacts: unknown; inCrm: boolean; fetchedAt: Date | null; foundByKeyword: boolean; withBank: boolean },
): FinderRow {
  const c = parseContacts(extra.contacts);
  const size = sheet ? resolveSizeBand({ employeeCount: sheet.employeeCount, netRevenue: sheet.netRevenue }) : { band: null };
  return {
    id,
    taxNumber: formatTaxNumber(taxNumber),
    legalName: sheet?.legalName || fallbackName,
    shortName: sheet?.shortName ?? null,
    legalForm: sheet?.legalForm ?? null,
    registryNumber: sheet?.registryNumber ?? null,
    statisticalCode: sheet?.statisticalCode ?? null,
    county: sheet?.seat.county ?? null,
    zip: sheet?.seat.zip ?? null,
    city: sheet?.seat.city ?? null,
    street: sheet?.seat.street ?? null,
    fullAddress: sheet?.seat.oneLine ?? null,
    foundedAt: sheet?.foundedAt ?? null,
    status: sheet?.status ?? null,
    principalActivity: activity(sheet?.principalActivity ?? null),
    principalCode: sheet?.principalActivity?.code || null,
    activities: (sheet?.activities ?? []).map((a) => activity(a)!).filter(Boolean),
    activityCodes: sheet ? activityCodes(sheet) : [],
    netRevenue: num(sheet?.netRevenue),
    equity: num(sheet?.equity),
    operatingProfit: num(sheet?.operatingResult),
    preTaxProfit: num(sheet?.preTaxResult),
    totalAssets: num(sheet?.balanceSheetTotal),
    reportDate: sheet?.reportDate ?? (sheet?.financialYear ? `${sheet.financialYear}-12-31` : null),
    employeeCount: sheet?.employeeCount ?? null,
    employeeCountDate: sheet?.employeeCountDate ?? null,
    owners: (sheet?.owners ?? []).map((p) => p.name),
    managers: (sheet?.managers ?? []).map((p) => p.name),
    email: c.email?.value ?? null,
    phone: c.phone?.value ?? null,
    website: c.website?.value ?? null,
    emailSource: c.email?.source ?? null,
    phoneSource: c.phone?.source ?? null,
    websiteSource: c.website?.source ?? null,
    fetchedAt: extra.fetchedAt?.toISOString() ?? null,
    inCrm: extra.inCrm,
    sizeBand: size.band,
    foundByKeyword: extra.foundByKeyword,
    ...(extra.withBank ? { bankAccounts: sheet?.bankAccounts ?? [] } : {}),
  };
}

export async function loadFinderRows(
  db: WorkspaceClient,
  listId: string,
  opts: { states?: FinderResultState[]; ids?: string[]; withBank?: boolean; limit?: number } = {},
): Promise<FinderRow[]> {
  const list = await db.finderList.findUnique({ where: { id: listId }, select: { criteria: true } });
  if (!list) return [];
  const criteria = parseCriteria(list.criteria);
  const kwKeys = new Set(criteria.keywords.map(keywordSegmentKey));
  const results = await db.finderResult.findMany({
    where: { listId, state: { in: opts.states ?? ["MATCH"] }, ...(opts.ids ? { id: { in: opts.ids } } : {}) },
    orderBy: [{ priority: "desc" }, { name: "asc" }],
    take: opts.limit ?? 20_000,
  });
  const sheets = new Map<string, { sheet: CompanyDatasheet | null; fetchedAt: Date }>();
  const pools = new Map<string, string[]>();
  for (let i = 0; i < results.length; i += 1000) {
    const chunk = results.slice(i, i + 1000);
    const [rows, poolRows] = await Promise.all([
      db.registrySheet.findMany({ where: { taxNumber: { in: chunk.map((r) => r.taxNumber) } } }),
      db.candidatePool.findMany({
        where: { id: { in: chunk.map((r) => r.poolId).filter((x): x is string => !!x) } },
        select: { id: true, segmentKeys: true },
      }),
    ]);
    for (const s of rows) sheets.set(s.taxNumber, { sheet: s.notFound ? null : reviveDatasheet(s.sheet), fetchedAt: s.fetchedAt });
    for (const p of poolRows) pools.set(p.id, stringArray(p.segmentKeys));
  }
  return results.map((r) => {
    const s = sheets.get(r.taxNumber);
    const byPool = r.poolId ? (pools.get(r.poolId) ?? []).some((k) => kwKeys.has(k)) : false;
    const byName = s?.sheet ? nameHasKeyword(`${s.sheet.legalName} ${s.sheet.shortName ?? ""}`, criteria.keywords) : false;
    return rowFromSheet(r.id, r.taxNumber, r.name, s?.sheet ?? null, {
      contacts: r.contacts,
      inCrm: r.inCrm,
      fetchedAt: s?.fetchedAt ?? null,
      foundByKeyword: byPool || byName,
      withBank: !!opts.withBank,
    });
  });
}
