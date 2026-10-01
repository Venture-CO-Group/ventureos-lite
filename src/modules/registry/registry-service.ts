/**
 * The ONE way to read a datasheet (CLAUDE.md hard rule 12, spec §4.43.4).
 *
 * Every consumer — the nightly run, a manual run, the company screen, the
 * reference seeding — goes through `getDatasheet`, which in order:
 *
 *   1. serves the 90-day cache, and ledgers the hit as free;
 *   2. checks the quota for the caller's kind (batch or interactive);
 *   3. only then spends a unit, and ledgers it with its purpose;
 *   4. turns the provider's own limit answer into `quota_exhausted`, so the
 *      caller pauses instead of failing.
 *
 * A caller that bypasses this to call the provider directly is spending quota
 * nobody can see. There is no other exported path to `detail()` in the app.
 *
 * Not a server action: a library for actions and jobs alike.
 */
import { createHash } from "node:crypto";
import type { RegistryLookupPurpose } from "@prisma/client";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { resolveIntegration } from "@/modules/integrations/resolve";
import { parseOutboundConfig } from "@/modules/outbound/config";
import type { CompanyDatasheet } from "./datasheet";
import { reviveDatasheet, serializeDatasheet } from "./datasheet";
import {
  CegadatProvider,
  RegistryAuthError,
  RegistryQuotaError,
  RegistryRequestError,
  cegadatTaxId,
  type CompanyRegistryApi,
  type RegistrySearchPage,
  type RegistrySearchParams,
} from "./cegadat";
import { MockCegadatProvider } from "./cegadat-mock";
import {
  daysRemainingInMonth,
  mayLookup,
  quotaMonth,
  quotaPosition,
  startOfUtcDay,
  type QuotaConsumer,
  type QuotaPosition,
  type QuotaUsage,
} from "./quota";

export const SHEET_TTL_MS = 90 * 86_400_000;
export const SEARCH_TTL_MS = 7 * 86_400_000;

const BATCH_PURPOSES: RegistryLookupPurpose[] = ["NIGHTLY_RUN", "MANUAL_RUN"];
/** Outcomes that cost a unit. A refused (`quota`) call never reached the meter. */
const CHARGED_OUTCOMES = ["ok", "not_found", "error"];

export function consumerFor(purpose: RegistryLookupPurpose): QuotaConsumer {
  return BATCH_PURPOSES.includes(purpose) ? "batch" : "interactive";
}

// ---- provider resolution ------------------------------------------------------

/**
 * The workspace's key wins; without one, development falls back to the mock
 * and production has no registry at all — a production install must never
 * quietly answer with invented companies.
 */
export async function resolveRegistryApi(workspaceId: string): Promise<CompanyRegistryApi | null> {
  const key = await resolveIntegration(workspaceId, "cegadat.apiKey");
  if (key) return new CegadatProvider(key);
  const wantMock = (process.env.REGISTRY_PROVIDER ?? "").toLowerCase() === "mock";
  if (process.env.NODE_ENV !== "production" && (wantMock || !process.env.REGISTRY_PROVIDER)) {
    return new MockCegadatProvider();
  }
  return null;
}

// ---- quota ------------------------------------------------------------------

export async function loadQuotaUsage(workspaceId: string, now: Date = new Date()): Promise<QuotaUsage> {
  const db = getWorkspaceClient(workspaceId);
  const month = quotaMonth(now);
  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { outboundConfig: true } });
  const cfg = parseOutboundConfig(ws?.outboundConfig).registry;
  const charged = { month, cacheHit: false, outcome: { in: CHARGED_OUTCOMES } };
  const [usedMonth, usedMonthBatch, usedTodayBatch] = await Promise.all([
    db.registryQuotaLedger.count({ where: charged }),
    db.registryQuotaLedger.count({ where: { ...charged, purpose: { in: BATCH_PURPOSES } } }),
    db.registryQuotaLedger.count({
      where: { ...charged, purpose: { in: BATCH_PURPOSES }, at: { gte: startOfUtcDay(now) } },
    }),
  ]);
  return {
    limit: cfg.monthlyLimit,
    reservePct: cfg.reservePct,
    usedMonth,
    usedMonthBatch,
    usedTodayBatch,
    daysRemaining: daysRemainingInMonth(now),
  };
}

