/**
 * What a person can do with Company Finder results (item 5), session-free so
 * the actions and the tests share it. Each operation takes result ids, reads
 * them back through the tenant-guarded client — an id from another workspace
 * simply is not found — and acts only on rows of the given list.
 */
import type { Prisma } from "@prisma/client";
import type { WorkspaceClient } from "@/lib/db";
import { cegadatTaxId, formatTaxNumber } from "@/modules/registry/cegadat";
import { reviveDatasheet } from "@/modules/registry/datasheet";
import { taxSuppressionEntry } from "@/modules/mail/suppression";
import { domainOf } from "@/modules/outbound/pool";
import { upsertPool } from "@/modules/outbound/sources";
import { stringArray } from "@/modules/outbound/catalog";
import { resolveSizeBand } from "@/modules/outbound/size-band";
import { parseContacts } from "./evaluate";

async function resultsWithSheets(db: WorkspaceClient, listId: string, ids: string[]) {
  const results = await db.finderResult.findMany({ where: { listId, id: { in: ids } } });
  const sheets = new Map(
    (await db.registrySheet.findMany({ where: { taxNumber: { in: results.map((r) => r.taxNumber) }, notFound: false } })).map((s) => [
      s.taxNumber,
      reviveDatasheet(s.sheet),
    ]),
  );
  return results.map((r) => ({ result: r, sheet: sheets.get(r.taxNumber) ?? null, contacts: parseContacts(r.contacts) }));
}

export interface LeadsOutcome {
  created: number;
  skipped: Array<{ name: string; reason: string }>;
  leadIds: string[];
}

/**
 * Add results to the CRM as leads (source COMPANY_FINDER). A company already
 * in the CRM with a lead is skipped, not duplicated; a company without a lead
 * gets one. The contact name is the first registered manager — public
 * registry data — and the address and phone come with their recorded source
 * in the notes.
 */
export async function addResultsAsLeads(
  db: WorkspaceClient,
  workspaceId: string,
  listId: string,
  ids: string[],
  hooks: { onCreated?: (leadId: string) => Promise<void> } = {},
): Promise<LeadsOutcome> {
  const out: LeadsOutcome = { created: 0, skipped: [], leadIds: [] };
  const list = await db.finderList.findUnique({ where: { id: listId }, select: { name: true } });
  for (const { result: r, sheet, contacts } of await resultsWithSheets(db, listId, ids)) {
    const name = sheet?.shortName ?? sheet?.legalName ?? r.name;
    if (r.state !== "MATCH") {
      out.skipped.push({ name, reason: "not a match" });
      continue;
    }
    const tax = cegadatTaxId(r.taxNumber)!;
    const website = contacts.website?.value ?? sheet?.website ?? null;
    const domain = domainOf(website);
    let company =
      (await db.company.findFirst({ where: { taxId: { in: [tax, formatTaxNumber(tax)] }, mergedIntoId: null } })) ??
      (domain ? await db.company.findFirst({ where: { domain, mergedIntoId: null } }) : null);
    if (company && (await db.lead.count({ where: { companyId: company.id, mergedIntoId: null } })) > 0) {
      out.skipped.push({ name, reason: "already in the CRM" });
      continue;
    }
    if (!company) {
      const band = sheet ? resolveSizeBand({ employeeCount: sheet.employeeCount, netRevenue: sheet.netRevenue }).band : null;
      company = await db.company.create({
        data: {
          workspaceId,
          name,
          taxId: tax,
          website,
          domain,
          phone: contacts.phone?.value ?? null,
          city: sheet?.seat.city ?? null,
          address: sheet?.seat.oneLine ?? null,
          industry: sheet?.principalActivity ? [sheet.principalActivity.code, sheet.principalActivity.label].filter(Boolean).join(" ") : null,
          sizeBand: band,
          source: "company_finder",
        },
      });
      if (sheet) {
        await db.registryData.upsert({
          where: { companyId: company.id },
          create: {
            workspaceId,
            companyId: company.id,
            taxId: tax,
            regNumber: sheet.registryNumber,
            legalName: sheet.legalName,
            headcountBand: sheet.employeeCount !== null ? `${sheet.employeeCount} employees` : null,
            revenueBand: sheet.netRevenue !== null ? `${sheet.netRevenue.toString()} Ft` : null,
            statusFlags: [],
          },
          update: {},
        });
      }
    }
    const sources = (["email", "phone", "website"] as const)
      .filter((k) => contacts[k])
      .map((k) => `${k}: ${contacts[k]!.source}`)
      .join(", ");
    const lead = await db.lead.create({
      data: {
        workspaceId,
        companyId: company.id,
        contactName: sheet?.managers[0]?.name ?? null,
        email: contacts.email?.value ?? null,
        phone: contacts.phone?.value ?? null,
        source: "COMPANY_FINDER",
        stage: "RESEARCHED",
        notes: `Company Finder · ${list?.name ?? "list"}${sources ? ` · contact sources — ${sources}` : ""}`,
        lastActivityAt: new Date(),
      },
    });
    await db.finderResult.update({ where: { id: r.id }, data: { inCrm: true } });
    out.created++;
    out.leadIds.push(lead.id);
    if (hooks.onCreated) await hooks.onCreated(lead.id);
  }
  return out;
}

