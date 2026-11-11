/**
 * One Company Finder result, flattened: what the results table shows, what
 * the live filters read, and what the export writes. Client-safe (types and
 * pure helpers only) — the server builds rows in rows-load.ts.
 *
 * Money crosses to the browser as a plain number of forints (exact far past
 * any real revenue), never as a float of millions.
 */
import type { FilterSubject } from "./criteria";
import type { ContactSource } from "./evaluate";

export interface FinderRow {
  id: string;
  taxNumber: string;
  legalName: string;
  shortName: string | null;
  legalForm: string | null;
  registryNumber: string | null;
  statisticalCode: string | null;
  county: string | null;
  zip: string | null;
  city: string | null;
  street: string | null;
  fullAddress: string | null;
  foundedAt: string | null;
  status: string | null;
  principalActivity: string | null;
  principalCode: string | null;
  activities: string[];
  activityCodes: string[];
  netRevenue: number | null;
  equity: number | null;
  operatingProfit: number | null;
  preTaxProfit: number | null;
  totalAssets: number | null;
  reportDate: string | null;
  employeeCount: number | null;
  employeeCountDate: string | null;
  owners: string[];
  managers: string[];
  email: string | null;
  phone: string | null;
  website: string | null;
  emailSource: ContactSource | null;
  phoneSource: ContactSource | null;
  websiteSource: ContactSource | null;
  fetchedAt: string | null;
  inCrm: boolean;
  sizeBand: string | null;
  foundByKeyword: boolean;
  /** Present only when the caller may see them (Owner, explicit toggle). */
  bankAccounts?: Array<{ bankName: string | null; accountNumber: string; effectiveFrom: string | null }>;
}

export function subjectFromRow(r: FinderRow): FilterSubject {
  return {
    name: `${r.legalName} ${r.shortName ?? ""}`,
    status: r.status,
    legalForm: r.legalForm,
    principalCode: r.principalCode,
    activityCodes: r.activityCodes,
    employeeCount: r.employeeCount,
    netRevenue: r.netRevenue,
    county: r.county,
    city: r.city,
    foundedAt: r.foundedAt,
    hasEmail: !!r.email,
    hasPhone: !!r.phone,
    hasWebsite: !!r.website,
    foundByKeyword: r.foundByKeyword,
  };
}

export interface Coverage {
  email: number;
  phone: number;
  website: number;
}

/** Share of rows (0–1) with each contact channel. */
export function coverage(rows: readonly FinderRow[]): Coverage {
  if (rows.length === 0) return { email: 0, phone: 0, website: 0 };
  const share = (f: (r: FinderRow) => boolean) => rows.filter(f).length / rows.length;
  return { email: share((r) => !!r.email), phone: share((r) => !!r.phone), website: share((r) => !!r.website) };
}
