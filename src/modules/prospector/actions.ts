"use server";

import { z } from "zod";
import { normalizePhone } from "@/modules/capture/contact";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { emitLeadCreated } from "@/modules/webhooks/emit";
import { getPlacesClient, PLACES_PAGE_SIZE, PLACES_MAX_RESULTS } from "@/lib/places";
import { geocodeLocation } from "@/lib/geocode";
import { parseRadiusMeters } from "@/lib/geo";
import { resolveIntegration } from "@/modules/integrations/resolve";
import { callClaude } from "@/lib/ai/call-claude";
import { BudgetExceededError } from "@/lib/ai/budget";
import {
  PROSPECT_CLASSIFY_SYSTEM,
  prospectClassificationSchema,
  buildClassifyMessage,
  type ProspectClassification,
} from "@/lib/ai/prompts/prospect-classify";
import { classifyWebsite } from "./website";
import { googleSignals } from "./signals";
import { CLASSIFY_BATCH, batchStarts, resolveBatchIndices } from "./classify";
import { enrichCompanySite } from "../leads/enrichment";
import { TEXT_SEARCH_COST_USD } from "./cost";
import { isCacheFresh, CACHE_TTL_DAYS } from "./cache";
import { normalizeDomain } from "../leads/dedupe";
import { findProspectDuplicate } from "./dedupe";
import type { ProspectRow, ProspectSearchResult, SavedSearch } from "./types";

const searchSchema = z.object({
  keyword: z.string().min(1),
  location: z.string().min(1),
  radius: z.string().optional(),
  /** Google pages at 20 and stops at 60; the UI offers 20/40/60. */
  maxResults: z.number().int().min(1).max(PLACES_MAX_RESULTS).optional(),
});

function summarize(
  keyword: string,
  location: string,
  rows: ProspectRow[],
  radiusM?: number | null,
): string {
  const noWebsite = rows.filter((r) => r.presence !== "has").length;
  const within = radiusM ? ` within ${Math.round(radiusM / 100) / 10} km` : "";
  return `${rows.length} ${keyword} found in ${location}${within} · ${noWebsite} have no or weak website`;
}

export async function runProspectSearch(raw: unknown): Promise<ProspectSearchResult> {
  const input = searchSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  // Workspace key if configured, else the env one.
  const placesKey = await resolveIntegration(workspaceId, "google.placesApiKey");

  /**
   * THE RADIUS, WHICH USED TO GO NOWHERE.
   *
   * Text Search takes an area, not a place name, so the location has to be
   * geocoded first — one extra request per distinct town, cached for a day.
   * When that fails the search still runs, unbounded, and says so: pretending a
   * radius was applied is exactly how this control came to be decorative.
   */
  const radiusM = parseRadiusMeters(input.radius);
  let notice: string | null = null;
  let area: { center: { lat: number; lng: number }; radiusM: number } | null = null;
  if (radiusM) {
    const center = await geocodeLocation(input.location, placesKey, workspaceId);
    if (center) {
      area = { center, radiusM };
    } else {
      notice = `Radius ignored — "${input.location}" could not be placed on the map, so the search covers wherever Google reads that name.`;
    }
  }

  // 30-day cache: don't re-purchase the same area from the Places API.
  const cached = await db.prospectSearch.findFirst({
    where: {
      keywords: input.keyword,
      location: input.location,
      radius: input.radius ?? null,
    },
    orderBy: { ranAt: "desc" },
  });
  if (cached && isCacheFresh(cached.ranAt, new Date())) {
    const results = (cached.results as ProspectRow[] | null) ?? [];
    // Serve the cache only if it can satisfy the depth being asked for. A
    // count that is an exact multiple of the page size means the previous run
    // stopped at a page boundary and deeper pages were never fetched; a
    // partial last page means the area is genuinely exhausted, so re-running
    // would spend money to return the same rows.
    const want = input.maxResults ?? PLACES_PAGE_SIZE;
    const exhausted = results.length % PLACES_PAGE_SIZE !== 0;
    /**
     * A row cached before the request asked for language, place ids and address
     * components is not the same row.
     *
     * Serving it would keep handing back anglicised names — "Mathe Dentistry"
     * for "Máthé Fogászat Debrecen" — and cityless, un-dedupable leads for up to
     * thirty days after the fix shipped. The place id is the marker: present on
     * every row fetched since, on none fetched before.
     */
    const currentShape = results.length === 0 || results.every((r) => r.placeId);
    if (currentShape && (results.length >= want || exhausted)) {
      return {
        fromCache: true,
        searchId: cached.id,
        results,
        summary: summarize(input.keyword, input.location, results, area?.radiusM),
        costUsd: 0,
        notice,
      };
    }
  }

  const search = await getPlacesClient(placesKey).textSearch({ ...input, area });
  const results: ProspectRow[] = search.results.map((r) => ({
    ...r,
    presence: classifyWebsite(r.websiteUri),
  }));
  const costUsd = search.requestCount * TEXT_SEARCH_COST_USD;

  const now = new Date();
  const rec = await db.prospectSearch.create({
    data: {
      workspaceId,
      keywords: input.keyword,
      location: input.location,
      radius: input.radius,
      cost: costUsd,
      results,
      ranAt: now,
      expiresAt: new Date(now.getTime() + CACHE_TTL_DAYS * 86_400_000),
    },
  });

  revalidatePath("/prospector");
  return {
    fromCache: false,
    searchId: rec.id,
    results,
    summary: summarize(input.keyword, input.location, results, area?.radiusM),
    costUsd,
    notice,
  };
}


