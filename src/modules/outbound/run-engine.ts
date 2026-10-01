/**
 * The sourcing run (spec §4.43.3–6, playbook-v6 F3).
 *
 * `advanceRun` takes a run as far as it can in one pass and says whether
 * another pass is needed. It is idempotent and resumable: everything it knows
 * lives on the candidate rows, so a worker restarted mid-run picks up where
 * the last pass stopped and cannot spend a registry unit twice — a candidate
 * already ENRICHED re-reads its sheet from the cache, which is free.
 *
 * One pass, in order:
 *
 *   1. finish what is waiting: audits that completed, candidates that were
 *      contact-resolved before a draft generator existed;
 *   2. resume candidates a previous pass left unenriched (a quota pause);
 *   3. top up: score the eligible pool, and spend detail lookups best-first
 *      until the run holds `requested` qualified candidates, the day's
 *      allocation runs out (→ PAUSED_QUOTA), or the pool is exhausted.
 *
 * Every step that refuses a candidate records why, with the measured value.
 * A transient failure parks that one candidate and the run carries on.
 */
import type { CandidateReason, CandidateState, PoolSource, Prisma, ProspectCandidate, CandidatePool } from "@prisma/client";
import { getWorkspaceClient, type WorkspaceClient } from "@/lib/db";
import type { CompanyDatasheet } from "@/modules/registry/datasheet";
import {
  cachedDatasheet,
  getDatasheet,
  searchRegistry,
} from "@/modules/registry/registry-service";
import type { CompanyRegistryApi } from "@/modules/registry/cegadat";
import { cegadatTaxId } from "@/modules/registry/cegadat";
import type { VerifyResult } from "@/modules/verification/types";
import { isCompanySuppressed } from "@/modules/mail/suppression";
import { toProfileView, toSegmentView, stringArray, type ProfileView, type SegmentView } from "./catalog";
import { ensureSegments } from "./segments";
import { auditFilter, localFilter, type FilterProfile } from "./filter";
import { buildFacts, type CandidateFact, type AuditForFacts } from "./facts";
import { resolveContact, type ResolvedContact } from "./contact";
import { domainOf, foldName, scorePoolRow } from "./pool";
import { QUALIFIED_STATES, IN_FLIGHT_STATES, transition } from "./state";
import { harvestSegment, resolveSeeds, type SourceDeps } from "./sources";
import type { AuditStart } from "./audit-bridge";

export interface SiteContactsRead {
  emails: string[];
  phones: string[];
  names: string[];
}

/** Everything with I/O beyond the database, injectable for tests. */
export interface RunDeps {
  now: () => Date;
  /** Undefined → the workspace's configured provider. */
  registryApi?: CompanyRegistryApi | null;
  startAudit: (workspaceId: string, url: string) => Promise<AuditStart>;
  readSite: (url: string) => Promise<SiteContactsRead | null>;
  verify: (email: string) => Promise<VerifyResult>;
  sleep: (ms: number) => Promise<void>;
  /**
   * Turn a contact-resolved candidate into a draft (F4). Absent until the
   * drafting phase is wired; candidates then wait at CONTACT_RESOLVED.
   */
  draft?: (workspaceId: string, candidateId: string) => Promise<void>;
  /** Bound on detail lookups in one pass, so a pass stays short. */
  maxLookupsPerPass?: number;
  /** Bound on harvest pages per fragment on a run's first pass. */
  harvestPagesPerFragment?: number;
}

export type PassOutcome = {
  status: "RUNNING" | "AWAITING_AUDITS" | "PAUSED_QUOTA" | "DONE" | "FAILED" | "CANCELLED";
  /** Another pass would make progress now (RUNNING) or after a wait (AWAITING_AUDITS). */
  again: boolean;
  message?: string;
};

/** An audit still queued after this long is treated as failed for the run's purposes. */
const AUDIT_PATIENCE_MS = 45 * 60_000;
/** A refused company is not reconsidered for the same profile for this long. */
const REFILTER_DAYS = 90;
const PARK_MS = 20 * 3_600_000;

type PoolRow = CandidatePool;
type Candidate = ProspectCandidate;

interface RunContext {
  db: WorkspaceClient;
  workspaceId: string;
  runId: string;
  profile: ProfileView;
  filterProfile: FilterProfile;
  segments: SegmentView[];
  purpose: "NIGHTLY_RUN" | "MANUAL_RUN";
  deps: RunDeps;
  crmTax: Set<string>;
  crmDomains: Set<string>;
  suppressed: string[];
  lookups: number;
  quotaPaused: boolean;
  failure: string | null;
}

