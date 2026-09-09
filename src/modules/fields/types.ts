/**
 * Owner-defined fields (playbook-v2 P5/1). Pure: the type system, the key
 * rules, the operators each type offers, and the validation.
 *
 * A definition registry plus one typed JSON column per entity, rather than a
 * column per field. A workspace adding a field must not be a migration, and the
 * physical schema has to stay identical across tenants for the tenant guard and
 * the RLS policies to mean anything.
 *
 * Validation is built FROM the definitions with zod, server-side. The client
 * renders whatever inputs the definitions describe, but nothing it sends is
 * trusted: a value that does not match its type, or names an option that does
 * not exist, is refused rather than stored and puzzled over later.
 */

import { z } from "zod";
import type { FilterOperator } from "@/modules/leads/filters";

export const CUSTOM_FIELD_TYPES = [
  "TEXT",
  "NUMBER",
  "DATE",
  "SELECT",
  "MULTISELECT",
  "CHECKBOX",
  "URL",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/**
 * What can carry Owner-defined fields.
 *
 * `task` was added in playbook-v5 P20/2 by EXTENDING this list rather than
 * building a second field system — the playbook is explicit about that, and it
 * means tasks inherit the archived-field behaviour, the value validator, the
 * filter operators and the GDPR handling that already existed.
 */
export const FIELD_ENTITIES = ["lead", "company", "deal", "task"] as const;
export type FieldEntity = (typeof FIELD_ENTITIES)[number];

export const TYPE_LABELS: Record<CustomFieldType, string> = {
  TEXT: "Text",
  NUMBER: "Number",
  DATE: "Date",
  SELECT: "Single select",
  MULTISELECT: "Multi select",
  CHECKBOX: "Checkbox",
  URL: "URL",
};

export const ENTITY_LABELS: Record<FieldEntity, string> = {
  lead: "Lead",
  company: "Company",
  deal: "Deal",
  task: "Task",
};

export interface FieldOption {
  value: string;
  label: string;
}

/** The definition, in the shape the UI and the validator both read. */
export interface FieldDef {
  id: string;
  entity: FieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  options: FieldOption[];
  required: boolean;
  archived: boolean;
  position: number;
  help: string | null;
}

/** The prefix that marks a filter condition or column as a custom field. */
export const CUSTOM_PREFIX = "cf:";

export function customFieldRef(key: string): string {
  return `${CUSTOM_PREFIX}${key}`;
}

export function isCustomFieldRef(field: string): boolean {
  return field.startsWith(CUSTOM_PREFIX);
}

export function customFieldKey(field: string): string {
  return field.slice(CUSTOM_PREFIX.length);
}

// ---- keys ------------------------------------------------------------------

export const MAX_KEY_LENGTH = 40;

/**
 * Turn a label into a stable slug.
 *
 * Hungarian labels are the normal case, so accents fold rather than vanish:
 * "Ügyfél típusa" becomes `ugyfel_tipusa`, not `_`.
 */
export function slugifyKey(label: string): string {
  const folded = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const slug = folded
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_KEY_LENGTH);
  return slug;
}

/** Keys must be usable as JSON keys, URL parameters and column ids. */
export function isValidKey(key: string): boolean {
  return /^[a-z][a-z0-9_]{0,39}$/.test(key);
}

/** A key already taken by a built-in column would shadow it in the table. */
export const RESERVED_KEYS = new Set([
  "id",
  "contact",
  "company",
  "title",
  "email",
  "phone",
  "industry",
  "city",
  "stage",
  "source",
  "owner",
  "signals",
  "created",
  "value",
  "probability",
]);

// ---- operators -------------------------------------------------------------

/**
 * Which filter operators each type offers. Every operator here already exists
 * in the P3/2 engine — a custom field is a new SOURCE of values, not a new kind
 * of comparison, and inventing parallel operators would have given the same
 * question two answers.
 */
export const OPERATORS_BY_TYPE: Record<CustomFieldType, readonly FilterOperator[]> = {
  TEXT: ["contains", "is", "is_set", "is_not_set"],
  URL: ["contains", "is", "is_set", "is_not_set"],
  NUMBER: ["between", "gte", "lte", "is_set", "is_not_set"],
  DATE: ["within_days", "older_than_days", "is_set", "is_not_set"],
  SELECT: ["is", "is_not", "is_any_of", "is_set", "is_not_set"],
  MULTISELECT: ["has_any_of", "has_all_of", "has_none_of", "is_set", "is_not_set"],
  CHECKBOX: ["is_true", "is_false"],
};

/** Types whose values are free text, and therefore worth searching. */
export function isTextual(type: CustomFieldType): boolean {
  return type === "TEXT" || type === "URL";
}

// ---- values ----------------------------------------------------------------

export type FieldValue = string | number | boolean | string[] | null;
export type FieldValues = Record<string, FieldValue>;

const MAX_TEXT = 2000;
const MAX_URL = 2000;

/**
 * A zod schema for ONE field, built from its definition.
 *
 * Null is always accepted and always means "cleared", even on a required field:
 * required is enforced separately (see `validateValues`) so that clearing a
 * value and never having set one produce the same, sayable error rather than a
 * type mismatch.
 */