const addSchema = z.object({
  placeId: z.string().nullish(),
  name: z.string().min(1),
  category: z.string().nullish(),
  phone: z.string().nullish(),
  websiteUri: z.string().nullish(),
  address: z.string().nullish(),
  city: z.string().nullish(),
  businessStatus: z.string().nullish(),
  rating: z.number().nullish(),
  reviews: z.number().nullish(),
});

export async function addProspectAsLead(
  raw: unknown,
): Promise<{ ok: true; leadId: string } | { ok: false; duplicateOf: string }> {
  const input = addSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const existing = await db.company.findMany({
    select: { id: true, domain: true, phone: true, googlePlaceId: true },
  });
  const dup = findProspectDuplicate(
    {
      placeId: input.placeId ?? null,
      domain: input.websiteUri ?? null,
      phone: input.phone ?? null,
    },
    existing.map((e) => ({ ...e, placeId: e.googlePlaceId })),
  );
  if (dup) return { ok: false, duplicateOf: dup.id };

  /**
   * Stored in the SAME shape the rest of the system writes.
   *
   * Places says "06 30 130 2223" and site enrichment writes "+36301302223" for
   * one phone; keeping Google's spelling meant the company row and the lead row
   * disagreed about the number, and the duplicate check compared them as two
   * different strings.
   */
  const companyPhone = normalizePhone(input.phone).value ?? input.phone ?? null;

  const company = await db.company.create({
    data: {
      workspaceId,
      name: input.name,
      domain: normalizeDomain(input.websiteUri) ?? undefined,
      // The full URI as well as the bare domain: enrichment prefers `website`
      // when it is there, and a site living on a path is not reachable from the
      // hostname alone.
      website: input.websiteUri ?? undefined,
      phone: companyPhone ?? undefined,
      industry: input.category ?? undefined,
      address: input.address ?? undefined,
      // The town, straight out of Google's addressComponents. It was never
      // requested from the API, so the City field on a prospected lead was empty
      // on 70 of the 71 companies here — every one of which had an address.
      city: input.city ?? undefined,
      googlePlaceId: input.placeId ?? undefined,
    },
  });
  /**
   * Unnamed contact — filled in later (spec §4.3) — but NOT contactless.
   *
   * The phone went onto the company and stopped there, so a prospected lead
   * opened with an empty Phone field even though Google had just handed us one.
   * It is the same number either way; putting it on the lead is where the
   * operator actually looks for it.
   *
   * Normalised on the way in, so a Places "+36 1 234 5678" and a pasted
   * "06 1 234 5678" end up as the same stored value rather than as two leads.
   */
  const leadPhone = normalizePhone(input.phone).value;

  /**
   * THE EMAIL GOOGLE DOES NOT HAVE.
   *
   * The Places API carries no email field for any business, at any billing
   * tier — so a prospected lead arrived with an empty Email field and stayed
   * that way until somebody ran research on it. The address is on the company's
   * own site, usually in the impresszum, and reading it is a request we already
   * know how to make politely.
   *
   * Bounded on purpose: only when Google gave a website at all, one homepage
   * plus at most one contact page, robots.txt honoured, and the result cached on
   * the company for thirty days — so the research run that follows does not pay
   * for the same page twice.
   */
  const site = company.domain || company.website ? await enrichCompanySite(company.id) : null;
  const siteEmail = site?.contacts?.emails[0] ?? null;
  const sitePhone = site?.contacts?.phones[0] ?? null;

  const lead = await db.lead.create({
    data: {
      workspaceId,
      companyId: company.id,
      source: "PROSPECTOR",
      stage: "RESEARCHED",
      phone: leadPhone ?? sitePhone ?? undefined,
      email: siteEmail ?? undefined,
      signals: googleSignals(input),
    },
  });

  // Google had no number but the site did — the company row should say so too.
  if (!companyPhone && sitePhone) {
    await db.company.update({ where: { id: company.id }, data: { phone: sitePhone } });
  }

  await emitLeadCreated(workspaceId, lead.id);
  revalidatePath("/leads");
  return { ok: true, leadId: lead.id };
}