function toFilterProfile(p: ProfileView): FilterProfile {
  return {
    segmentKeys: p.segmentKeys,
    sizeBands: p.sizeBands,
    includeUnknownSize: p.includeUnknownSize,
    revenueMin: p.revenueMin,
    revenueMax: p.revenueMax,
    counties: p.counties,
    cities: p.cities,
    legalForms: p.legalForms,
    foundedAfter: p.foundedAfter,
    foundedBefore: p.foundedBefore,
    statusRequired: p.statusRequired,
    requiresWebsite: p.requiresWebsite,
    auditScoreMin: p.auditScoreMin,
    auditScoreMax: p.auditScoreMax,
    requiredSignals: p.requiredSignals,
  };
}

/** Does the profile need the datasheet to decide? A Places row without one then cannot pass. */
function needsRegistry(p: ProfileView): boolean {
  return (
    p.sizeBands.length > 0 && !p.includeUnknownSize
  ) || p.revenueMin !== null || p.revenueMax !== null || p.legalForms.length > 0 || p.foundedAfter !== null || p.foundedBefore !== null || p.counties.length > 0;
}

// ---- the pass -----------------------------------------------------------------

export async function advanceRun(workspaceId: string, runId: string, deps: RunDeps): Promise<PassOutcome> {
  const db = getWorkspaceClient(workspaceId);
  const run = await db.sourcingRun.findUnique({ where: { id: runId } });
  if (!run) return { status: "FAILED", again: false, message: "run not found" };
  if (run.status === "DONE" || run.status === "FAILED" || run.status === "CANCELLED") {
    return { status: run.status, again: false };
  }
  const profileRow = run.profileId ? await db.icpProfile.findUnique({ where: { id: run.profileId } }) : null;
  if (!profileRow) return finish(db, runId, "FAILED", "The profile this run was for no longer exists.");
  const profile = toProfileView(profileRow);

  await ensureSegments(db, workspaceId);
  const segments = (await db.segment.findMany()).map(toSegmentView);

  const [companies, suppressions] = await Promise.all([
    db.company.findMany({ where: { mergedIntoId: null }, select: { taxId: true, domain: true, website: true } }),
    db.suppression.findMany({ select: { address: true } }),
  ]);
  const ctx: RunContext = {
    db,
    workspaceId,
    runId,
    profile,
    filterProfile: toFilterProfile(profile),
    segments,
    purpose: run.trigger === "NIGHTLY" ? "NIGHTLY_RUN" : "MANUAL_RUN",
    deps,
    crmTax: new Set(companies.map((c) => cegadatTaxId(c.taxId ?? "")).filter((t): t is string => !!t)),
    crmDomains: new Set(
      companies.flatMap((c) => [c.domain, domainOf(c.website)]).filter((d): d is string => !!d).map((d) => d.toLowerCase()),
    ),
    suppressed: suppressions.map((s) => s.address),
    lookups: 0,
    quotaPaused: false,
    failure: null,
  };

  await db.sourcingRun.update({ where: { id: runId }, data: { passes: { increment: 1 }, status: "RUNNING" } });

  // First pass: make sure the pool has something in it for these segments.
  if (run.passes === 0) await refreshSources(ctx, run.channel);

  // 1. What is waiting.
  const now = deps.now();
  const waiting = await db.prospectCandidate.findMany({
    where: {
      runId,
      state: { in: ["SOURCED", "ENRICHED", "FILTERED_IN", "AUDITED", "CONTACT_RESOLVED"] },
      OR: [{ parkedUntil: null }, { parkedUntil: { lte: now } }],
    },
    include: { pool: true },
    orderBy: { priority: "desc" },
  });
  let pendingAudits = 0;
  for (const c of waiting) {
    if (ctx.failure || ctx.quotaPaused) break;
    if (c.state === "FILTERED_IN") {
      const still = await advanceAudit(ctx, c);
      if (still) pendingAudits++;
    } else if (c.state === "AUDITED") {
      await resolveAndDraft(ctx, c, await sheetFor(ctx, c));
    } else if (c.state === "CONTACT_RESOLVED") {
      if (deps.draft) await deps.draft(workspaceId, c.id);
    } else {
      const r = await processFromSourced(ctx, c, c.pool);
      if (r === "awaiting_audit") pendingAudits++;
    }
  }

  // 2–3. Top up from the pool.
  let poolExhausted = false;
  if (!ctx.failure && !ctx.quotaPaused) {
    const r = await topUp(ctx, run.requested, run.channel);
    pendingAudits += r.pendingAudits;
    poolExhausted = r.exhausted;
  }

  await recount(db, runId, poolExhausted);

  if (ctx.failure) return finish(db, runId, "FAILED", ctx.failure);
  if (ctx.quotaPaused) {
    await db.sourcingRun.update({
      where: { id: runId },
      data: { status: "PAUSED_QUOTA", message: "Today's registry allocation is used up; the run resumes on the next pass." },
    });
    return { status: "PAUSED_QUOTA", again: false };
  }
  const qualified = await db.prospectCandidate.count({ where: { runId, state: { in: [...QUALIFIED_STATES] } } });
  const parked = await db.prospectCandidate.count({ where: { runId, parkedUntil: { gt: deps.now() } } });
  if (pendingAudits > 0) {
    await db.sourcingRun.update({ where: { id: runId }, data: { status: "AWAITING_AUDITS" } });
    return { status: "AWAITING_AUDITS", again: true };
  }
  if (qualified < run.requested && !poolExhausted && ctx.lookups >= (deps.maxLookupsPerPass ?? 150)) {
    return { status: "RUNNING", again: true };
  }
  const short = qualified < run.requested;
  return finish(
    db,
    runId,
    "DONE",
    short
      ? `${qualified} of ${run.requested} qualified — ${poolExhausted ? "the pool for this profile is exhausted" : "the remaining candidates did not qualify"}${parked ? `; ${parked} parked for retry` : ""}.`
      : `${qualified} qualified.`,
  );
}