export interface QuotaMeter extends QuotaPosition {
  month: string;
  limit: number;
  usedMonth: number;
  usedTodayBatch: number;
  cacheHitsMonth: number;
  byPurpose: Partial<Record<RegistryLookupPurpose, number>>;
}

export async function quotaMeter(workspaceId: string, now: Date = new Date()): Promise<QuotaMeter> {
  const usage = await loadQuotaUsage(workspaceId, now);
  const db = getWorkspaceClient(workspaceId);
  const month = quotaMonth(now);
  const [hits, grouped] = await Promise.all([
    db.registryQuotaLedger.count({ where: { month, cacheHit: true } }),
    db.registryQuotaLedger.groupBy({
      by: ["purpose"],
      where: { month, cacheHit: false, outcome: { in: CHARGED_OUTCOMES } },
      _count: { _all: true },
    }),
  ]);
  const byPurpose: QuotaMeter["byPurpose"] = {};
  for (const g of grouped) byPurpose[g.purpose] = g._count._all;
  return {
    ...quotaPosition(usage),
    month,
    limit: usage.limit,
    usedMonth: usage.usedMonth,
    usedTodayBatch: usage.usedTodayBatch,
    cacheHitsMonth: hits,
    byPurpose,
  };
}

// ---- datasheets -------------------------------------------------------------

export type DatasheetResult =
  | { status: "ok"; sheet: CompanyDatasheet; fromCache: boolean; fetchedAt: Date }
  | { status: "not_found"; fromCache: boolean }
  /** Pause and resume later — not an error (hard rule 12). */
  | { status: "quota_exhausted"; scope: "daily" | "monthly" | "provider" }
  /** No provider, or the key/subscription is refused. Nothing to retry. */
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string; retryable: boolean };

export interface DatasheetOptions {
  purpose: RegistryLookupPurpose;
  candidateId?: string | null;
  userId?: string | null;
  /** Bypass the cache and spend one unit (the manual "refresh"). */
  forceRefresh?: boolean;
  now?: Date;
  /** Injected for tests; defaults to the workspace's resolved provider. */
  api?: CompanyRegistryApi | null;
}

export async function getDatasheet(
  workspaceId: string,
  rawTaxNumber: string,
  opts: DatasheetOptions,
): Promise<DatasheetResult> {
  const taxNumber = cegadatTaxId(rawTaxNumber);
  if (!taxNumber) return { status: "error", message: "Not an 11-digit tax number.", retryable: false };
  const now = opts.now ?? new Date();
  const db = getWorkspaceClient(workspaceId);
  const month = quotaMonth(now);
  const ledger = (outcome: string, cacheHit: boolean) =>
    db.registryQuotaLedger.create({
      data: {
        workspaceId,
        month,
        taxNumber,
        purpose: opts.purpose,
        candidateId: opts.candidateId ?? null,
        userId: opts.userId ?? null,
        cacheHit,
        outcome,
        at: now,
      },
    });

  // 1. The cache. A hit costs nothing and is recorded as costing nothing.
  if (!opts.forceRefresh) {
    const cached = await db.registrySheet.findUnique({
      where: { workspaceId_taxNumber: { workspaceId, taxNumber } },
    });
    if (cached && cached.expiresAt > now) {
      await ledger(cached.notFound ? "not_found" : "ok", true);
      if (cached.notFound) return { status: "not_found", fromCache: true };
      const sheet = reviveDatasheet(cached.sheet);
      if (sheet) return { status: "ok", sheet, fromCache: true, fetchedAt: cached.fetchedAt };
    }
  }

  const api = opts.api === undefined ? await resolveRegistryApi(workspaceId) : opts.api;
  if (!api) return { status: "unavailable", message: "No company-registry provider is configured." };

  // 2. The quota, before a unit is spent.
  const decision = mayLookup(consumerFor(opts.purpose), await loadQuotaUsage(workspaceId, now));
  if (!decision.ok) return { status: "quota_exhausted", scope: decision.scope };

  // 3. Spend it.
  try {
    const sheet = await api.detail(taxNumber);
    const expiresAt = new Date(now.getTime() + SHEET_TTL_MS);
    const row = {
      provider: api.name,
      sheet: sheet ? (serializeDatasheet(sheet) as object) : {},
      notFound: sheet === null,
      fetchedAt: now,
      expiresAt,
    };
    await db.registrySheet.upsert({
      where: { workspaceId_taxNumber: { workspaceId, taxNumber } },
      create: { workspaceId, taxNumber, ...row },
      update: row,
    });
    await ledger(sheet ? "ok" : "not_found", false);
    return sheet ? { status: "ok", sheet, fromCache: false, fetchedAt: now } : { status: "not_found", fromCache: false };
  } catch (e) {
    if (e instanceof RegistryQuotaError) {
      await ledger("quota", false);
      return { status: "quota_exhausted", scope: "provider" };
    }
    if (e instanceof RegistryAuthError) {
      await ledger("error", false);
      return { status: "unavailable", message: e.message };
    }
    await ledger("error", false);
    const retryable = e instanceof RegistryRequestError ? e.retryable : true;
    return { status: "error", message: (e as Error).message.slice(0, 300), retryable };
  }
}

