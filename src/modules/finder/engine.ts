/**
 * The Company Finder's two phases (item 2), built on the outbound motor's
 * sourcing infrastructure rather than beside it:
 *
 *   PHASE 1 — free. Every segment fragment and keyword is harvested through
 *   `harvestSegment` (the motor's own harvester) into the SHARED candidate
 *   pool, deduplicated by tax number there. The list's candidates are then
 *   the pool rows its fragments found. A free pre-filter drops what needs no
 *   datasheet to drop (in the CRM, suppressed, refused before under the same
 *   criteria, a legal form that cannot fit), and every candidate whose
 *   datasheet is already cached is filtered on the spot — also free. What is
 *   left needs a metered lookup, and that number is the estimate.
 *
 *   PHASE 2 — metered. A run with a confirmed maximum spends lookups in
 *   score order (the pool's scorer) through `getDatasheet`, the one metered
 *   path, as a BATCH consumer: it gets the day's allocation, never the
 *   interactive reserve. It stops once after its first batch so the observed
 *   yield can be judged, pauses cleanly on exhaustion, and resumes later
 *   without paying twice — every decided result is written as it is decided,
 *   and a sheet bought just before a crash is a cache hit on the retry.
 *
 * Session-free; actions, the worker and the tests call it with a workspace id.
 */
import type { FinderResultState, Prisma } from "@prisma/client";
import { getWorkspaceClient, type WorkspaceClient } from "@/lib/db";
import { cegadatTaxId, type CompanyRegistryApi } from "@/modules/registry/cegadat";
import { reviveDatasheet } from "@/modules/registry/datasheet";
import { getDatasheet, quotaMeter, searchRegistry } from "@/modules/registry/registry-service";
import { isCompanySuppressed } from "@/modules/mail/suppression";
import { domainOf, legalFormFromName, legalFormImplausible, scorePoolRow } from "@/modules/outbound/pool";
import { harvestSegment, type SourceDeps } from "@/modules/outbound/sources";
import { loadSegments } from "@/modules/outbound/segments";
import { stringArray, type SegmentView } from "@/modules/outbound/catalog";
import { fold, parseCriteria, type FinderCriteria, type FinderReason } from "./criteria";
import { evaluateSheet, type WorkspaceFacts } from "./evaluate";
import type { ListStats } from "./store";

export interface FinderDeps {
  now: () => Date;
  /** Undefined → the workspace's configured provider. */
  registryApi?: CompanyRegistryApi | null;
  sleep: (ms: number) => Promise<void>;
  /** Harvest pages per fragment in phase 1 (100 companies a page). */
  pagesPerFragment?: number;
  /** Lookups per worker pass in phase 2, so a pass stays short. */
  lookupsPerPass?: number;
}

/** The first batch of a run: the yield is shown after it before more is spent. */
export const FIRST_BATCH = 25;
/** A result refused for these criteria is not re-bought for another list with the same criteria for this long. */
const REFILTER_DAYS = 90;
const MAX_ATTEMPTS = 3;
const POOL_SCAN_LIMIT = 50_000;

// ---- shared helpers ----------------------------------------------------------

/** A keyword's harvest "segment": shared by every list that uses the same word. */
export function keywordSegmentKey(keyword: string): string {
  return `kw:${fold(keyword).replace(/\s+/g, " ")}`;
}

function keywordSegment(keyword: string): SegmentView {
  return {
    id: keywordSegmentKey(keyword),
    key: keywordSegmentKey(keyword),
    name: keyword,
    teaorInclude: [],
    teaorExclude: [],
    fragments: [keyword],
    seedList: [],
    sourcingHint: "NAME_HARVEST_STRONG",
    version: 1,
    archived: false,
  };
}

