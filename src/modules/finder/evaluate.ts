/**
 * One company against one list: datasheet → filter subject → verdict, plus
 * the contact fields with the source each came from. Pure; the engine feeds
 * it the workspace's CRM and suppression data.
 */
import type { CompanyDatasheet } from "@/modules/registry/datasheet";
import { activityCodes } from "@/modules/registry/datasheet";
import { isCompanySuppressed } from "@/modules/mail/suppression";
import { domainOf } from "@/modules/outbound/pool";
import { cegadatTaxId } from "@/modules/registry/cegadat";
import {
  contactVerdict,
  finderFilter,
  nameHasKeyword,
  type FilterSegment,
  type FilterSubject,
  type FinderCriteria,
  type FinderReason,
} from "./criteria";

export type ContactSource = "registry" | "impresszum" | "crm";
export interface ContactField {
  value: string;
  source: ContactSource;
}
export interface FinderContacts {
  email?: ContactField;
  phone?: ContactField;
  website?: ContactField;
}

export function parseContacts(raw: unknown): FinderContacts {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const field = (v: unknown): ContactField | undefined => {
    if (!v || typeof v !== "object") return undefined;
    const f = v as Record<string, unknown>;
    return typeof f.value === "string" && f.value && (f.source === "registry" || f.source === "impresszum" || f.source === "crm")
      ? { value: f.value, source: f.source }
      : undefined;
  };
  const out: FinderContacts = {};
  const e = field(o.email);
  const p = field(o.phone);
  const w = field(o.website);
  if (e) out.email = e;
  if (p) out.phone = p;
  if (w) out.website = w;
  return out;
}

/**
 * Fill blanks only, in the order given: the registry first, then whatever a
 * later step found. A later source never overwrites an earlier one — the
 * registry's own entry is what the company filed.
 */
export function mergeContacts(...layers: FinderContacts[]): FinderContacts {
  const out: FinderContacts = {};
  for (const l of layers) {
    if (!out.email && l.email) out.email = l.email;
    if (!out.phone && l.phone) out.phone = l.phone;
    if (!out.website && l.website) out.website = l.website;
  }
  return out;
}

export function registryContacts(sheet: CompanyDatasheet): FinderContacts {
  const out: FinderContacts = {};
  if (sheet.email) out.email = { value: sheet.email, source: "registry" };
  if (sheet.phone) out.phone = { value: sheet.phone, source: "registry" };
  if (sheet.website) out.website = { value: sheet.website, source: "registry" };
  return out;
}

export function subjectFromSheet(sheet: CompanyDatasheet, contacts: FinderContacts, foundByKeyword: boolean): FilterSubject {
  const codes = activityCodes(sheet);
  const rev = sheet.netRevenue;
  return {
    name: sheet.legalName || sheet.shortName || "",
    status: sheet.status,
    legalForm: sheet.legalForm,
    principalCode: sheet.principalActivity?.code || null,
    activityCodes: codes,
    employeeCount: sheet.employeeCount,
    netRevenue: rev === null ? null : Number(rev),
    county: sheet.seat.county,
    city: sheet.seat.city,
    foundedAt: sheet.foundedAt,
    hasEmail: !!contacts.email,
    hasPhone: !!contacts.phone,
    hasWebsite: !!contacts.website,
    foundByKeyword,
  };
}

/** What the evaluation needs from the workspace, loaded once per pass. */
export interface WorkspaceFacts {
  crmTax: Set<string>;
  crmDomains: Set<string>;
  suppressed: string[];
  /** A CRM contact per company domain — a free contact source. */
  crmContacts: Map<string, { email: string | null; phone: string | null }>;
}

export interface Evaluation {
  state: "MATCH" | "NO_MATCH";
  reason: FinderReason | null;
  detail: string | null;
  contacts: FinderContacts;
  inCrm: boolean;
}

export function evaluateSheet(
  criteria: FinderCriteria,
  sheet: CompanyDatasheet,
  segments: readonly FilterSegment[],
  facts: WorkspaceFacts,
  opts: { foundByKeyword: boolean; extraContacts?: FinderContacts },
): Evaluation {
  const tax = cegadatTaxId(sheet.taxNumber);
  const domain = domainOf(sheet.website);
  const inCrm = (!!tax && facts.crmTax.has(tax)) || (!!domain && facts.crmDomains.has(domain));

  const crm = domain ? facts.crmContacts.get(domain) : undefined;
  const crmLayer: FinderContacts = {};
  if (crm?.email) crmLayer.email = { value: crm.email, source: "crm" };
  if (crm?.phone) crmLayer.phone = { value: crm.phone, source: "crm" };
  const contacts = mergeContacts(registryContacts(sheet), opts.extraContacts ?? {}, crmLayer);

  const keywordHit = opts.foundByKeyword || nameHasKeyword(`${sheet.legalName} ${sheet.shortName ?? ""}`, criteria.keywords);

  if (criteria.excludeInCrm && inCrm) {
    return { state: "NO_MATCH", reason: "IN_CRM", detail: `already in the CRM (${tax ? `tax ${tax}` : domain})`, contacts, inCrm };
  }
  if (
    criteria.excludeSuppressed &&
    isCompanySuppressed({ domain, taxNumber: tax, emails: contacts.email ? [contacts.email.value] : [] }, facts.suppressed)
  ) {
    return { state: "NO_MATCH", reason: "SUPPRESSED", detail: "on the suppression list", contacts, inCrm };
  }
  const subject = subjectFromSheet(sheet, contacts, keywordHit);
  const v = finderFilter(criteria, subject, segments, { skipContact: true });
  if (!v.ok) return { state: "NO_MATCH", reason: v.reason, detail: v.detail, contacts, inCrm };
  const missing = contactVerdict(criteria.contactRequirement, subject);
  if (missing) return { state: "NO_MATCH", reason: "CONTACT", detail: missing, contacts, inCrm };
  return { state: "MATCH", reason: null, detail: null, contacts, inCrm };
}
