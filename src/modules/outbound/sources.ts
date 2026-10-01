/**
 * Filling the candidate pool (spec §4.43.3, playbook-v6 F3/2–3). Four
 * channels, one pool, one dedupe key:
 *
 *   A. name-fragment harvesting over the free `/v1/search` — the engine;
 *   B. curated seed lists, resolved to tax numbers through the same search;
 *   C. Google Places results the Prospector already paid for;
 *   D. CSV rows.
 *
 * Nothing here spends registry quota: every call is a search, and searches
 * are free. Not a server action; actions and jobs call it with a workspace.
 */
import type { PoolSource, Prisma } from "@prisma/client";
import type { WorkspaceClient } from "@/lib/db";
import type { RegistrySearchParams, RegistrySearchHit } from "@/modules/registry/cegadat";
import { cegadatTaxId } from "@/modules/registry/cegadat";
import type { SearchResult } from "@/modules/registry/registry-service";
import type { SegmentView } from "./catalog";
import { stringArray } from "./catalog";
import { dedupeKeyFor, domainOf, foldName } from "./pool";

export interface PoolHit {
  segment: string;
  fragment: string;
  version: number;
  at: string;
}

export interface PoolInput {
  taxNumber?: string | null;
  name: string;
  status?: string | null;
  website?: string | null;
  phone?: string | null;
  city?: string | null;
  googlePlaceId?: string | null;
  segmentKey: string;
  hit?: PoolHit;
}

export interface SourceDeps {
  search: (params: RegistrySearchParams) => Promise<SearchResult>;
  /** Politeness between searches. */
  sleep: (ms: number) => Promise<void>;
  now: Date;
}

export interface UpsertSummary {
  created: number;
  updated: number;
}

function hitsOf(raw: Prisma.JsonValue): PoolHit[] {
  return Array.isArray(raw) ? (raw as unknown as PoolHit[]) : [];
}

/**
 * Upsert a batch into the pool. A company seen again gains the segment and
 * the fragment that found it this time; its first source is kept, because
 * "where did this company first come from" is the question the funnel asks.
 */