export async function loadWorkspaceFacts(db: WorkspaceClient): Promise<WorkspaceFacts> {
  const [companies, suppressions, leads] = await Promise.all([
    db.company.findMany({ where: { mergedIntoId: null }, select: { taxId: true, domain: true, website: true } }),
    db.suppression.findMany({ select: { address: true } }),
    db.lead.findMany({
      where: { mergedIntoId: null, OR: [{ email: { not: null } }, { phone: { not: null } }] },
      select: { email: true, phone: true, company: { select: { domain: true, website: true } } },
      take: 50_000,
    }),
  ]);
  const crmContacts = new Map<string, { email: string | null; phone: string | null }>();
  for (const l of leads) {
    const domain =
      l.company?.domain?.toLowerCase() ?? domainOf(l.company?.website) ?? (l.email ? (l.email.split("@")[1] ?? "").toLowerCase() : null);
    if (!domain) continue;
    const prev = crmContacts.get(domain);
    crmContacts.set(domain, { email: prev?.email ?? l.email ?? null, phone: prev?.phone ?? l.phone ?? null });
  }
  return {
    crmTax: new Set(companies.map((c) => cegadatTaxId(c.taxId ?? "")).filter((t): t is string => !!t)),
    crmDomains: new Set(
      companies.flatMap((c) => [c.domain, domainOf(c.website)]).filter((d): d is string => !!d).map((d) => d.toLowerCase()),
    ),
    suppressed: suppressions.map((s) => s.address),
    crmContacts,
  };
}

function harvestCalls(criteria: FinderCriteria): Array<{ businessType: "company" | "individualEntrepreneur"; status: FinderCriteria["status"] }> {
  const types: Array<"company" | "individualEntrepreneur"> =
    criteria.businessType === "both" ? ["company", "individualEntrepreneur"] : [criteria.businessType];
  return types.map((businessType) => ({ businessType, status: criteria.status }));
}

/** The segment keys a list's candidates carry in the pool. */
export function listPoolKeys(criteria: FinderCriteria): { segmentKeys: string[]; keywordKeys: string[] } {
  return { segmentKeys: criteria.segmentKeys, keywordKeys: criteria.keywords.map(keywordSegmentKey) };
}

// ---- phase 1 -------------------------------------------------------------------

export interface HarvestOutcome {
  ok: boolean;
  stats: ListStats;
  message: string;
}

/**
 * Phase 1. Spends no quota: searches are free, and cached sheets are read
 * straight from the cache table without touching the ledger.
 */
export async function harvestList(workspaceId: string, listId: string, deps: FinderDeps): Promise<HarvestOutcome> {
  const db = getWorkspaceClient(workspaceId);
  const list = await db.finderList.findUnique({ where: { id: listId } });
  if (!list) return { ok: false, stats: emptyStats(), message: "The list no longer exists." };
  const criteria = parseCriteria(list.criteria);
  const now = deps.now();
  const segments = await loadSegments(db, workspaceId);

  // 1. Harvest, into the shared pool.
  const errors: string[] = [];
  let fragments = 0;
  const sourceDeps: SourceDeps = {
    search: (p) => searchRegistry(workspaceId, p, { api: deps.registryApi, now }),
    sleep: deps.sleep,
    now,
  };
  const toHarvest: SegmentView[] = [
    ...criteria.segmentKeys.map((k) => segments.find((s) => s.key === k)).filter((s): s is SegmentView => !!s),
    ...criteria.keywords.map(keywordSegment),
  ];
  for (const seg of toHarvest) {
    for (const call of harvestCalls(criteria)) {
      const shared = call.businessType === "company" && call.status === "Aktív";
      const report = await harvestSegment(db, workspaceId, seg, sourceDeps, {
        maxPagesPerFragment: deps.pagesPerFragment ?? 10,
        businessType: call.businessType,
        status: call.status === "any" ? null : call.status,
        progressKey: shared ? seg.key : `${seg.key}|${call.businessType}|${call.status}`,
      });
      fragments += report.fragments.length;
      errors.push(...report.errors);
    }
  }

  // 2. The list's candidates: pool rows its fragments found, with a tax number.
  const { segmentKeys, keywordKeys } = listPoolKeys(criteria);
  const wanted = new Set([...segmentKeys, ...keywordKeys]);
  const kwSet = new Set(keywordKeys);
  const poolRows = (
    await db.candidatePool.findMany({
      where: { taxNumber: { not: null } },
      orderBy: { lastSeenAt: "desc" },
      take: POOL_SCAN_LIMIT,
    })
  ).filter((r) => stringArray(r.segmentKeys).some((k) => wanted.has(k)));

  const stats = await reconcileCandidates(db, workspaceId, list.id, list.criteriaHash, criteria, segments, poolRows.map((r) => {
    const keys = stringArray(r.segmentKeys);
    return {
      taxNumber: r.taxNumber!,
      poolId: r.id,
      name: r.name,
      status: r.status,
      domain: r.domain ?? domainOf(r.website),
      foundByKeyword: keys.some((k) => kwSet.has(k)),
      score: scorePoolRow(
        {
          name: r.name,
          source: r.source,
          segmentKeys: keys,
          hits: Array.isArray(r.hits) ? (r.hits as Array<{ segment: string; fragment: string }>) : [],
          lastSeenAt: r.lastSeenAt,
        },
        {
          profileSegments: [...wanted],
          profileFragments: toHarvest.flatMap((s) => s.fragments),
          otherFragments: segments.filter((s) => !wanted.has(s.key)).flatMap((s) => s.fragments),
          sizeBands: criteria.sizeBands,
          fragmentApproval: new Map(),
          now,
        },
      ),
    };
  }), now);
  stats.fragments = fragments;
  stats.errors = errors.slice(0, 20);
  const message =
    stats.candidates === 0
      ? errors.length
        ? `No candidates — the registry search failed: ${errors[0]}`
        : "No candidates — the fragments found no companies."
      : `${stats.candidates} candidates · ${stats.cached} filtered free from cache · ${stats.metered} need a metered lookup.`;
  await db.finderList.update({
    where: { id: list.id },
    data: { status: "READY", stats: stats as unknown as Prisma.InputJsonValue, message, lastRunAt: now },
  });
  return { ok: true, stats, message };
}