async function finish(db: WorkspaceClient, runId: string, status: "DONE" | "FAILED", message: string): Promise<PassOutcome> {
  await db.sourcingRun.update({ where: { id: runId }, data: { status, message, finishedAt: new Date() } });
  return { status, again: false, message };
}

// ---- sources on the first pass --------------------------------------------------

async function refreshSources(ctx: RunContext, channel: string): Promise<void> {
  const sourceDeps: SourceDeps = {
    search: (p) => searchRegistry(ctx.workspaceId, p, { api: ctx.deps.registryApi, now: ctx.deps.now() }),
    sleep: ctx.deps.sleep,
    now: ctx.deps.now(),
  };
  for (const key of ctx.profile.segmentKeys) {
    const seg = ctx.segments.find((s) => s.key === key && !s.archived);
    if (!seg) continue;
    if ((channel === "all" || channel === "SEED_LIST") && seg.seedList.length > 0) {
      await resolveSeeds(ctx.db, ctx.workspaceId, seg, sourceDeps);
    }
    if ((channel === "all" || channel === "NAME_HARVEST") && seg.fragments.length > 0) {
      await harvestSegment(ctx.db, ctx.workspaceId, seg, sourceDeps, {
        maxPagesPerFragment: ctx.deps.harvestPagesPerFragment ?? 2,
      });
    }
  }
}

// ---- top-up ----------------------------------------------------------------------

/**
 * The pool rows a run for this profile may draw from: in one of its
 * segments, from the chosen channel, not being worked anywhere, not already
 * contacted, and not refused for this profile in the last 90 days. Exported
 * so the pre-run estimate counts exactly what the run will see.
 */
export async function eligiblePool(
  db: WorkspaceClient,
  profile: Pick<ProfileView, "id" | "segmentKeys">,
  channel: string,
  now: Date,
  runId: string | null = null,
): Promise<PoolRow[]> {
  const rows = await db.candidatePool.findMany({
    where: channel === "all" ? {} : { source: channel as PoolSource },
    take: 20_000,
    orderBy: { lastSeenAt: "desc" },
  });
  const wanted = new Set(profile.segmentKeys);
  const inSegment = wanted.size === 0 ? rows : rows.filter((r) => stringArray(r.segmentKeys).some((k) => wanted.has(k)));
  if (inSegment.length === 0) return [];

  const cutoff = new Date(now.getTime() - REFILTER_DAYS * 86_400_000);
  const blocking = await db.prospectCandidate.findMany({
    where: {
      poolId: { in: inSegment.map((r) => r.id) },
      OR: [
        ...(runId ? [{ runId }] : []),
        // Being worked, or already contacted, under ANY product: one company,
        // one conversation at a time.
        { state: { in: [...IN_FLIGHT_STATES] } },
        // Refused for THIS profile recently.
        { profileId: profile.id, state: { in: ["FILTERED_OUT", "REJECTED"] }, updatedAt: { gte: cutoff } },
      ],
    },
    select: { poolId: true },
  });
  const blocked = new Set(blocking.map((b) => b.poolId));
  return inSegment.filter((r) => !blocked.has(r.id));
}

