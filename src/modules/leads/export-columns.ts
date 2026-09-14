/**
 * THE lead-export column registry — one definition per field, read by all three
 * exporters.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 *
 * The three formats already shared a value resolver, so they never disagreed
 * about what a column CONTAINED. What they did not share was the rest of a
 * column's identity, and that was spread over three files: the label lived in
 * `columns.ts`, the resolver in `bulk.ts`, and the set of fields the database
 * actually loaded in `bulk-store.ts`. Adding one field meant three edits in
 * three files, and forgetting the third produced an empty cell rather than an
 * error — which is exactly how the export ended up carrying five of the
 * twenty-odd things we know about a lead.
 *
 * So a column is now ONE object: what to call it, how to get it, what type it
 * is, and which formats carry it. `loadLeadsForExport` fills one row shape,
 * every exporter walks one list. A new field is added here and appears in the
 * CSV, the spreadsheet and the document at once, or in none of them.
 *
 * ── WHY THE TABLE REGISTRY STAYS SEPARATE ───────────────────────────────────
 *
 * `columns.ts` is still its own list, and deliberately: it carries sort fields,
 * narrow-screen behaviour and a column picker, none of which an export has, and
 * its labels are the table's ("Lead" over the name column, where an export
 * wants "Name"). The two registries overlap in KEYS, and the resolvers live
 * here, so the values can still never drift — which was the actual risk.
 */

import { customFieldRef, formatValue, type FieldDef } from "@/modules/fields/types";
import { CRITERION_LABELS, ICP_CRITERIA, type IcpCriterion } from "./scoring";

export const EXPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * What a cell IS, as opposed to how it prints.
 *
 * The formats need this because they can each do something better than a
 * string: a spreadsheet sorts a number numerically and filters a real date by
 * month, and a document can make a URL clickable. A single "everything is a
 * string" projection was what made the ICP column sort 10 before 2.
 */
export type ExportCellKind = "text" | "longtext" | "number" | "date" | "url";

/** The typed value behind a cell. `null` is the empty cell — never "N/A". */
export type ExportCell = string | number | Date | null;

/** Where a column sits in the PDF, which cannot fit the whole record. */
export type PdfPlacement = "table" | "subrow";

export interface ExportColumnDef {
  key: string;
  label: string;
  kind: ExportCellKind;
  /** Which formats carry this column. */
  formats: readonly ExportFormat[];
  /**
   * PDF only: in the table row, or in the wrapped block beneath it. A long
   * summary squeezed into a table cell is truncated into uselessness, so it
   * gets its own full-width row instead.
   */
  pdf?: PdfPlacement;
  resolve: (lead: ExportLead) => ExportCell;
}

const ALL: readonly ExportFormat[] = EXPORT_FORMATS;
const SHEETS: readonly ExportFormat[] = ["csv", "xlsx"];

/**
 * One lead, flattened — exactly the fields the registry below resolves from.
 *
 * Flat rather than nested because the joins differ per field (company, latest
 * audit, last outbound touch) and a resolver that had to know which relation a
 * value came from would put the query shape back into the column list.
 */
