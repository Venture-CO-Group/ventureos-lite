/**
 * Optional contact enrichment (item 4): for matches that lack an email or a
 * phone — and for companies refused ONLY for the contact requirement, which
 * this step may rescue — read the company's own site (homepage + imprint /
 * contact page) with the outbound motor's site reader, and fill the blanks.
 *
 * Only steps that cost nothing run here: no registry lookup, no paid address
 * verification. Every value keeps its source — registry, impresszum or crm —
 * and a later source never overwrites an earlier one.
 */
import type { Prisma } from "@prisma/client";
import { getWorkspaceClient } from "@/lib/db";
import { normalizeEmail } from "@/modules/capture/contact";
import { isGenericDomain } from "@/modules/email/matching";
import { isRoleAddress } from "@/modules/outbound/contact";
import { domainOf } from "@/modules/outbound/pool";
import { contactVerdict, parseCriteria } from "./criteria";
import { mergeContacts, parseContacts, type FinderContacts } from "./evaluate";
import { loadWorkspaceFacts } from "./engine";

export interface SiteContacts {
  emails: string[];
  phones: string[];
}

export interface ContactDeps {
  readSite: (url: string) => Promise<SiteContacts | null>;
  now: () => Date;
  /** Sites per pass. */
  perPass?: number;
}

/**
 * Where to look for a company's site: its registry website, else the domain
 * of its registry email — unless that is a free-mail domain, which says
 * nothing about the company.
 */
export function siteFor(contacts: FinderContacts): string | null {
  if (contacts.website) return contacts.website.value;
  const domain = contacts.email ? (contacts.email.value.split("@")[1] ?? "").toLowerCase() : "";
  return domain && !isGenericDomain(domain) ? `https://${domain}` : null;
}

/**
 * The best address on a site for a company list: one on the company's own
 * domain, a shared inbox first (info@, iroda@ — it is the company's address,
 * not a person's), then anything else on the domain.
 */
export function pickEmail(emails: string[], domain: string | null): string | null {
  const clean = emails.map((e) => normalizeEmail(e).value).filter((e): e is string => !!e);
  const own = domain ? clean.filter((e) => (e.split("@")[1] ?? "").replace(/^www\./, "") === domain) : clean;
  return own.find((e) => isRoleAddress(e)) ?? own[0] ?? null;
}

export async function enrichListContacts(
  workspaceId: string,
  listId: string,
  deps: ContactDeps,
): Promise<{ checked: number; filled: number; rescued: number; remaining: number }> {
  const db = getWorkspaceClient(workspaceId);
  const list = await db.finderList.findUnique({ where: { id: listId } });
  if (!list) return { checked: 0, filled: 0, rescued: 0, remaining: 0 };
  const criteria = parseCriteria(list.criteria);
  const facts = await loadWorkspaceFacts(db);

  const rows = await db.finderResult.findMany({
    where: {
      listId,
      siteChecked: false,
      OR: [{ state: "MATCH" }, { state: "NO_MATCH", reason: "CONTACT" }],
    },
    orderBy: { priority: "desc" },
    take: deps.perPass ?? 25,
  });
  let filled = 0;
  let rescued = 0;
  for (const r of rows) {
    const contacts = parseContacts(r.contacts);
    if (contacts.email && contacts.phone) {
      await db.finderResult.update({ where: { id: r.id }, data: { siteChecked: true } });
      continue;
    }
    const layers: FinderContacts[] = [contacts];
    const url = siteFor(contacts);
    const domain = domainOf(url);
    if (url) {
      let site: SiteContacts | null = null;
      try {
        site = await deps.readSite(url);
      } catch {
        site = null;
      }
      if (site) {
        const layer: FinderContacts = {};
        const email = pickEmail(site.emails, domain);
        if (email) layer.email = { value: email, source: "impresszum" };
        if (site.phones[0]) layer.phone = { value: site.phones[0], source: "impresszum" };
        // A site we could read is a website the company has, even when the
        // registry did not list it.
        if (!contacts.website && (site.emails.length || site.phones.length)) layer.website = { value: url, source: "impresszum" };
        layers.push(layer);
      }
    }
    // The CRM: a contact we already hold at the same domain.
    const crm = domain ? facts.crmContacts.get(domain) : undefined;
    if (crm) {
      layers.push({
        ...(crm.email ? { email: { value: crm.email, source: "crm" as const } } : {}),
        ...(crm.phone ? { phone: { value: crm.phone, source: "crm" as const } } : {}),
      });
    }
    const merged = mergeContacts(...layers);
    const changed = JSON.stringify(merged) !== JSON.stringify(contacts);
    if (changed) filled++;

    const data: Prisma.FinderResultUpdateInput = { siteChecked: true, contacts: merged as unknown as Prisma.InputJsonValue };
    // A company refused only for its contacts may now meet the requirement.
    if (r.state === "NO_MATCH" && r.reason === "CONTACT") {
      const missing = contactVerdict(criteria.contactRequirement, {
        hasEmail: !!merged.email,
        hasPhone: !!merged.phone,
        hasWebsite: !!merged.website,
      });
      if (!missing) {
        Object.assign(data, { state: "MATCH", reason: null, detail: null });
        rescued++;
      } else data.detail = missing;
    }
    await db.finderResult.update({ where: { id: r.id }, data });
  }
  const remaining = await db.finderResult.count({
    where: { listId, siteChecked: false, OR: [{ state: "MATCH" }, { state: "NO_MATCH", reason: "CONTACT" }] },
  });
  return { checked: rows.length, filled, rescued, remaining };
}