/**
 * Hand results to an outbound product as candidates: into the shared pool,
 * tagged with the profile's first segment, so the product's next run draws
 * on them — through the whole motor, hook gate and approval included.
 * Nothing is drafted or sent from here (hard rule 2).
 */
export async function sendResultsToOutbound(
  db: WorkspaceClient,
  workspaceId: string,
  listId: string,
  ids: string[],
  profileId: string,
  now: Date = new Date(),
): Promise<{ ok: true; created: number; updated: number; segmentKey: string } | { ok: false; error: string }> {
  const profile = await db.icpProfile.findUnique({ where: { id: profileId } });
  if (!profile) return { ok: false, error: "That profile no longer exists." };
  const segmentKey = stringArray(profile.segmentKeys)[0];
  if (!segmentKey) return { ok: false, error: "That profile has no segment — give it one on the product page first." };
  const rows = (await resultsWithSheets(db, listId, ids))
    .filter(({ result }) => result.state === "MATCH")
    .map(({ result, sheet, contacts }) => ({
      taxNumber: result.taxNumber,
      name: sheet?.shortName ?? sheet?.legalName ?? result.name,
      status: sheet?.status ?? null,
      website: contacts.website?.value ?? null,
      phone: contacts.phone?.value ?? null,
      city: sheet?.seat.city ?? null,
      segmentKey,
    }));
  if (rows.length === 0) return { ok: false, error: "None of the selected rows is a match." };
  const res = await upsertPool(db, workspaceId, "COMPANY_FINDER", rows, now);
  return { ok: true, ...res, segmentKey };
}

/**
 * Put results on the shared suppression list by tax number — the company
 * itself, so every channel (cold campaigns, the motor, a future finder run)
 * skips it. The rows leave the match set at once.
 */
export async function suppressResults(
  db: WorkspaceClient,
  workspaceId: string,
  listId: string,
  ids: string[],
): Promise<{ added: number }> {
  const results = await db.finderResult.findMany({ where: { listId, id: { in: ids } }, select: { id: true, taxNumber: true } });
  let added = 0;
  for (const r of results) {
    const address = taxSuppressionEntry(r.taxNumber);
    const existing = await db.suppression.findUnique({ where: { workspaceId_address: { workspaceId, address } } });
    if (!existing) {
      await db.suppression.create({ data: { workspaceId, address, reason: "company_finder" } });
      added++;
    }
  }
  await db.finderResult.updateMany({
    where: { listId, id: { in: results.map((r) => r.id) } },
    data: { state: "NO_MATCH", reason: "SUPPRESSED", detail: "added to the suppression list from the results" } satisfies Prisma.FinderResultUpdateManyMutationInput,
  });
  return { added };
}
