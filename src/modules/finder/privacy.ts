/**
 * Company Finder and personal data (item 7, CLAUDE.md hard rule 9).
 *
 * A finder result is mostly public company data, but three things on it are
 * about people: manager and owner names (on the cached datasheet) and a
 * personal email address (on the result's contacts, when one was found).
 * They follow the same rules as the outbound motor's candidate data:
 *
 *   - retention: result rows untouched for twelve months are deleted, and the
 *     datasheet cache already expires on the motor's schedule;
 *   - erasure: erasing a lead removes that person's address from every
 *     finder result, and their name from the cached datasheet of their
 *     company. Suppression entries are never touched — "do not contact"
 *     outlives the erasure.
 */
import type { Prisma } from "@prisma/client";
import type { WorkspaceClient } from "@/lib/db";
import { cegadatTaxId } from "@/modules/registry/cegadat";
import { reviveDatasheet, serializeDatasheet } from "@/modules/registry/datasheet";
import { parseContacts } from "./evaluate";

export { PERSONAL_DATA_NOTICE } from "./privacy-notice";

const YEAR_MS = 365 * 86_400_000;

export async function purgeFinderResults(db: WorkspaceClient, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - YEAR_MS);
  return (await db.finderResult.deleteMany({ where: { updatedAt: { lt: cutoff } } })).count;
}

const norm = (s: string) => s.normalize("NFC").trim().toLowerCase();

/**
 * Remove one person from the finder's copies of their data. `taxNumber` is
 * the company the person was a lead at, when known: their name is struck
 * from that company's cached datasheet (managers, owners).
 */
export async function eraseFinderPerson(
  db: WorkspaceClient,
  person: { name: string | null; email: string | null; taxNumber: string | null },
): Promise<{ results: number; sheets: number }> {
  let results = 0;
  let sheets = 0;
  const email = person.email ? norm(person.email) : null;

  if (email) {
    let cursor: string | undefined;
    for (;;) {
      const page = await db.finderResult.findMany({
        select: { id: true, contacts: true },
        orderBy: { id: "asc" },
        take: 1000,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1]!.id;
      for (const r of page) {
        const c = parseContacts(r.contacts);
        if (c.email && norm(c.email.value) === email) {
          delete c.email;
          await db.finderResult.update({ where: { id: r.id }, data: { contacts: c as unknown as Prisma.InputJsonValue } });
          results++;
        }
      }
    }
  }

  const tax = person.taxNumber ? cegadatTaxId(person.taxNumber) : null;
  if (tax) {
    const row = await db.registrySheet.findFirst({ where: { taxNumber: tax } });
    const sheet = row && !row.notFound ? reviveDatasheet(row.sheet) : null;
    if (row && sheet) {
      const name = person.name ? norm(person.name) : null;
      const keep = (p: { name: string }) => !name || norm(p.name) !== name;
      const next = {
        ...sheet,
        managers: sheet.managers.filter(keep),
        owners: sheet.owners.filter(keep),
        email: email && sheet.email && norm(sheet.email) === email ? null : sheet.email,
      };
      if (next.managers.length !== sheet.managers.length || next.owners.length !== sheet.owners.length || next.email !== sheet.email) {
        await db.registrySheet.update({ where: { id: row.id }, data: { sheet: serializeDatasheet(next) as Prisma.InputJsonValue } });
        sheets++;
      }
    }
  }
  return { results, sheets };
}