async function fragmentApprovalRates(ctx: RunContext): Promise<Map<string, number>> {
  // Approval rate per fragment for this profile, once there are 20 decided
  // candidates behind it — below that a rate is noise wearing a number.
  const decided = await ctx.db.prospectCandidate.findMany({
    where: { profileId: ctx.profile.id, state: { in: ["APPROVED", "SENT", "REPLIED", "REJECTED"] } },
    select: { state: true, pool: { select: { hits: true } } },
    take: 5000,
  });
  const tally = new Map<string, { n: number; ok: number }>();
  for (const d of decided) {
    const hits = Array.isArray(d.pool.hits) ? (d.pool.hits as Array<{ fragment?: string }>) : [];
    for (const h of hits) {
      if (!h.fragment) continue;
      const t = tally.get(h.fragment) ?? { n: 0, ok: 0 };
      t.n++;
      if (d.state !== "REJECTED") t.ok++;
      tally.set(h.fragment, t);
    }
  }
  const out = new Map<string, number>();
  for (const [f, t] of tally) if (t.n >= 20) out.set(f, t.ok / t.n);
  return out;
}

async function topUp(
  ctx: RunContext,
  requested: number,
  channel: string,
): Promise<{ pendingAudits: number; exhausted: boolean }> {
  const { db } = ctx;
  let pendingAudits = 0;
  const qualifiedNow = () => db.prospectCandidate.count({ where: { runId: ctx.runId, state: { in: [...QUALIFIED_STATES] } } });
  let need = requested - (await qualifiedNow());
  if (need <= 0) return { pendingAudits, exhausted: false };

  const pool = await eligiblePool(db, ctx.profile, channel, ctx.deps.now(), ctx.runId);
  const own = ctx.segments.filter((s) => ctx.profile.segmentKeys.includes(s.key));
  const others = ctx.segments.filter((s) => !ctx.profile.segmentKeys.includes(s.key));
  const scoringCtx = {
    profileSegments: ctx.profile.segmentKeys,
    profileFragments: own.flatMap((s) => s.fragments),
    otherFragments: others.flatMap((s) => s.fragments),
    sizeBands: ctx.profile.sizeBands,
    fragmentApproval: await fragmentApprovalRates(ctx),
    now: ctx.deps.now(),
  };
  const ranked = pool
    .map((row) => ({
      row,
      score: scorePoolRow(
        {
          name: row.name,
          source: row.source,
          segmentKeys: stringArray(row.segmentKeys),
          hits: Array.isArray(row.hits) ? (row.hits as Array<{ segment: string; fragment: string }>) : [],
          lastSeenAt: row.lastSeenAt,
        },
        scoringCtx,
      ),
    }))
    .sort((a, b) => b.score - a.score);

  const maxLookups = ctx.deps.maxLookupsPerPass ?? 150;
  let i = 0;
  for (; i < ranked.length; i++) {
    if (need <= 0 || ctx.quotaPaused || ctx.failure || ctx.lookups >= maxLookups) break;
    const { row, score } = ranked[i]!;
    const created = await db.prospectCandidate.create({
      data: {
        workspaceId: ctx.workspaceId,
        runId: ctx.runId,
        poolId: row.id,
        productId: ctx.profile.productId,
        profileId: ctx.profile.id,
        taxNumber: row.taxNumber,
        name: row.name,
        priority: score,
        website: row.website,
        state: "SOURCED",
      },
    });
    await db.candidateEvent.create({
      data: { workspaceId: ctx.workspaceId, candidateId: created.id, toState: "SOURCED", detail: `from ${row.source.toLowerCase()} (score ${score})` },
    });
    const r = await processFromSourced(ctx, created, row);
    if (r === "awaiting_audit") pendingAudits++;
    if (r === "qualified" || r === "awaiting_audit") need--;
  }
  return { pendingAudits, exhausted: i >= ranked.length && need > 0 };
}

// ---- one candidate ---------------------------------------------------------------