export function schemaForField(def: FieldDef): z.ZodTypeAny {
  const allowed = new Set(def.options.map((o) => o.value));
  switch (def.type) {
    case "TEXT":
      return z.union([z.string().max(MAX_TEXT), z.null()]);
    case "URL":
      return z.union([
        z
          .string()
          .max(MAX_URL)
          .refine((v) => v === "" || /^https?:\/\/\S+$/i.test(v), {
            message: "must start with http:// or https://",
          }),
        z.null(),
      ]);
    case "NUMBER":
      return z.union([z.number().finite(), z.null()]);
    case "DATE":
      // ISO date (YYYY-MM-DD). Stored as a string, not a Date: the value lives
      // in JSON, and a serialized Date is not portably comparable.
      return z.union([
        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date"),
        z.null(),
      ]);
    case "CHECKBOX":
      return z.union([z.boolean(), z.null()]);
    case "SELECT":
      return z.union([
        z.string().refine((v) => allowed.has(v), { message: "is not one of the options" }),
        z.null(),
      ]);
    case "MULTISELECT":
      return z.union([
        z
          .array(z.string())
          .max(50)
          .refine((vs) => vs.every((v) => allowed.has(v)), {
            message: "contains an option that does not exist",
          }),
        z.null(),
      ]);
  }
}

export interface ValueProblem {
  key: string;
  label: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  /** Only the keys that were supplied and passed, cleaned up. */
  values: FieldValues;
  problems: ValueProblem[];
}

/** An empty string, an empty array and undefined all mean "no value". */
export function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * Validate a partial patch of values against the live definitions.
 *
 * PARTIAL by design: an edit that touches one field must not have to resend
 * every other one, and must not wipe the fields it did not mention. `required`
 * is therefore only enforced on a key that IS present and blank, plus (when
 * `full` is set, as on create) on every required field that is missing.
 *
 * Archived fields accept no new values. Their existing ones stay readable —
 * that is the whole point of archiving instead of deleting — but writing to a
 * field the workspace has retired is almost always a stale form.
 */
export function validateValues(
  defs: FieldDef[],
  patch: Record<string, unknown>,
  opts?: { full?: boolean },
): ValidationResult {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const values: FieldValues = {};
  const problems: ValueProblem[] = [];

  for (const [key, raw] of Object.entries(patch)) {
    const def = byKey.get(key);
    if (!def) {
      problems.push({ key, label: key, message: "is not a field on this workspace" });
      continue;
    }
    if (def.archived) {
      problems.push({ key, label: def.label, message: "is archived and no longer accepts values" });
      continue;
    }

    if (isBlank(raw)) {
      if (def.required) {
        problems.push({ key, label: def.label, message: "is required" });
        continue;
      }
      values[key] = null;
      continue;
    }

    const parsed = schemaForField(def).safeParse(coerce(def, raw));
    if (!parsed.success) {
      problems.push({
        key,
        label: def.label,
        message: parsed.error.issues[0]?.message ?? "is not valid",
      });
      continue;
    }
    values[key] = parsed.data as FieldValue;
  }

  if (opts?.full) {
    for (const def of defs) {
      if (def.archived || !def.required) continue;
      if (!(def.key in patch) || isBlank(patch[def.key])) {
        if (!problems.some((p) => p.key === def.key)) {
          problems.push({ key: def.key, label: def.label, message: "is required" });
        }
      }
    }
  }

  return { ok: problems.length === 0, values, problems };
}

/**
 * Nudge a raw input into the shape its type expects.
 *
 * Form controls and CSV cells both arrive as strings; refusing "42" for a
 * number field would be technically correct and useless.
 */
export function coerce(def: FieldDef, raw: unknown): unknown {
  switch (def.type) {
    case "NUMBER": {
      if (typeof raw === "number") return raw;
      if (typeof raw === "string") {
        // Hungarian decimal comma, and thin/space thousands separators.
        const cleaned = raw.replace(/\s/g, "").replace(",", ".");
        const n = Number(cleaned);
        return Number.isFinite(n) ? n : raw;
      }
      return raw;
    }
    case "CHECKBOX": {
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "string") {
        const v = raw.trim().toLowerCase();
        if (["true", "yes", "igen", "1", "x"].includes(v)) return true;
        if (["false", "no", "nem", "0"].includes(v)) return false;
      }
      return raw;
    }
    case "MULTISELECT": {
      if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
      if (typeof raw === "string") {
        return raw
          .split(/[|,;]/)
          .map((v) => v.trim())
          .filter(Boolean);
      }
      return raw;
    }
    case "DATE": {
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        // Accept a full ISO timestamp and keep only the day.
        const iso = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
        if (iso) return iso[1];
        return trimmed;
      }
      return raw;
    }
    default:
      return typeof raw === "string" ? raw.trim() : raw;
  }
}

/** Read the stored object defensively — a JSON column can hold anything. */
export function readValues(raw: unknown): FieldValues {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as FieldValues;
}

/** Merge a validated patch over the stored values, dropping cleared keys. */
export function mergeValues(current: FieldValues, patch: FieldValues): FieldValues {
  const next: FieldValues = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/** What a value looks like in a table cell, a CSV column or a chip. */
export function formatValue(def: FieldDef, value: FieldValue | undefined): string {
  if (value === null || value === undefined) return "";
  switch (def.type) {
    case "CHECKBOX":
      return value ? "yes" : "no";
    case "MULTISELECT": {
      const labels = (Array.isArray(value) ? value : []).map(
        (v) => def.options.find((o) => o.value === v)?.label ?? v,
      );
      return labels.join(", ");
    }
    case "SELECT":
      return def.options.find((o) => o.value === value)?.label ?? String(value);
    case "NUMBER":
      return typeof value === "number" ? value.toLocaleString("hu-HU") : String(value);
    default:
      return String(value);
  }
}

/** Every textual value on an entity, for the search index (P3/1). */
export function searchableValues(defs: FieldDef[], values: FieldValues): string[] {
  const out: string[] = [];
  for (const def of defs) {
    if (!isTextual(def.type)) continue;
    const v = values[def.key];
    if (typeof v === "string" && v.trim()) out.push(v);
  }
  return out;
}
