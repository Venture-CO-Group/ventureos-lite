/**
 * The Company Finder export's columns (item 6). One registry, read by the
 * column picker, the CSV writer and the XLSX writer — a column is added here
 * and appears in all three, or in none. Client-safe.
 *
 * `kind` decides how a cell is typed in the spreadsheet: numbers as numbers,
 * dates as dates, URLs and addresses as hyperlinks. In CSV every cell is
 * text, and an empty value is an empty cell — never "null", never "0".
 */
import type { FinderRow } from "./row";

export type ColumnKind = "text" | "number" | "date" | "url" | "email" | "bool";

export interface FinderColumn {
  key: string;
  label: string;
  kind: ColumnKind;
  /** In the picker's default selection. */
  default: boolean;
  /** Only an Owner, with the explicit toggle, may export it. */
  ownerOnly?: boolean;
  /** Personal data under GDPR — named in the export dialog's notice. */
  personal?: boolean;
  get: (r: FinderRow) => string | number | boolean | null;
}

const list = (xs: string[]) => (xs.length ? xs.join("; ") : null);
const SOURCE_LABEL = { registry: "registry", impresszum: "impresszum", crm: "CRM" } as const;

export const FINDER_COLUMNS: readonly FinderColumn[] = [
  { key: "legalName", label: "Legal name", kind: "text", default: true, get: (r) => r.legalName || null },
  { key: "shortName", label: "Short name", kind: "text", default: true, get: (r) => r.shortName },
  { key: "legalForm", label: "Legal form", kind: "text", default: true, get: (r) => r.legalForm },
  { key: "taxNumber", label: "Tax number", kind: "text", default: true, get: (r) => r.taxNumber },
  { key: "registryNumber", label: "Registry number", kind: "text", default: true, get: (r) => r.registryNumber },
  { key: "statisticalCode", label: "Statistical code", kind: "text", default: true, get: (r) => r.statisticalCode },
  { key: "county", label: "County", kind: "text", default: true, get: (r) => r.county },
  { key: "zip", label: "Postcode", kind: "text", default: true, get: (r) => r.zip },
  { key: "city", label: "City", kind: "text", default: true, get: (r) => r.city },
  { key: "street", label: "Street", kind: "text", default: true, get: (r) => r.street },
  { key: "fullAddress", label: "Full address", kind: "text", default: true, get: (r) => r.fullAddress },
  { key: "foundedAt", label: "Founded", kind: "date", default: true, get: (r) => r.foundedAt },
  { key: "status", label: "Status", kind: "text", default: true, get: (r) => r.status },
  { key: "principalActivity", label: "Principal activity", kind: "text", default: true, get: (r) => r.principalActivity },
  { key: "activities", label: "All activities", kind: "text", default: true, get: (r) => list(r.activities) },
  { key: "netRevenue", label: "Net revenue (HUF)", kind: "number", default: true, get: (r) => r.netRevenue },
  { key: "equity", label: "Shareholders' equity (HUF)", kind: "number", default: true, get: (r) => r.equity },
  { key: "operatingProfit", label: "Operating profit (HUF)", kind: "number", default: true, get: (r) => r.operatingProfit },
  { key: "preTaxProfit", label: "Pre-tax profit (HUF)", kind: "number", default: true, get: (r) => r.preTaxProfit },
  { key: "totalAssets", label: "Total assets (HUF)", kind: "number", default: true, get: (r) => r.totalAssets },
  { key: "reportDate", label: "Report date", kind: "date", default: true, get: (r) => r.reportDate },
  { key: "employeeCount", label: "Employees", kind: "number", default: true, get: (r) => r.employeeCount },
  { key: "employeeCountDate", label: "Employees as of", kind: "date", default: true, get: (r) => r.employeeCountDate },
  { key: "owners", label: "Owners", kind: "text", default: true, personal: true, get: (r) => list(r.owners) },
  { key: "managers", label: "Managers", kind: "text", default: true, personal: true, get: (r) => list(r.managers) },
  { key: "email", label: "Email", kind: "email", default: true, personal: true, get: (r) => r.email },
  { key: "phone", label: "Phone", kind: "text", default: true, get: (r) => r.phone },
  { key: "website", label: "Website", kind: "url", default: true, get: (r) => r.website },
  { key: "emailSource", label: "Email source", kind: "text", default: true, get: (r) => (r.emailSource ? SOURCE_LABEL[r.emailSource] : null) },
  { key: "phoneSource", label: "Phone source", kind: "text", default: true, get: (r) => (r.phoneSource ? SOURCE_LABEL[r.phoneSource] : null) },
  { key: "websiteSource", label: "Website source", kind: "text", default: true, get: (r) => (r.websiteSource ? SOURCE_LABEL[r.websiteSource] : null) },
  { key: "fetchedAt", label: "Datasheet fetched", kind: "date", default: true, get: (r) => r.fetchedAt?.slice(0, 10) ?? null },
  { key: "inCrm", label: "Already in CRM", kind: "bool", default: true, get: (r) => r.inCrm },
  { key: "sizeBand", label: "Size band", kind: "text", default: false, get: (r) => r.sizeBand?.toLowerCase() ?? null },
  {
    key: "bankAccounts",
    label: "Bank accounts",
    kind: "text",
    default: false,
    ownerOnly: true,
    get: (r) => (r.bankAccounts?.length ? r.bankAccounts.map((b) => [b.accountNumber, b.bankName].filter(Boolean).join(" ")).join("; ") : null),
  },
];

export const DEFAULT_COLUMN_KEYS: readonly string[] = FINDER_COLUMNS.filter((c) => c.default).map((c) => c.key);

/** The chosen columns, in registry order; unknown keys are dropped. */
export function pickColumns(keys: readonly string[]): FinderColumn[] {
  const want = new Set(keys);
  return FINDER_COLUMNS.filter((c) => want.has(c.key));
}