type StepResult = "out" | "qualified" | "awaiting_audit" | "waiting" | "parked";

async function out(ctx: RunContext, c: { id: string; state: CandidateState }, reason: CandidateReason, detail: string): Promise<"out"> {
  await transition(ctx.db, ctx.workspaceId, c, "FILTERED_OUT", { reason, detail, at: ctx.deps.now() });
  return "out";
}

async function resolveTaxNumber(ctx: RunContext, row: PoolRow): Promise<string | null> {
  if (row.taxNumber) return row.taxNumber;
  if (row.name.trim().length < 4) return null;
  const res = await searchRegistry(ctx.workspaceId, { name: row.name, sensitivity: 0, businessType: "all", limit: 5 }, {
    api: ctx.deps.registryApi,
    now: ctx.deps.now(),
  });
  if (!res.ok) return null;
  // Only an unambiguous name match: adopting the wrong company's datasheet
  // would put somebody else's numbers in the message.
  const want = foldName(row.name);
  const matches = res.page.hits.filter((h) => {
    const a = foldName(h.shortName ?? h.fullName);
    const b = foldName(h.fullName);
    return a === want || b === want || (want.length >= 6 && (a.startsWith(want) || want.startsWith(a)));
  });
  if (matches.length !== 1) return null;
  const tax = cegadatTaxId(matches[0]!.taxNumber);
  if (tax) await ctx.db.candidatePool.update({ where: { id: row.id }, data: { taxNumber: tax } });
  return tax;
}

async function processFromSourced(ctx: RunContext, c: Candidate, row: PoolRow): Promise<StepResult> {
  const { db, profile } = ctx;

  // ---- free pre-filter, before any quota is spent ----
  const domain = row.domain ?? domainOf(row.website);
  const inCrm = (tax: string | null) => (tax && ctx.crmTax.has(tax)) || (domain && ctx.crmDomains.has(domain));
  if (c.state === "SOURCED") {
    if (inCrm(row.taxNumber)) return out(ctx, c, "IN_CRM", `already in the CRM (${row.taxNumber ? `tax ${row.taxNumber}` : domain})`);
    if (isCompanySuppressed({ domain, taxNumber: row.taxNumber }, ctx.suppressed)) {
      return out(ctx, c, "SUPPRESSED", "on the suppression list");
    }
  }

  const tax = await resolveTaxNumber(ctx, row);
  if (tax && tax !== row.taxNumber && c.state === "SOURCED") {
    if (inCrm(tax)) return out(ctx, c, "IN_CRM", `already in the CRM (tax ${tax})`);
    if (isCompanySuppressed({ taxNumber: tax }, ctx.suppressed)) return out(ctx, c, "SUPPRESSED", "on the suppression list");
    await db.prospectCandidate.update({ where: { id: c.id }, data: { taxNumber: tax } });
  }

  if (!tax) {
    // A Places or CSV row the registry cannot place. It may still pass a
    // profile whose rules do not need a datasheet — as size-unknown.
    if (needsRegistry(profile) || !profile.includeUnknownSize) {
      return out(ctx, c, "NO_TAX_NUMBER", "no tax number, and the registry search found no unambiguous match");
    }
    const seg = stringArray(row.segmentKeys).find((k) => profile.segmentKeys.includes(k)) ?? null;
    await transition(db, ctx.workspaceId, c, "FILTERED_IN", {
      detail: "no registry match; let in as size unknown",
      data: { unknownSize: true, matchedSegment: seg, website: row.website },
      at: ctx.deps.now(),
    });
    c.website = row.website;
    return startAuditOrSkip(ctx, c, null, row.website);
  }

  // ---- the one paid step ----
  const res = await getDatasheet(ctx.workspaceId, tax, {
    purpose: ctx.purpose,
    candidateId: c.id,
    api: ctx.deps.registryApi,
    now: ctx.deps.now(),
  });
  switch (res.status) {
    case "quota_exhausted":
      ctx.quotaPaused = true;
      return "waiting";
    case "unavailable":
      ctx.failure = res.message;
      return "waiting";
    case "error":
      await db.prospectCandidate.update({
        where: { id: c.id },
        data: { attempts: { increment: 1 }, lastError: res.message, parkedUntil: new Date(ctx.deps.now().getTime() + PARK_MS) },
      });
      return "parked";
    case "not_found":
      if (!res.fromCache) {
        ctx.lookups++;
        await db.sourcingRun.update({ where: { id: ctx.runId }, data: { quotaUsed: { increment: 1 } } });
      }
      return out(ctx, c, "NOT_IN_REGISTRY", `the registry has no datasheet for ${tax}`);
    case "ok":
      break;
  }
  if (!res.fromCache) {
    ctx.lookups++;
    await db.sourcingRun.update({ where: { id: ctx.runId }, data: { quotaUsed: { increment: 1 } } });
  }
  const sheet = res.sheet;
  if (c.state === "SOURCED") {
    await transition(db, ctx.workspaceId, c, "ENRICHED", {
      detail: res.fromCache ? "datasheet from cache" : "datasheet fetched",
      at: ctx.deps.now(),
    });
  }

  // ---- local ICP filter ----
  const website = sheet.website ?? row.website;
  const verdict = localFilter(ctx.filterProfile, sheet, ctx.segments, { website });
  if (!verdict.ok) return out(ctx, c, verdict.reason, verdict.detail);
  await transition(db, ctx.workspaceId, c, "FILTERED_IN", {
    detail: verdict.matchedSegment ? `matches ${verdict.matchedSegment}` : null,
    data: {
      sizeBand: verdict.sizeBand,
      unknownSize: verdict.unknownSize,
      matchedSegment: verdict.matchedSegment,
      website,
      name: sheet.shortName ?? sheet.legalName,
    },
    at: ctx.deps.now(),
  });
  // The row now carries the website; keep the in-memory copy in step, or the
  // contact step would read a site it thinks the company does not have.
  c.website = website;
  return startAuditOrSkip(ctx, c, sheet, website);
}