export interface ExportLead {
  id: string;
  contactName?: string | null;
  title?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  /** Company domain, falling back to its website when only that is known. */
  domain?: string | null;
  industry?: string | null;
  city?: string | null;
  /** Adószám, from the company record or its registry enrichment. */
  taxId?: string | null;
  icpScore?: number | null;
  /** The per-criterion ICP breakdown, as stored on the lead. */
  scoreBreakdown?: unknown;
  stage?: string | null;
  signals?: string[];
  source?: string | null;
  ownerName?: string | null;
  /** Latest completed website audit for this lead's company, if any. */
  auditScore?: number | null;
  auditAt?: Date | string | null;
  /**
   * The stored Claude brief about the person. READ ONLY — an export never
   * generates one (CLAUDE.md rule #3: no AI on a page load or a save, and an
   * export is neither a research run nor a manual trigger).
   */
  personBrief?: string | null;
  notes?: string | null;
  createdAt?: Date | string | null;
  lastActivityAt?: Date | string | null;
  /** Latest outbound touch — a sent message, a logged email or a call. */
  lastContactedAt?: Date | string | null;
  /** Owner-defined field values, keyed by definition key (P5/1). */
  customFields?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// value helpers
// ---------------------------------------------------------------------------

/**
 * Empty is empty. Never the string "null", "undefined" or "N/A".
 *
 * Line endings are normalised to LF on the way out. A summary typed on Windows
 * arrives with CRLF, and XML — which is what an XLSX is made of — normalises
 * CRLF to LF when it is read back. Leaving it alone means the spreadsheet and
 * the CSV hold genuinely different bytes for the same field, which is exactly
 * the drift between formats this module exists to prevent.
 */
function str(v: string | null | undefined): string | null {
  const t = v?.replace(/\r\n?/g, "\n").trim();
  return t ? t : null;
}

function dateOf(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Enum values as a person reads them: `SELF_SERVE_AUDIT` → "Self serve audit".
 *
 * Generic rather than a lookup table so a source or a stage added to the schema
 * exports readably on the day it is added, instead of exporting blank until
 * somebody remembers this file.
 */
function humanize(v: string | null | undefined): string | null {
  const t = str(v);
  if (!t) return null;
  const words = t.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The ICP breakdown as "Segment fit: yes; Decision-maker: no".
 *
 * Spelled out rather than dumped as JSON: the column exists so somebody can see
 * WHY a lead scored 2, and `{"segment_fit":1}` in a spreadsheet cell answers
 * that question for nobody.
 */
export function formatScoreBreakdown(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ICP_CRITERIA) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    parts.push(`${CRITERION_LABELS[key as IcpCriterion]}: ${v ? "yes" : "no"}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------

/**
 * Every built-in export column, in the order it appears in a file.
 *
 * The order is the reading order of a lead record: who they are, how to reach
 * them, where they work, what we think of them, where they are in the pipeline,
 * what we know, and when things happened.
 */
export const EXPORT_COLUMNS: readonly ExportColumnDef[] = [
  {
    key: "contact",
    label: "Name",
    kind: "text",
    formats: ALL,
    pdf: "table",
    resolve: (l) => str(l.contactName),
  },
  {
    key: "title",
    label: "Job title",
    kind: "text",
    formats: ALL,
    pdf: "table",
    resolve: (l) => str(l.title),
  },
  {
    key: "company",
    label: "Company",
    kind: "text",
    formats: ALL,
    pdf: "table",
    resolve: (l) => str(l.company),
  },
  {
    key: "email",
    label: "Email",
    kind: "text",
    formats: ALL,
    pdf: "table",
    resolve: (l) => str(l.email),
  },
  {
    key: "phone",
    label: "Phone",
    kind: "text",
    formats: ALL,
    pdf: "table",
    resolve: (l) => str(l.phone),
  },
  {
    key: "linkedinUrl",
    label: "LinkedIn URL",
    kind: "url",
    formats: SHEETS,
    resolve: (l) => str(l.linkedinUrl),
  },
  {
    key: "domain",
    label: "Website",
    kind: "url",
    formats: SHEETS,
    resolve: (l) => str(l.domain),
  },
  {
    key: "industry",
    label: "Industry",
    kind: "text",
    formats: SHEETS,
    resolve: (l) => str(l.industry),
  },
  {
    key: "city",
    label: "City",
    kind: "text",
    formats: SHEETS,
    resolve: (l) => str(l.city),
  },
  {
    key: "taxId",
    label: "Tax number",
    kind: "text",
    formats: SHEETS,
    resolve: (l) => str(l.taxId),
  },
  {
    key: "icpScore",
    label: "ICP score",
    kind: "number",
    formats: ALL,
    pdf: "table",
    resolve: (l) => (l.icpScore == null ? null : l.icpScore),
  },
  {
    key: "scoreBreakdown",
    label: "Score breakdown",
    kind: "text",
    formats: SHEETS,
    resolve: (l) => formatScoreBreakdown(l.scoreBreakdown),
  },
  {
    // Comma-separated, as the export contract asks. Safe in a CSV because every
    // value is quoted when it needs to be — see `escapeCsv`.
    key: "signals",
    label: "Signals",
    kind: "text",
    formats: SHEETS,
    resolve: (l) => str((l.signals ?? []).join(", ")),
  },
  {
    key: "stage",
    label: "Stage",
    kind: "text",
    formats: ALL,
    pdf: "table",
    resolve: (l) => humanize(l.stage),
  },
  {
    key: "owner",
    label: "Owner",
    kind: "text",
    formats: SHEETS,
    resolve: (l) => str(l.ownerName),
  },
  {
    key: "source",
    label: "Source",
    kind: "text",
    formats: SHEETS,
    resolve: (l) => humanize(l.source),
  },
  {
    key: "auditScore",
    label: "Audit score",
    kind: "number",
    formats: SHEETS,
    resolve: (l) => (l.auditScore == null ? null : l.auditScore),
  },
  {
    key: "auditDate",
    label: "Audit date",
    kind: "date",
    formats: SHEETS,
    resolve: (l) => dateOf(l.auditAt),
  },
  {
    key: "personBrief",
    label: "Person summary",
    kind: "longtext",
    formats: ALL,
    pdf: "subrow",
    resolve: (l) => str(l.personBrief),
  },
  {
    key: "created",
    label: "Created",
    kind: "date",
    formats: SHEETS,
    resolve: (l) => dateOf(l.createdAt),
  },
  {
    key: "lastActivity",
    label: "Last activity",
    kind: "date",
    formats: SHEETS,
    resolve: (l) => dateOf(l.lastActivityAt),
  },
  {
    key: "lastContacted",
    label: "Last contacted",
    kind: "date",
    formats: SHEETS,
    resolve: (l) => dateOf(l.lastContactedAt),
  },
  {
    key: "notes",
    label: "Notes",
    kind: "longtext",
    formats: SHEETS,
    resolve: (l) => str(l.notes),
  },
] as const;

/** Columns whose text wraps rather than sitting on one line. */
export function isWrapped(def: ExportColumnDef): boolean {
  return def.kind === "longtext";
}

/**
 * One Owner-defined field as an export column (P5/1).
 *
 * Formatted through the same `formatValue` the record and the table use, so a
 * custom field reads the same everywhere. Sheets only: the PDF's table is
 * already at its readable width with the core columns alone.
 */
function customColumn(def: FieldDef): ExportColumnDef {
  return {
    key: customFieldRef(def.key),
    label: def.label,
    kind: "text",
    formats: SHEETS,
    resolve: (l) => str(formatValue(def, l.customFields?.[def.key] as never)),
  };
}

/**
 * The columns one format carries, built-ins then Owner-defined fields.
 *
 * This is the ONLY way an exporter should learn what to write. Passing a list
 * of keys in from the caller is what let the on-screen column selection decide
 * what an export contained — which is why an export of a table showing five
 * columns was a file containing five columns, rather than the lead record.
 */
export function exportColumns(
  format: ExportFormat,
  customFields: FieldDef[] = [],
): ExportColumnDef[] {
  const builtin = EXPORT_COLUMNS.filter((c) => c.formats.includes(format));
  const custom = customFields
    // Archived fields still export if a lead carries a value, for the same
    // reason a saved view keeps rendering them: the data is real.
    .map(customColumn)
    .filter((c) => c.formats.includes(format));
  return [...builtin, ...custom];
}

/** The PDF's table columns, in order. */
export function pdfTableColumns(): ExportColumnDef[] {
  return EXPORT_COLUMNS.filter((c) => c.formats.includes("pdf") && c.pdf === "table");
}

/** The PDF's per-lead sub-row columns, in order. */
export function pdfSubrowColumns(): ExportColumnDef[] {
  return EXPORT_COLUMNS.filter((c) => c.formats.includes("pdf") && c.pdf === "subrow");
}

export function exportColumnDef(key: string): ExportColumnDef | undefined {
  return EXPORT_COLUMNS.find((c) => c.key === key);
}

// ---------------------------------------------------------------------------
// projections
// ---------------------------------------------------------------------------

/** ISO `YYYY-MM-DD`, the machine-readable form CSV and XLSX carry. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The locale the PDF prints dates in.
 *
 * Day-month-year, which is what both Hungarian and European English readers
 * expect and what the rest of the product's documents use. The CSV and the
 * spreadsheet stay ISO — those are read by machines and by sort functions.
 */
export const PDF_DATE_LOCALE = "en-GB";

export function localDate(d: Date): string {
  return d.toLocaleDateString(PDF_DATE_LOCALE);
}

/**
 * A cell as text — the projection CSV writes and the PDF prints.
 *
 * `iso` because the two differ on exactly one thing: a spreadsheet wants a
 * sortable date and a document wants a readable one.
 */
export function cellText(
  def: ExportColumnDef,
  lead: ExportLead,
  opts: { iso?: boolean } = {},
): string {
  const v = def.resolve(lead);
  if (v === null) return "";
  if (v instanceof Date) return opts.iso === false ? localDate(v) : isoDate(v);
  return String(v);
}

/**
 * A cell as a typed value, for the spreadsheet.
 *
 * Numbers stay numbers and dates stay dates so Excel sorts and filters them as
 * what they are. Everything else is a string.
 */
export function cellValue(def: ExportColumnDef, lead: ExportLead): ExportCell {
  return def.resolve(lead);
}