function emptyStats(): ListStats {
  return { candidates: 0, excluded: {}, cached: 0, metered: 0, harvestedAt: null, fragments: 0, errors: [] };
}

export interface CandidateInput {
  taxNumber: string;
  poolId: string | null;
  name: string;
  /** The status word from the search hit, when there is one. */
  status: string | null;
  domain: string | null;
  foundByKeyword: boolean;
  score: number;
}

/**
 * Bring the list's result rows in line with its candidates, run the free
 * pre-filter, and filter every candidate whose datasheet is cached. Shared
 * by phase 1 and (with cached sheets as the candidates) cached-only mode.
 */
export async function reconcileCandidates(
  db: WorkspaceClient,
  workspaceId: string,
  listId: string,
  hash: string,
  criteria: FinderCriteria,
  segments: SegmentView[],
  candidates: CandidateInput[],
  now: Date,
  opts: { includeExpiredCache?: boolean } = {},
): Promise<ListStats> {
  const facts = await loadWorkspaceFacts(db);
  const byTax = new Map<string, CandidateInput>();
  for (const c of candidates) {
    const tax = cegadatTaxId(c.taxNumber);
    if (tax && !byTax.has(tax)) byTax.set(tax, { ...c, taxNumber: tax });
  }
  const taxes = [...byTax.keys()];

  // Refused for the same criteria, recently, by another list: free to skip.
  const cutoff = new Date(now.getTime() - REFILTER_DAYS * 86_400_000);
  const previously = new Set(
    (
      await db.finderResult.findMany({
        where: { listId: { not: listId }, criteriaHash: hash, state: "NO_MATCH", evaluatedAt: { gte: cutoff } },
        select: { taxNumber: true },
        take: 100_000,
      })
    ).map((r) => r.taxNumber),
  );

  const existing = new Map(
    (await db.finderResult.findMany({ where: { listId }, select: { id: true, taxNumber: true, state: true, criteriaHash: true } })).map((r) => [
      r.taxNumber,
      r,
    ]),
  );

  // The free pre-filter, on what the pool row alone says.
  const pre = (c: CandidateInput): { reason: FinderReason; detail: string } | null => {
    if (criteria.excludeInCrm && (facts.crmTax.has(c.taxNumber) || (c.domain && facts.crmDomains.has(c.domain)))) {
      return { reason: "IN_CRM", detail: "already in the CRM" };
    }
    if (criteria.excludeSuppressed && isCompanySuppressed({ domain: c.domain, taxNumber: c.taxNumber }, facts.suppressed)) {
      return { reason: "SUPPRESSED", detail: "on the suppression list" };
    }
    if (criteria.status !== "any" && c.status && fold(c.status) !== fold(criteria.status)) {
      return { reason: "STATUS", detail: `search hit status "${c.status}", list wants "${criteria.status}"` };
    }
    const form = legalFormFromName(c.name);
    if (form) {
      if (criteria.legalForms.length > 0 && !criteria.legalForms.some((f) => f.toLowerCase() === form.toLowerCase())) {
        return { reason: "LEGAL_FORM", detail: `the name says ${form}, list wants ${criteria.legalForms.join("/")}` };
      }
      if (criteria.businessType === "company" && form === "e.v.") {
        return { reason: "LEGAL_FORM", detail: "the name says sole trader, list wants companies" };
      }
      if (legalFormImplausible(form, criteria.sizeBands)) {
        return { reason: "LEGAL_FORM", detail: `a ${form} cannot be ${criteria.sizeBands.join("/").toLowerCase()}` };
      }
    }
    if (previously.has(c.taxNumber)) return { reason: "PREVIOUSLY_FILTERED", detail: "refused under the same criteria by another list" };
    return null;
  };

  const creates: Prisma.FinderResultCreateManyInput[] = [];
  const excluded: Record<string, number> = {};
  const pending: string[] = [];
  for (const tax of taxes) {
    const c = byTax.get(tax)!;
    const row = existing.get(tax);
    // Decided under these exact criteria: keep, it was paid for or filtered already.
    if (row && row.criteriaHash === hash && (row.state === "MATCH" || row.state === "NO_MATCH" || row.state === "NOT_FOUND")) continue;
    const p = pre(c);
    const data = {
      name: c.name,
      poolId: c.poolId,
      priority: c.score,
      state: (p ? "EXCLUDED" : "PENDING") as FinderResultState,
      reason: p?.reason ?? null,
      detail: p?.detail ?? null,
      criteriaHash: hash,
      evaluatedAt: p ? now : null,
    };
    if (p) excluded[p.reason] = (excluded[p.reason] ?? 0) + 1;
    else pending.push(tax);
    if (row) await db.finderResult.update({ where: { id: row.id }, data });
    else creates.push({ workspaceId, listId, taxNumber: tax, ...data });
  }
  for (let i = 0; i < creates.length; i += 1000) {
    await db.finderResult.createMany({ data: creates.slice(i, i + 1000), skipDuplicates: true });
  }

  // Cached sheets: filter now, free. A not-found answer is cached too.
  const keywordFound = new Map(taxes.map((t) => [t, byTax.get(t)!.foundByKeyword]));
  let cached = 0;
  for (let i = 0; i < pending.length; i += 500) {
    const chunk = pending.slice(i, i + 500);
    const sheets = await db.registrySheet.findMany({
      where: { taxNumber: { in: chunk }, ...(opts.includeExpiredCache ? {} : { expiresAt: { gt: now } }) },
    });
    for (const s of sheets) {
      cached++;
      if (s.notFound) {
        await db.finderResult.updateMany({
          where: { listId, taxNumber: s.taxNumber },
          data: { state: "NOT_FOUND", fromCache: true, evaluatedAt: now, reason: null, detail: "the registry has no datasheet" },
        });
        continue;
      }
      const sheet = reviveDatasheet(s.sheet);
      if (!sheet) continue;
      const ev = evaluateSheet(criteria, sheet, segments, facts, { foundByKeyword: keywordFound.get(s.taxNumber) ?? false });
      await db.finderResult.updateMany({
        where: { listId, taxNumber: s.taxNumber },
        data: {
          state: ev.state,
          reason: ev.reason,
          detail: ev.detail,
          contacts: ev.contacts as unknown as Prisma.InputJsonValue,
          inCrm: ev.inCrm,
          fromCache: true,
          evaluatedAt: now,
          name: sheet.shortName ?? sheet.legalName,
        },
      });
    }
  }

  // Rows from an earlier harvest that this one no longer found stay as they
  // are: a result is not wrong because a fragment was removed.
  const metered = await db.finderResult.count({ where: { listId, state: { in: ["PENDING", "ERROR"] } } });
  return {
    candidates: taxes.length,
    excluded,
    cached,
    metered,
    harvestedAt: now.toISOString(),
    fragments: 0,
    errors: [],
  };
}