export async function upsertPool(
  db: WorkspaceClient,
  workspaceId: string,
  source: PoolSource,
  rows: PoolInput[],
  now: Date,
): Promise<UpsertSummary> {
  const byKey = new Map<string, PoolInput[]>();
  for (const r of rows) {
    if (!r.name.trim()) continue;
    const key = dedupeKeyFor(r);
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const keys = [...byKey.keys()];
  if (keys.length === 0) return { created: 0, updated: 0 };

  const existing = await db.candidatePool.findMany({ where: { dedupeKey: { in: keys } } });
  const have = new Map(existing.map((e) => [e.dedupeKey, e]));
  let created = 0;
  let updated = 0;

  const fresh = keys.filter((k) => !have.has(k));
  if (fresh.length > 0) {
    const res = await db.candidatePool.createMany({
      data: fresh.map((k) => {
        const group = byKey.get(k)!;
        const first = group[0]!;
        return {
          workspaceId,
          dedupeKey: k,
          taxNumber: first.taxNumber ? cegadatTaxId(first.taxNumber) : null,
          name: first.name.trim(),
          status: first.status ?? null,
          domain: domainOf(first.website),
          website: first.website ?? null,
          phone: first.phone ?? null,
          city: first.city ?? null,
          googlePlaceId: first.googlePlaceId ?? null,
          source,
          segmentKeys: [...new Set(group.map((g) => g.segmentKey))],
          hits: group.flatMap((g) => (g.hit ? [g.hit] : [])) as unknown as Prisma.InputJsonValue,
          firstSeenAt: now,
          lastSeenAt: now,
        };
      }),
      skipDuplicates: true,
    });
    created = res.count;
  }

  for (const k of keys.filter((x) => have.has(x))) {
    const row = have.get(k)!;
    const group = byKey.get(k)!;
    const segs = new Set(stringArray(row.segmentKeys));
    const hits = hitsOf(row.hits);
    for (const g of group) {
      segs.add(g.segmentKey);
      if (g.hit && !hits.some((h) => h.segment === g.hit!.segment && h.fragment === g.hit!.fragment)) hits.push(g.hit);
    }
    const first = group[0]!;
    await db.candidatePool.update({
      where: { id: row.id },
      data: {
        segmentKeys: [...segs],
        hits: hits.slice(-50) as unknown as Prisma.InputJsonValue,
        lastSeenAt: now,
        // Fill blanks only — a later channel never overwrites what an
        // earlier one knew.
        taxNumber: row.taxNumber ?? (first.taxNumber ? cegadatTaxId(first.taxNumber) : null),
        website: row.website ?? first.website ?? null,
        domain: row.domain ?? domainOf(first.website),
        phone: row.phone ?? first.phone ?? null,
        city: row.city ?? first.city ?? null,
        status: first.status ?? row.status,
        googlePlaceId: row.googlePlaceId ?? first.googlePlaceId ?? null,
      },
    });
    updated++;
  }
  return { created, updated };
}

// ---- A. name-fragment harvest ------------------------------------------------

export interface HarvestReport {
  segment: string;
  fragments: Array<{ fragment: string; found: number; pages: number; skipped?: string }>;
  created: number;
  updated: number;
  errors: string[];
}

/** A harvested fragment is left alone for this long once it has paged to the end. */
const HARVEST_FRESH_DAYS = 7;

export async function harvestSegment(
  db: WorkspaceClient,
  workspaceId: string,
  segment: SegmentView,
  deps: SourceDeps,
  opts: { maxPagesPerFragment?: number; pageSize?: number; force?: boolean } = {},
): Promise<HarvestReport> {
  const maxPages = opts.maxPagesPerFragment ?? 3;
  const pageSize = opts.pageSize ?? 100;
  const report: HarvestReport = { segment: segment.key, fragments: [], created: 0, updated: 0, errors: [] };

  for (const fragment of segment.fragments) {
    if (fragment.trim().length < 4) {
      report.fragments.push({ fragment, found: 0, pages: 0, skipped: "shorter than four characters" });
      continue;
    }
    let progress = await db.harvestProgress.findUnique({
      where: { workspaceId_segmentKey_fragment: { workspaceId, segmentKey: segment.key, fragment } },
    });
    // A new fragment-set version starts the fragment over: its yield is
    // measured against the set it ran in.
    if (progress && progress.version !== segment.version) {
      progress = await db.harvestProgress.update({
        where: { id: progress.id },
        data: { version: segment.version, nextPage: 1, totalPages: null, done: false, found: 0 },
      });
    }
    if (!progress) {
      progress = await db.harvestProgress.create({
        data: { workspaceId, segmentKey: segment.key, fragment, version: segment.version, harvestedAt: deps.now },
      });
    }
    const fresh = deps.now.getTime() - progress.harvestedAt.getTime() < HARVEST_FRESH_DAYS * 86_400_000;
    if (progress.done && fresh && !opts.force) {
      report.fragments.push({ fragment, found: 0, pages: 0, skipped: "harvested this week" });
      continue;
    }
    let page = progress.done ? 1 : progress.nextPage;
    let pages = 0;
    let found = 0;
    let totalPages = progress.totalPages;
    let done = false;
    while (pages < maxPages) {
      const res = await deps.search({
        name: fragment,
        sensitivity: 1,
        businessType: "company",
        status: "Aktív",
        limit: pageSize,
        page,
      });
      if (!res.ok) {
        report.errors.push(`${fragment}: ${res.message}`);
        break;
      }
      const at = deps.now.toISOString();
      const hits: PoolInput[] = res.page.hits.map((h: RegistrySearchHit) => ({
        taxNumber: h.taxNumber,
        name: h.shortName ?? h.fullName,
        status: h.status,
        segmentKey: segment.key,
        hit: { segment: segment.key, fragment, version: segment.version, at },
      }));
      const s = await upsertPool(db, workspaceId, "NAME_HARVEST", hits, deps.now);
      report.created += s.created;
      report.updated += s.updated;
      found += hits.length;
      pages++;
      totalPages = res.page.totalPages;
      if (page >= res.page.totalPages || hits.length === 0) {
        done = true;
        break;
      }
      page++;
      if (!res.fromCache) await deps.sleep(300);
    }
    await db.harvestProgress.update({
      where: { id: progress.id },
      data: {
        nextPage: done ? 1 : page,
        totalPages,
        done,
        found: (progress.done ? 0 : progress.found) + found,
        harvestedAt: deps.now,
      },
    });
    report.fragments.push({ fragment, found, pages });
  }
  return report;
}

// ---- B. seed lists ------------------------------------------------------------

export async function resolveSeeds(
  db: WorkspaceClient,
  workspaceId: string,
  segment: SegmentView,
  deps: SourceDeps,
): Promise<{ resolved: number; unresolved: string[] } & UpsertSummary> {
  const rows: PoolInput[] = [];
  const unresolved: string[] = [];
  for (const seed of segment.seedList) {
    const tax = seed.taxNumber ? cegadatTaxId(seed.taxNumber) : null;
    const params: RegistrySearchParams | null = tax
      ? { vatNumber: tax, businessType: "all", limit: 1 }
      : seed.name && seed.name.trim().length >= 4
        ? { name: seed.name, sensitivity: 0, businessType: "all", limit: 5 }
        : null;
    if (!params) {
      unresolved.push(seed.name ?? seed.taxNumber ?? "?");
      continue;
    }
    const res = await deps.search(params);
    // The closest name wins; with a tax number there is exactly one.
    const want = foldName(seed.name ?? "");
    const hit = res.ok
      ? (res.page.hits.find((h) => foldName(h.fullName) === want || foldName(h.shortName ?? "") === want) ?? res.page.hits[0])
      : undefined;
    if (!hit) {
      // Reported, never guessed: a seed that no longer resolves is somebody's
      // to fix in the list.
      unresolved.push(seed.name ?? seed.taxNumber ?? "?");
      continue;
    }
    rows.push({ taxNumber: hit.taxNumber, name: hit.shortName ?? hit.fullName, status: hit.status, segmentKey: segment.key });
    if (!res.ok || !res.fromCache) await deps.sleep(300);
  }
  const s = await upsertPool(db, workspaceId, "SEED_LIST", rows, deps.now);
  return { resolved: rows.length, unresolved, ...s };
}

// ---- C. Google Places -----------------------------------------------------------

export interface PlacesRowLike {
  placeId?: string | null;
  name: string;
  city?: string | null;
  phone: string | null;
  websiteUri: string | null;
  businessStatus?: string | null;
}

/** Rows the Prospector already fetched — no new Places spend. Closed places stay out. */
export async function addPlacesToPool(
  db: WorkspaceClient,
  workspaceId: string,
  segmentKey: string,
  rows: PlacesRowLike[],
  now: Date,
): Promise<UpsertSummary> {
  return upsertPool(
    db,
    workspaceId,
    "PLACES",
    rows
      .filter((r) => !r.businessStatus || r.businessStatus === "OPERATIONAL")
      .map((r) => ({
        name: r.name,
        website: r.websiteUri,
        phone: r.phone,
        city: r.city ?? null,
        googlePlaceId: r.placeId ?? null,
        segmentKey,
      })),
    now,
  );
}

// ---- D. CSV ------------------------------------------------------------------------

export interface CsvMapping {
  name: number;
  taxNumber?: number | null;
  website?: number | null;
  city?: number | null;
  phone?: number | null;
}

export function poolRowsFromCsv(rows: string[][], mapping: CsvMapping, segmentKey: string): {
  rows: PoolInput[];
  skipped: Array<{ row: number; reason: string }>;
} {
  const out: PoolInput[] = [];
  const skipped: Array<{ row: number; reason: string }> = [];
  const cell = (r: string[], i: number | null | undefined) => (i === null || i === undefined ? "" : (r[i] ?? "").trim());
  rows.forEach((r, i) => {
    const name = cell(r, mapping.name);
    if (!name) {
      skipped.push({ row: i + 2, reason: "no company name" });
      return;
    }
    const rawTax = cell(r, mapping.taxNumber);
    const tax = rawTax ? cegadatTaxId(rawTax) : null;
    if (rawTax && !tax) {
      skipped.push({ row: i + 2, reason: `"${rawTax}" is not an 11-digit tax number` });
      return;
    }
    out.push({
      name,
      taxNumber: tax,
      website: cell(r, mapping.website) || null,
      city: cell(r, mapping.city) || null,
      phone: cell(r, mapping.phone) || null,
      segmentKey,
    });
  });
  return { rows: out, skipped };
}