async function startAuditOrSkip(
  ctx: RunContext,
  c: Candidate,
  sheet: CompanyDatasheet | null,
  website: string | null,
): Promise<StepResult> {
  if (website) {
    try {
      const a = await ctx.deps.startAudit(ctx.workspaceId, website);
      await ctx.db.prospectCandidate.update({ where: { id: c.id }, data: { auditId: a.auditId } });
      // A cached audit is ready now; carry on without waiting a pass.
      if (a.cached) {
        const still = await advanceAudit(ctx, { ...c, auditId: a.auditId, state: "FILTERED_IN" }, sheet);
        return still ? "awaiting_audit" : "qualified";
      }
      return "awaiting_audit";
    } catch (e) {
      // The queue being down is not the company's fault: audit later.
      await ctx.db.prospectCandidate.update({
        where: { id: c.id },
        data: { lastError: (e as Error).message.slice(0, 300), parkedUntil: new Date(ctx.deps.now().getTime() + 15 * 60_000) },
      });
      return "awaiting_audit";
    }
  }
  // No website: the absence is the hook (spec §4.43.5).
  await afterAudit(ctx, c, sheet, null, true);
  return "qualified";
}

async function sheetFor(ctx: RunContext, c: Candidate): Promise<CompanyDatasheet | null> {
  if (!c.taxNumber) return null;
  return (await cachedDatasheet(ctx.workspaceId, c.taxNumber))?.sheet ?? null;
}

/** Returns true while the audit is still pending. */
async function advanceAudit(ctx: RunContext, c: Candidate, sheetIn?: CompanyDatasheet | null): Promise<boolean> {
  const sheet = sheetIn === undefined ? await sheetFor(ctx, c) : sheetIn;
  if (!c.auditId) {
    const r = await startAuditOrSkip(ctx, c, sheet, c.website);
    return r === "awaiting_audit";
  }
  const audit = await ctx.db.auditResult.findUnique({ where: { id: c.auditId } });
  const age = audit ? ctx.deps.now().getTime() - audit.createdAt.getTime() : Infinity;
  if (audit && audit.status !== "done" && audit.status !== "error" && age < AUDIT_PATIENCE_MS) return true;

  const usable =
    audit && audit.status === "done"
      ? ({
          score: audit.score,
          flags: Array.isArray(audit.flags) ? (audit.flags as string[]) : [],
          checks: Array.isArray(audit.checks) ? (audit.checks as unknown as AuditForFacts["checks"]) : [],
          url: audit.url,
        } satisfies AuditForFacts)
      : null;
  await afterAudit(ctx, c, sheet, usable, false, usable ? null : "audit failed or timed out — registry facts only");
  return false;
}