// ---- phase 2: the estimate ---------------------------------------------------------

export interface EnrichmentEstimate {
  /** Results still waiting for a datasheet. */
  pending: number;
  /** …of which the cache now holds (bought by something else since phase 1): free. */
  cachedNow: number;
  /** …and the rest, which cost one lookup each. */
  meteredNeeded: number;
  maxLookups: number;
  /** What this run will spend in total: min(max, needed). */
  expected: number;
  /** What it can spend today before pausing for the daily allocation. */
  expectedToday: number;
  monthRemaining: number;
  todayRemaining: number;
  dailyAllocation: number;
  reserve: number;
  /** expected ÷ month remaining, 0–1. */
  monthShare: number;
  /** maxLookups ÷ today's remaining allocation (may exceed 1 → the run pauses). */
  todayShare: number;
  exceedsToday: boolean;
}

export async function estimateEnrichment(
  workspaceId: string,
  listId: string,
  maxLookups: number,
  now: Date = new Date(),
): Promise<EnrichmentEstimate> {
  const db = getWorkspaceClient(workspaceId);
  const pendingRows = await db.finderResult.findMany({
    where: { listId, OR: [{ state: "PENDING" }, { state: "ERROR", attempts: { lt: MAX_ATTEMPTS } }] },
    select: { taxNumber: true },
  });
  let cachedNow = 0;
  for (let i = 0; i < pendingRows.length; i += 1000) {
    cachedNow += await db.registrySheet.count({
      where: { taxNumber: { in: pendingRows.slice(i, i + 1000).map((r) => r.taxNumber) }, expiresAt: { gt: now } },
    });
  }
  const meteredNeeded = Math.max(0, pendingRows.length - cachedNow);
  const m = await quotaMeter(workspaceId, now);
  const expected = Math.min(Math.max(0, maxLookups), meteredNeeded);
  const expectedToday = Math.min(expected, m.batchRemainingToday);
  return {
    pending: pendingRows.length,
    cachedNow,
    meteredNeeded,
    maxLookups,
    expected,
    expectedToday,
    monthRemaining: m.monthRemaining,
    todayRemaining: m.batchRemainingToday,
    dailyAllocation: m.dailyAllocation,
    reserve: m.reserve,
    monthShare: m.monthRemaining > 0 ? Math.min(1, expected / m.monthRemaining) : 1,
    todayShare: m.batchRemainingToday > 0 ? maxLookups / m.batchRemainingToday : Infinity,
    exceedsToday: expected > m.batchRemainingToday,
  };
}

