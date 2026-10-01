"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { getRegistryProvider, type RegistryCandidate } from "./provider";
import { findByTaxId } from "./dedupe";
import { validateTaxNumber, TAX_NUMBER_REJECTION_TEXT } from "./tax-number";
import { navQueryTaxpayer } from "./nav-taxpayer";
import { resolveNavCredentials } from "@/modules/integrations/resolve";
import { brandFrom } from "@/modules/workspaces/brand";
import { getDatasheet, resolveRegistryApi, searchRegistry } from "./registry-service";
import { candidateFromHit, candidateFromSheet } from "./datasheet-candidate";
import { cegadatTaxId } from "./cegadat";

/**
 * Candidate match (spec §4.19): lookup by the company's adószám, else its name.
 *
 * With Cégadat configured, a known tax number fetches the datasheet — through
 * the registry service, so it is cached for 90 days and charged to the
 * monthly quota as INTERACTIVE — and a name runs the free search. Without it
 * the older provider adapter answers as before.
 */
export async function enrichCompanyLookup(
  companyId: string,
): Promise<{ candidates: RegistryCandidate[]; notice?: string }> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { name: true, taxId: true },
  });
  if (!company) throw new Error("Company not found");

  const api = await resolveRegistryApi(workspaceId);
  if (api) {
    if (company.taxId && cegadatTaxId(company.taxId)) {
      const res = await getDatasheet(workspaceId, company.taxId, { purpose: "INTERACTIVE", userId, api });
      if (res.status === "ok") return { candidates: [candidateFromSheet(res.sheet)] };
      if (res.status === "quota_exhausted") {
        return { candidates: [], notice: "This month's registry lookups are used up — the lookup resumes next month." };
      }
      if (res.status === "not_found") return { candidates: [], notice: "The registry knows no company with this tax number." };
      return { candidates: [], notice: res.message };
    }
    if (company.name.trim().length >= 4) {
      const found = await searchRegistry(workspaceId, { name: company.name, limit: 10 }, { api });
      if (found.ok) return { candidates: found.page.hits.map(candidateFromHit) };
      return { candidates: [], notice: found.message };
    }
    return { candidates: [], notice: "A registry name search needs at least four characters." };
  }

  const candidates = await getRegistryProvider().lookup({
    taxId: company.taxId ?? undefined,
    name: company.name,
  });
  return { candidates };
}

const candidateSchema = z.object({
  legalName: z.string(),
  taxId: z.string(),
  regNumber: z.string().nullable(),
  headcountBand: z.string().nullable(),
  revenueBand: z.string().nullable(),
  statusFlags: z.array(z.string()),
});

/** Confirm → enrich. adószám dedupe blocks if another company already holds it. */
export async function confirmEnrichment(
  companyId: string,
  rawCandidate: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const candidate = candidateSchema.parse(rawCandidate);
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const others = await db.company.findMany({
    where: { NOT: { id: companyId } },
    select: { id: true, taxId: true },
  });
  const clash = findByTaxId(candidate.taxId, others);
  if (clash) {
    return {
      ok: false,
      error: `Another company already has adószám ${candidate.taxId}.`,
    };
  }

  /**
   * The full datasheet, when the registry can give one. A search hit carries
   * no headcount or revenue, so confirming one fetches the sheet — usually a
   * cache hit, because the lookup above may already have paid for it.
   */
  let enriched = candidate;
  const api = await resolveRegistryApi(workspaceId);
  if (api && cegadatTaxId(candidate.taxId)) {
    const res = await getDatasheet(workspaceId, candidate.taxId, { purpose: "INTERACTIVE", userId, api });
    if (res.status === "ok") {
      enriched = candidateFromSheet(res.sheet);
      const current = await db.company.findUnique({
        where: { id: companyId },
        select: { website: true, phone: true, city: true, address: true },
      });
      // Only ever FILLS a blank: a value a person typed is never overwritten.
      await db.company.update({
        where: { id: companyId },
        data: {
          website: current?.website ?? res.sheet.website ?? undefined,
          phone: current?.phone ?? res.sheet.phone ?? undefined,
          city: current?.city ?? res.sheet.seat.city ?? undefined,
          address: current?.address ?? res.sheet.seat.oneLine ?? undefined,
        },
      });
    }
  }

  await db.company.update({ where: { id: companyId }, data: { taxId: enriched.taxId } });
  await db.registryData.upsert({
    where: { companyId },
    create: {
      workspaceId,
      companyId,
      taxId: enriched.taxId,
      regNumber: enriched.regNumber,
      legalName: enriched.legalName,
      headcountBand: enriched.headcountBand,
      revenueBand: enriched.revenueBand,
      statusFlags: enriched.statusFlags,
    },
    update: {
      taxId: enriched.taxId,
      regNumber: enriched.regNumber,
      legalName: enriched.legalName,
      headcountBand: enriched.headcountBand,
      revenueBand: enriched.revenueBand,
      statusFlags: enriched.statusFlags,
      fetchedAt: new Date(),
    },
  });

  revalidatePath("/leads");
  return { ok: true };
}