async function afterAudit(
  ctx: RunContext,
  c: Candidate,
  sheet: CompanyDatasheet | null,
  audit: AuditForFacts | null,
  noWebsite: boolean,
  note: string | null = null,
): Promise<void> {
  // A failed audit is not a missing site: only "no website" may stand in for one.
  if (audit || noWebsite) {
    const v = auditFilter(ctx.filterProfile, audit);
    if (!v.ok) {
      await out(ctx, c, v.reason, v.detail);
      return;
    }
  }
  const facts: CandidateFact[] = buildFacts({ sheet, audit, noWebsite, now: ctx.deps.now() });
  await transition(ctx.db, ctx.workspaceId, c, "AUDITED", {
    detail: note ?? (audit ? `audit score ${audit.score}` : noWebsite ? "no website — the absence is the hook" : null),
    data: { facts: facts as unknown as Prisma.InputJsonValue },
    at: ctx.deps.now(),
  });
  await resolveAndDraft(ctx, c, sheet);
}

async function resolveAndDraft(ctx: RunContext, c: Candidate, sheet: CompanyDatasheet | null): Promise<void> {
  const { db } = ctx;
  const website = c.website;
  let site: SiteContactsRead | null = null;
  if (website) {
    try {
      site = await ctx.deps.readSite(website);
    } catch {
      site = null;
    }
  }
  const domain = domainOf(website);
  const crm = domain
    ? (
        await db.lead.findMany({
          where: { email: { endsWith: `@${domain}` }, mergedIntoId: null },
          select: { contactName: true, email: true, phone: true },
          take: 3,
        })
      ).flatMap((l) => (l.email ? [{ name: l.contactName, email: l.email, phone: l.phone }] : []))
    : [];

  const contact: ResolvedContact = await resolveContact(
    {
      registry: sheet ? { email: sheet.email, phone: sheet.phone, managers: sheet.managers.map((m) => m.name) } : null,
      site: site ? { emails: site.emails, phones: site.phones, representedBy: site.names } : null,
      crm,
    },
    ctx.deps.verify,
  );
  const data = { contact: contact as unknown as Prisma.InputJsonValue };

  if (contact.kind === "none") {
    await transition(db, ctx.workspaceId, c, "LINKEDIN_QUEUE", {
      detail: contact.managerName ? `no address — search LinkedIn for ${contact.managerName}` : "no address found",
      data,
      at: ctx.deps.now(),
    });
    return;
  }
  if (contact.kind === "generic" && ctx.profile.contactRequirement === "NAMED_CONTACT") {
    await db.prospectCandidate.update({ where: { id: c.id }, data });
    await out(ctx, c, "NO_NAMED_CONTACT", `only a generic address (${contact.email}) and the profile requires a named contact`);
    return;
  }
  await transition(db, ctx.workspaceId, c, "CONTACT_RESOLVED", {
    detail: `${contact.kind.replace("_", " + ")} via ${contact.source}`,
    data,
    at: ctx.deps.now(),
  });
  if (ctx.deps.draft) await ctx.deps.draft(ctx.workspaceId, c.id);
}

// ---- counters -----------------------------------------------------------------

export interface RunCounters {
  byState: Partial<Record<CandidateState, number>>;
  byReason: Partial<Record<CandidateReason, number>>;
  /** Candidates that were ever evaluated in this run. */
  total: number;
  poolExhausted: boolean;
}

async function recount(db: WorkspaceClient, runId: string, poolExhausted: boolean): Promise<void> {
  const [states, reasons] = await Promise.all([
    db.prospectCandidate.groupBy({ by: ["state"], where: { runId }, _count: { _all: true } }),
    db.prospectCandidate.groupBy({ by: ["reason"], where: { runId, reason: { not: null } }, _count: { _all: true } }),
  ]);
  const counters: RunCounters = { byState: {}, byReason: {}, total: 0, poolExhausted };
  for (const s of states) {
    counters.byState[s.state] = s._count._all;
    counters.total += s._count._all;
  }
  for (const r of reasons) if (r.reason) counters.byReason[r.reason] = r._count._all;
  await db.sourcingRun.update({ where: { id: runId }, data: { counters: counters as unknown as Prisma.InputJsonValue } });
}

export function parseCounters(raw: unknown): RunCounters {
  const o = raw && typeof raw === "object" ? (raw as Partial<RunCounters>) : {};
  return { byState: o.byState ?? {}, byReason: o.byReason ?? {}, total: o.total ?? 0, poolExhausted: o.poolExhausted ?? false };
}