/**
 * Classify every row, not the first screenful.
 *
 * ── WHAT THIS REPLACED ─────────────────────────────────────────────────────
 *
 * `rows.slice(0, 25)`, with no notice anywhere. Run a 60-result search and the
 * button — which says "1 Haiku call / 25 rows", implying three calls — made
 * ONE, classified 25 rows, and left 35 sitting there unmarked with no
 * explanation. The operator's reasonable reading was that Claude had judged
 * those 35 and found nothing to say.
 *
 * Now it batches through all of them and REPORTS what it managed, including
 * when the daily budget stops it partway: the batches already paid for are kept
 * rather than thrown away with the error.
 */
export async function classifyProspects(
  searchId: string,
): Promise<{ classified: number; total: number; note: string | null }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const search = await db.prospectSearch.findUnique({ where: { id: searchId } });
  if (!search) throw new Error("Search not found");

  const rows = (search.results as ProspectRow[] | null) ?? [];
  const byIndex = new Map<number, { fit: "strong" | "possible" | "skip"; priority: number }>();
  let note: string | null = null;

  for (const start of batchStarts(rows.length)) {
    const slice = rows.slice(start, start + CLASSIFY_BATCH);
    // Batch-local indices: the model answers about 0..24 every time, exactly as
    // it did when there was only ever one batch, and the offset is applied here.
    const batch = slice.map((r, index) => ({
      index,
      name: r.name,
      category: r.category,
      website: r.presence,
    }));

    let classification: ProspectClassification;
    try {
      const { data } = await callClaude({
        useCase: "prospect_classify",
        workspaceId,
        system: PROSPECT_CLASSIFY_SYSTEM,
        messages: [{ role: "user", content: buildClassifyMessage(batch) }],
        schema: prospectClassificationSchema,
      });
      classification = data as ProspectClassification;
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        note = `Stopped at ${byIndex.size} of ${rows.length}: ${e.message}`;
        break;
      }
      throw e;
    }

    // The offset is applied here, and an index the model invented is dropped
    // rather than allowed to land on another batch's row.
    for (const { row, item } of resolveBatchIndices(classification.items, start, slice.length)) {
      byIndex.set(row, { fit: item.fit, priority: item.priority });
    }
  }

  const merged: ProspectRow[] = rows.map((r, i) => {
    const c = byIndex.get(i);
    return c ? { ...r, classification: c } : r;
  });
  await db.prospectSearch.update({
    where: { id: searchId },
    data: { results: merged },
  });

  revalidatePath("/prospector");
  return { classified: byIndex.size, total: rows.length, note };
}