// ---- phase 2: a pass ------------------------------------------------------------------

export type FinderPassOutcome = {
  status: "RUNNING" | "CHECKPOINT" | "PAUSED_QUOTA" | "DONE" | "CANCELLED" | "FAILED";
  again: boolean;
  message?: string;
};

export async function advanceFinderRun(workspaceId: string, runId: string, deps: FinderDeps): Promise<FinderPassOutcome> {
  const db = getWorkspaceClient(workspaceId);
  const run = await db.finderRun.findUnique({ where: { id: runId } });
  if (!run) return { status: "FAILED", again: false, message: "run not found" };
  if (run.status !== "RUNNING") return { status: run.status as FinderPassOutcome["status"], again: false };
  const list = await db.finderList.findUnique({ where: { id: run.listId } });
  if (!list) return finishRun(db, runId, null, "FAILED", "The list no longer exists.");
  const criteria = parseCriteria(list.criteria);
  const segments = await loadSegments(db, workspaceId);
  const facts = await loadWorkspaceFacts(db);
  const kwKeys = new Set(listPoolKeys(criteria).keywordKeys);

  let spent = run.lookupsSpent;
  let paidMatches = run.paidMatches;
  let evaluated = run.evaluated;
  let matches = run.matches;
  // The pass stops at the first of: the budget, the checkpoint, the pass size.
  const stopAt = Math.min(run.maxLookups, run.checkpointAt ?? Infinity, spent + (deps.lookupsPerPass ?? 50));

  const save = () =>
    db.finderRun.update({ where: { id: runId }, data: { lookupsSpent: spent, paidMatches, evaluated, matches } });

  let quotaPaused: string | null = null;
  let failure: string | null = null;
  let exhausted = false;
  while (spent < stopAt && !quotaPaused && !failure) {
    const batch = await db.finderResult.findMany({
      where: { listId: list.id, OR: [{ state: "PENDING" }, { state: "ERROR", attempts: { lt: MAX_ATTEMPTS } }] },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: Math.max(1, Math.min(50, stopAt - spent)),
    });
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    const poolKeys = new Map(
      (
        await db.candidatePool.findMany({
          where: { id: { in: batch.map((b) => b.poolId).filter((x): x is string => !!x) } },
          select: { id: true, segmentKeys: true },
        })
      ).map((p) => [p.id, stringArray(p.segmentKeys)]),
    );
    for (const r of batch) {
      if (spent >= stopAt) break;
      const res = await getDatasheet(workspaceId, r.taxNumber, {
        purpose: "FINDER_RUN",
        candidateId: r.id,
        userId: run.startedById,
        api: deps.registryApi,
        now: deps.now(),
      });
      if (res.status === "quota_exhausted") {
        quotaPaused =
          res.scope === "daily"
            ? "Today's registry allocation is used up. Resume tomorrow — nothing already looked up is paid for again."
            : "The month's registry quota is used up. Resume next month.";
        break;
      }
      if (res.status === "unavailable") {
        failure = res.message;
        break;
      }
      const now = deps.now();
      if (res.status === "error") {
        spent++; // a failed call still reached the meter (see CHARGED_OUTCOMES)
        await db.finderResult.update({
          where: { id: r.id },
          data: { state: "ERROR", attempts: { increment: 1 }, detail: res.message.slice(0, 300) },
        });
        continue;
      }
      if (!res.fromCache) spent++;
      evaluated++;
      if (res.status === "not_found") {
        await db.finderResult.update({
          where: { id: r.id },
          data: { state: "NOT_FOUND", fromCache: res.fromCache, evaluatedAt: now, reason: null, detail: "the registry has no datasheet", criteriaHash: list.criteriaHash },
        });
        continue;
      }
      const foundByKeyword = (r.poolId ? poolKeys.get(r.poolId) ?? [] : []).some((k) => kwKeys.has(k));
      const ev = evaluateSheet(criteria, res.sheet, segments, facts, { foundByKeyword });
      if (ev.state === "MATCH") {
        matches++;
        if (!res.fromCache) paidMatches++;
      }
      await db.finderResult.update({
        where: { id: r.id },
        data: {
          state: ev.state,
          reason: ev.reason,
          detail: ev.detail,
          contacts: ev.contacts as unknown as Prisma.InputJsonValue,
          inCrm: ev.inCrm,
          fromCache: res.fromCache,
          evaluatedAt: now,
          criteriaHash: list.criteriaHash,
          name: res.sheet.shortName ?? res.sheet.legalName,
        },
      });
    }
    await save();
  }
  await save();

  if (failure) return finishRun(db, runId, list.id, "FAILED", failure);
  if (quotaPaused) {
    await db.finderRun.update({ where: { id: runId }, data: { status: "PAUSED_QUOTA", message: quotaPaused } });
    await db.finderList.update({ where: { id: list.id }, data: { status: "PAUSED_QUOTA", message: quotaPaused } });
    return { status: "PAUSED_QUOTA", again: false, message: quotaPaused };
  }
  const yieldNote = spent > 0 ? ` Yield: ${yieldPer100(paidMatches, spent)} matches per 100 lookups.` : "";
  if (exhausted) {
    return finishRun(db, runId, list.id, "DONE", `Every candidate has been looked up. ${spent} lookups, ${matches} matches.${yieldNote}`);
  }
  if (spent >= run.maxLookups) {
    return finishRun(db, runId, list.id, "DONE", `The run's maximum of ${run.maxLookups} lookups is spent; ${matches} matches.${yieldNote}`);
  }
  if (run.checkpointAt !== null && spent >= run.checkpointAt) {
    const msg = `First batch done: ${spent} lookups, ${paidMatches} matches.${yieldNote} Continue to spend the rest of the run's ${run.maxLookups}, or stop here.`;
    await db.finderRun.update({ where: { id: runId }, data: { status: "CHECKPOINT", message: msg } });
    await db.finderList.update({ where: { id: list.id }, data: { status: "CHECKPOINT", message: msg } });
    return { status: "CHECKPOINT", again: false, message: msg };
  }
  return { status: "RUNNING", again: true };
}

