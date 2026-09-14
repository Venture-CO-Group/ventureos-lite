/**
 * What a bulk action DOES, decided in pure code (playbook-v2 P3/2).
 *
 * The server actions carry these decisions out; keeping the decisions here
 * means the score gate — which the playbook requires to hold per lead even when
 * two hundred are moved at once — is provable without a database.
 */

import { foldText } from "../search/fuzzy";
import { cellText, exportColumns, type ExportLead } from "./export-columns";
import type { FieldDef } from "@/modules/fields/types";

/**
 * The generic half of a bulk action now lives in `@/lib/bulk` — five more
 * surfaces need the same contract (playbook-v5 P17/1) and it was
 * lead-specific only by location. Re-exported so every existing import of
 * `modules/leads/bulk` keeps working.
 */
export {
  BULK_BATCH_SIZE,
  chunk,
  mergeBulkResults,
  summarizeBulk,
  groupSkipped,
  EMPTY_BULK_RESULT,
} from "@/lib/bulk";
export type { BulkResult, SkippedRow } from "@/lib/bulk";

/** The lead-specific alias the leads module already uses for a skipped row. */
import type { SkippedRow } from "@/lib/bulk";
export type SkippedLead = SkippedRow;

// ---- stage changes --------------------------------------------------------

export interface StageCandidate {
  id: string;
  icpScore: number | null;
  stage: string;
}

export interface StagePlan {
  allowed: string[];
  skipped: SkippedLead[];
}

/**
 * Decide which of these leads may enter `toStage`.
 *
 * The score gate (CLAUDE.md hard rule #5) applies to each lead individually —
 * a bulk move is not a way around it. Leads that fail are SKIPPED and named,
 * never silently dropped and never allowed to fail the whole batch: refusing
 * 200 moves because one lead scores 2 would be useless.
 */
export function planStageChange(
  rows: StageCandidate[],
  toStage: string,
  threshold: number,
): StagePlan {
  const allowed: string[] = [];
  const skipped: SkippedLead[] = [];

  for (const row of rows) {
    if (row.stage === toStage) {
      // Counting these as moved would inflate the report with work not done.
      skipped.push({ id: row.id, reason: "already in that stage" });
      continue;
    }
    if (toStage === "CONTACTED" && (row.icpScore === null || row.icpScore < threshold)) {
      skipped.push({
        id: row.id,
        reason:
          row.icpScore === null
            ? `below the score gate (unscored, gate is ${threshold})`
            : `below the score gate (${row.icpScore} < ${threshold})`,
      });
      continue;
    }
    allowed.push(row.id);
  }

  return { allowed, skipped };
}

// ---- signal tags ----------------------------------------------------------

/**
 * Tags are compared folded — case- and accent-insensitively — because
 * "Régi weboldal" and "regi weboldal" are the same tag to everyone except a
 * string comparison, and letting both exist means every filter over signals
 * starts missing half its leads.
 */
function sameTag(a: string, b: string): boolean {
  return foldText(a) === foldText(b);
}

export function addSignals(existing: string[], toAdd: string[]): string[] {
  const out = [...existing];
  for (const raw of toAdd) {
    const tag = raw.trim();
    if (!tag) continue;
    // Keep the spelling the lead already had rather than overwriting it with
    // whatever was typed into the bulk box just now.
    if (out.some((e) => sameTag(e, tag))) continue;
    out.push(tag);
  }
  return out;
}

export function removeSignals(existing: string[], toRemove: string[]): string[] {
  const drop = toRemove.map((t) => t.trim()).filter(Boolean);
  if (drop.length === 0) return [...existing];
  return existing.filter((e) => !drop.some((d) => sameTag(e, d)));
}

// ---- CSV ------------------------------------------------------------------

/**
 * One lead, flattened for export.
 *
 * The shape itself now lives with the column registry that reads it
 * (`export-columns.ts`), so a field cannot be added to the row without the
 * column that carries it being visible in the same file. Re-exported under its
 * historical name because half the leads module imports it.
 */
export type CsvLead = ExportLead;

/**
 * RFC 4180: quote when the value contains a comma, a quote or a newline.
 *
 * The newline case is not theoretical — a person summary and a notes field both
 * hold prose somebody typed with Enter in it, and an unquoted line break turns
 * one lead into two malformed rows for every row after it.
 */
function escapeCsv(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The whole lead record as CSV, in the registry's order.
 *
 * No column list argument: an export carries the record, not whatever subset of
 * it the table happened to be showing. That was the bug — a default table of
 * five columns produced a five-column file, and the other fifteen things we
 * know about a lead silently did not leave the building.
 *
 * Rows are joined with CRLF, which is what RFC 4180 specifies and what keeps a
 * quoted multi-line cell unambiguous for the stricter readers.
 */
export function buildLeadsCsv(leads: CsvLead[], customFields: FieldDef[] = []): string {
  const defs = exportColumns("csv", customFields);
  const header = defs.map((d) => escapeCsv(d.label)).join(",");
  const lines = leads.map((lead) =>
    defs.map((d) => escapeCsv(cellText(d, lead))).join(","),
  );
  return [header, ...lines].join("\r\n");
}

/** The BOM Excel needs before it will read UTF-8 accents correctly. */
export const CSV_BOM = "\ufeff";

/** The CSV as bytes, BOM included — the one place that decision is made. */
export function leadsCsvBuffer(leads: CsvLead[], customFields: FieldDef[] = []): Buffer {
  return Buffer.from(CSV_BOM + buildLeadsCsv(leads, customFields), "utf8");
}