/**
 * Re-fetch a company's datasheet, bypassing the 90-day cache. Spends exactly
 * one unit of the monthly quota, which is why the UI asks first.
 */
export async function refreshCompanyDatasheet(
  companyId: string,
): Promise<{ ok: true; fetchedAt: string } | { ok: false; error: string }> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const company = await db.company.findUnique({ where: { id: companyId }, select: { taxId: true } });
  if (!company?.taxId || !cegadatTaxId(company.taxId)) {
    return { ok: false, error: "The company has no 11-digit tax number to refresh." };
  }
  const res = await getDatasheet(workspaceId, company.taxId, { purpose: "MANUAL_REFRESH", userId, forceRefresh: true });
  switch (res.status) {
    case "ok": {
      const c = candidateFromSheet(res.sheet);
      await db.registryData.upsert({
        where: { companyId },
        create: { workspaceId, companyId, taxId: c.taxId, regNumber: c.regNumber, legalName: c.legalName, headcountBand: c.headcountBand, revenueBand: c.revenueBand, statusFlags: c.statusFlags },
        update: { regNumber: c.regNumber, legalName: c.legalName, headcountBand: c.headcountBand, revenueBand: c.revenueBand, statusFlags: c.statusFlags, fetchedAt: res.fetchedAt },
      });
      revalidatePath("/leads");
      return { ok: true, fetchedAt: res.fetchedAt.toISOString() };
    }
    case "quota_exhausted":
      return { ok: false, error: "No registry lookups left this month." };
    case "not_found":
      return { ok: false, error: "The registry no longer knows this tax number." };
    default:
      return { ok: false, error: res.message };
  }
}

// ---- Lookup by adószám (NAV queryTaxpayer) ---------------------------------

/**
 * What a tax-number lookup can tell the operator.
 *
 * Deliberately a discriminated union rather than a thrown error: this is called
 * from a client handler, and anything thrown out of a Server Action reaches the
 * browser as a message-less digest.
 */
export type TaxpayerLookup =
  | {
      ok: true;
      /** NAV's own spelling of the legal name — the one a contract must carry. */
      legalName: string;
      shortName: string | null;
      taxNumber: string;
      city: string | null;
      address: string | null;
      /** True when NAV knows the number but the taxpayer is no longer active. */
      deregistered: boolean;
      vatGroupMembership: string | null;
    }
  | { ok: false; error: string };

/**
 * Look a Hungarian adószám up at NAV and hand back what it says.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Everything needed for it was already here — the checksum validator, the
 * signed request builder, the response parser, the credential resolver, all
 * tested — and none of it had a button. The only caller was the integration's
 * "test connection", which looks up the workspace's OWN number.
 *
 * ── THE BOUNDARY ───────────────────────────────────────────────────────────
 *
 * `queryTaxpayer` is READ-ONLY and is the only NAV operation this path may ever
 * use. It creates nothing, submits nothing, and costs nothing. Invoice
 * submission (`manageInvoice`) lives elsewhere, behind its own audited action,
 * and must never be reached from here.
 */
export async function lookupTaxpayer(rawTaxId: unknown): Promise<TaxpayerLookup> {
  const parsed = z.string().trim().min(1).max(40).safeParse(rawTaxId);
  if (!parsed.success) return { ok: false, error: "Adj meg egy adószámot." };

  // The cheap gate first: a malformed number must not cost a request. (The
  // provider checks this too — this one is here to give a SPECIFIC reason.)
  const verdict = validateTaxNumber(parsed.data);
  if (!verdict.ok) {
    return { ok: false, error: TAX_NUMBER_REJECTION_TEXT[verdict.reason] };
  }

  const { workspaceId } = await getActiveContext();
  const brand = brandFrom(
    (
      await prismaUnsafe.workspace.findUnique({
        where: { id: workspaceId },
        select: { brand: true },
      })
    )?.brand,
  );
  const creds = await resolveNavCredentials(workspaceId, brand);
  const lookup = await navQueryTaxpayer(verdict.parts.base, creds, {
    logUsage: async ({ operation, outcome }) => {
      await getWorkspaceClient(workspaceId)
        .apiUsage.create({
          data: { workspaceId, provider: "nav", operation: `${operation}:${outcome}`, cost: 0 },
        })
        .catch(() => {
          /* the lookup's answer matters more than its bookkeeping */
        });
    },
  });

  switch (lookup.status) {
    case "valid":
    case "deregistered":
      return {
        ok: true,
        legalName: lookup.taxpayer.legalName,
        shortName: lookup.taxpayer.shortName,
        taxNumber: lookup.taxpayer.taxNumber,
        city: lookup.taxpayer.seat?.city ?? null,
        address: lookup.taxpayer.seat?.oneLine ?? null,
        deregistered: lookup.status === "deregistered",
        vatGroupMembership: lookup.taxpayer.vatGroupMembership,
      };
    case "unknown":
      return { ok: false, error: "A NAV nem ismeri ezt az adószámot." };
    case "error":
      return { ok: false, error: lookup.message };
  }
}
