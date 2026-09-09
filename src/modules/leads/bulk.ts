/**
 * What a bulk action DOES, decided in pure code (playbook-v2 P3/2).
 *
 * The server actions carry these decisions out; keeping the decisions here
 * means the score gate — which the playbook requires to hold per lead even when
 * two hundred are moved at once — is provable without a database.
 */

import { foldText } from "../search/fuzzy";
import { columnDef } from "./columns";
import {
  customFieldKey,
  formatValue,
  isCustomFieldRef,
  type FieldDef,
} from "@/modules/fields/types";

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

export interface CsvLead {
  id: string;
  contactName?: string | null;
  title?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  industry?: string | null;
  city?: string | null;
  icpScore?: number | null;
  stage?: string | null;
  signals?: string[];
  source?: string | null;
  ownerName?: string | null;
  lastActivityAt?: Date | string | null;
  createdAt?: Date | string | null;
  /** Owner-defined field values, keyed by definition key (P5/1). */
  customFields?: Record<string, unknown>;
}

/**
 * One cell, formatted the way the table formats it.
 *
 * Exported because CSV is no longer the only way a lead list leaves: the XLSX
 * and the branded PDF read through this same function, so a column cannot mean
 * one thing on screen and another in the file somebody sends on.
 */
export function leadCellValue(
  lead: CsvLead,
  column: string,
  customFields: FieldDef[] = [],
): string {
  // Owner-defined fields (P5/1). Formatted the same way the table cell is, so
  // an export reads like the screen it came from rather than like the JSON
  // underneath it.
  if (isCustomFieldRef(column)) {
    const key = customFieldKey(column);
    const def = customFields.find((d) => d.key === key);
    if (!def) return "";
    return formatValue(def, lead.customFields?.[key] as never);
  }
  const date = (v: Date | string | null | undefined) =>
    v ? new Date(v).toISOString().slice(0, 10) : "";
  switch (column) {
    case "contact":
      return lead.contactName ?? "";
    case "company":
      return lead.company ?? "";
    case "title":
      return lead.title ?? "";
    case "email":
      return lead.email ?? "";
    case "phone":
      return lead.phone ?? "";
    case "industry":
      return lead.industry ?? "";
    case "city":
      return lead.city ?? "";
    case "icpScore":
      return lead.icpScore == null ? "" : String(lead.icpScore);
    case "stage":
      return lead.stage ?? "";
    // Semicolons, not JSON: a spreadsheet is the destination, and `["a","b"]`
    // in a cell helps nobody.
    case "signals":
      return (lead.signals ?? []).join("; ");
    case "source":
      return lead.source ?? "";
    case "owner":
      return lead.ownerName ?? "";
    case "lastActivity":
      return date(lead.lastActivityAt);
    case "created":
      return date(lead.createdAt);
    default:
      return "";
  }
}

/** RFC 4180: quote when the value contains a comma, a quote or a newline. */
function escapeCsv(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Export exactly the columns on screen, in the order they are on screen — the
 * point of exporting a filtered, arranged table is to get that table.
 */
/**
 * The heading a column carries, built-in or Owner-defined. Shared with the
 * other export formats for the same reason `leadCellValue` is.
 */
export function leadColumnLabel(key: string, customFields: FieldDef[] = []): string {
  return isCustomFieldRef(key)
    ? (customFields.find((d) => d.key === customFieldKey(key))?.label ?? customFieldKey(key))
    : (columnDef(key)?.label ?? key);
}

export function buildLeadsCsv(
  leads: CsvLead[],
  columns: string[],
  customFields: FieldDef[] = [],
): string {
  const header = columns
    .map((key) => escapeCsv(leadColumnLabel(key, customFields)))
    .join(",");
  const lines = leads.map((lead) =>
    columns.map((key) => escapeCsv(leadCellValue(lead, key, customFields))).join(","),
  );
  return [header, ...lines].join("\n");
}