/** The cached sheet only — never spends quota. For screens that just display. */
export async function cachedDatasheet(
  workspaceId: string,
  rawTaxNumber: string,
): Promise<{ sheet: CompanyDatasheet; fetchedAt: Date } | null> {
  const taxNumber = cegadatTaxId(rawTaxNumber);
  if (!taxNumber) return null;
  const row = await getWorkspaceClient(workspaceId).registrySheet.findUnique({
    where: { workspaceId_taxNumber: { workspaceId, taxNumber } },
  });
  if (!row || row.notFound) return null;
  const sheet = reviveDatasheet(row.sheet);
  return sheet ? { sheet, fetchedAt: row.fetchedAt } : null;
}

// ---- search -----------------------------------------------------------------

export type SearchResult =
  | { ok: true; page: RegistrySearchPage; fromCache: boolean }
  | { ok: false; reason: "unavailable" | "error"; message: string; retryable: boolean };

export function searchKey(p: RegistrySearchParams): string {
  const norm = Object.fromEntries(
    Object.entries(p)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => [k, typeof v === "string" ? v.trim().toLowerCase() : v])
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return createHash("sha1").update(JSON.stringify(norm)).digest("hex");
}

/** Free, but cached 7 days: a harvest repeated tomorrow should not re-ask. */
export async function searchRegistry(
  workspaceId: string,
  params: RegistrySearchParams,
  opts: { now?: Date; api?: CompanyRegistryApi | null; bypassCache?: boolean } = {},
): Promise<SearchResult> {
  const now = opts.now ?? new Date();
  const db = getWorkspaceClient(workspaceId);
  const queryKey = searchKey(params);
  if (!opts.bypassCache) {
    const cached = await db.registrySearchCache.findUnique({
      where: { workspaceId_queryKey: { workspaceId, queryKey } },
    });
    if (cached && cached.expiresAt > now) {
      return { ok: true, page: cached.results as unknown as RegistrySearchPage, fromCache: true };
    }
  }
  const api = opts.api === undefined ? await resolveRegistryApi(workspaceId) : opts.api;
  if (!api) return { ok: false, reason: "unavailable", message: "No company-registry provider is configured.", retryable: false };
  try {
    const page = await api.search(params);
    const row = { results: page as unknown as object, fetchedAt: now, expiresAt: new Date(now.getTime() + SEARCH_TTL_MS) };
    await db.registrySearchCache.upsert({
      where: { workspaceId_queryKey: { workspaceId, queryKey } },
      create: { workspaceId, queryKey, ...row },
      update: row,
    });
    return { ok: true, page, fromCache: false };
  } catch (e) {
    if (e instanceof RegistryAuthError) return { ok: false, reason: "unavailable", message: e.message, retryable: false };
    const retryable = e instanceof RegistryRequestError ? e.retryable : true;
    return { ok: false, reason: "error", message: (e as Error).message.slice(0, 300), retryable };
  }
}