export function yieldPer100(matches: number, lookups: number): number {
  return lookups > 0 ? Math.round((matches / lookups) * 1000) / 10 : 0;
}

async function finishRun(
  db: WorkspaceClient,
  runId: string,
  listId: string | null,
  status: "DONE" | "FAILED",
  message: string,
): Promise<FinderPassOutcome> {
  await db.finderRun.update({ where: { id: runId }, data: { status, message, finishedAt: new Date() } });
  if (listId) await db.finderList.update({ where: { id: listId }, data: { status: status === "DONE" ? "IDLE" : "FAILED", message } });
  return { status, again: false, message };
}

/** A new run, with the estimate the person confirmed. */
export async function createFinderRun(
  db: WorkspaceClient,
  workspaceId: string,
  input: { listId: string; maxLookups: number; estimate: EnrichmentEstimate; userId: string | null },
) {
  const run = await db.finderRun.create({
    data: {
      workspaceId,
      listId: input.listId,
      maxLookups: input.maxLookups,
      estimate: input.estimate as unknown as Prisma.InputJsonValue,
      checkpointAt: input.maxLookups > FIRST_BATCH ? FIRST_BATCH : null,
      startedById: input.userId,
      status: "RUNNING",
    },
  });
  await db.finderList.update({ where: { id: input.listId }, data: { status: "ENRICHING", message: null, lastRunAt: new Date() } });
  return run;
}

/** Continue past the checkpoint, or resume after a quota pause. */
export async function resumeFinderRun(db: WorkspaceClient, runId: string): Promise<{ ok: boolean; error?: string; listId?: string }> {
  const run = await db.finderRun.findUnique({ where: { id: runId } });
  if (!run) return { ok: false, error: "That run no longer exists." };
  if (run.status !== "CHECKPOINT" && run.status !== "PAUSED_QUOTA") return { ok: false, error: "That run is not paused." };
  await db.finderRun.update({
    where: { id: runId },
    data: { status: "RUNNING", message: null, ...(run.status === "CHECKPOINT" ? { checkpointAt: null } : {}) },
  });
  await db.finderList.update({ where: { id: run.listId }, data: { status: "ENRICHING", message: null } });
  return { ok: true, listId: run.listId };
}

export async function stopFinderRun(db: WorkspaceClient, runId: string): Promise<{ ok: boolean; error?: string }> {
  const run = await db.finderRun.findUnique({ where: { id: runId } });
  if (!run) return { ok: false, error: "That run no longer exists." };
  if (run.status === "DONE" || run.status === "CANCELLED" || run.status === "FAILED") return { ok: false, error: "That run has already finished." };
  const message = `Stopped by hand after ${run.lookupsSpent} lookups.`;
  await db.finderRun.update({ where: { id: runId }, data: { status: "CANCELLED", finishedAt: new Date(), message } });
  await db.finderList.update({ where: { id: run.listId }, data: { status: "IDLE", message } });
  return { ok: true };
}
