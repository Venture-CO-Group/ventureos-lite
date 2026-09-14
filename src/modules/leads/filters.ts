/**
 * The leads filter engine (playbook-v2 P3/2). Pure — no I/O, no Prisma — so
 * every operator is provable in a unit test.
 *
 * WHY IT EVALUATES IN TYPESCRIPT RATHER THAN IN SQL. Three of the fields the
 * playbook asks for cannot be expressed portably in a Prisma `where`:
 *
 *   - `signals` is a Json array (it has to be: CLAUDE.md forbids Postgres-only
 *     scalar lists, because the schema must also run on MySQL 8);
 *   - text matching has to be accent- and typo-tolerant to be worth anything on
 *     Hungarian names, which is precisely why P3/1 exists — and P3/1 already
 *     settled that this belongs in TypeScript rather than in raw SQL, since raw
 *     SQL bypasses the mandatory tenant guard;
 *   - "last activity older than N days" against a NULL means "never touched",
 *     which is the opposite of what SQL's three-valued logic does with it.
 *
 * Splitting the work — some predicates in SQL, some here — would also break
 * pagination, because a database LIMIT cannot know how many rows the in-memory
 * pass is about to discard. One pass over a workspace's leads keeps `total`,
 * `pageCount` and "select all matching" exactly consistent with each other.
 *
 * ⚠️ THE LIMIT, same as `search/fuzzy.ts`: this is linear in leads per
 * workspace. Comfortable to ~50,000; the product targets 5,000 (playbook P6).
 * Past that, revisit — but fix the RLS gap first, so raw SQL is not the only
 * thing standing between a query and another tenant's rows.
 */

import { foldText, scoreFields } from "../search/fuzzy";

// ---- shape ----------------------------------------------------------------

/** The flattened row the engine reasons about — see `toFilterableLead`. */
export interface FilterableLead {
  id: string;
  contactName: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  industry: string | null;
  city: string | null;
  icpScore: number | null;
  stage: string;
  signals: string[];
  source: string;
  ownerId: string | null;
  lastActivityAt: Date | null;
  createdAt: Date;
  /**
   * Owner-defined field values, keyed by definition key (P5/1). Absent on rows
   * loaded by callers that do not care about them, which is why every custom
   * branch below treats "no object" the same as "no value".
   */
  customFields?: Record<string, unknown>;
}

export const FILTER_FIELDS = [
  "text",
  "stage",
  "icpScore",
  "industry",
  "city",
  "signals",
  "source",
  "owner",
  "lastActivityAge",
  "hasEmail",
  "hasPhone",
] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export const FILTER_OPERATORS = [
  "is",
  "is_not",
  "is_any_of",
  "contains",
  "matches",
  "gte",
  "lte",
  "between",
  "is_set",
  "is_not_set",
  "has_any_of",
  "has_all_of",
  "has_none_of",
  "within_days",
  "older_than_days",
  "is_true",
  "is_false",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface FilterCondition {
  /**
   * A built-in FilterField, or `cf:<key>` for an Owner-defined field (P5/1).
   * Typed as a plain string because the custom set is per workspace and only
   * knowable at runtime; `evaluateCondition` refuses anything it cannot resolve.
   */
  field: FilterField | string;
  operator: FilterOperator;
  value?: string | number | null;
  values?: string[];
  min?: number;
  max?: number;
}

export interface FilterSet {
  match: "all" | "any";
  conditions: FilterCondition[];
}

export const EMPTY_FILTER_SET: FilterSet = { match: "all", conditions: [] };

/** Which operators the UI offers per field — also what the zod schema allows. */
export const OPERATORS_BY_FIELD: Record<FilterField, readonly FilterOperator[]> = {
  text: ["matches"],
  stage: ["is", "is_not", "is_any_of"],
  icpScore: ["between", "gte", "lte", "is_set", "is_not_set"],
  industry: ["contains", "is", "is_set", "is_not_set"],
  city: ["contains", "is", "is_set", "is_not_set"],
  signals: ["has_any_of", "has_all_of", "has_none_of", "is_set", "is_not_set"],
  source: ["is", "is_not", "is_any_of"],
  owner: ["is", "is_not", "is_set", "is_not_set"],
  lastActivityAge: ["within_days", "older_than_days", "is_not_set"],
  hasEmail: ["is_true", "is_false"],
  hasPhone: ["is_true", "is_false"],
};

export const FIELD_LABELS: Record<FilterField, string> = {
  text: "Any text",
  stage: "Stage",
  icpScore: "ICP score",
  industry: "Industry",
  city: "City",
  signals: "Signals",
  source: "Source",
  owner: "Owner",
  lastActivityAge: "Last activity",
  hasEmail: "Has email",
  hasPhone: "Has phone",
};

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  is: "is",
  is_not: "is not",
  is_any_of: "is any of",
  contains: "contains",
  matches: "matches",
  gte: "is at least",
  lte: "is at most",
  between: "is between",
  is_set: "is set",
  is_not_set: "is not set",
  has_any_of: "has any of",
  has_all_of: "has all of",
  has_none_of: "has none of",
  within_days: "within the last (days)",
  older_than_days: "older than (days)",
  is_true: "yes",
  is_false: "no",
};

/**
 * The operators a field offers, built-in or custom.
 *
 * One function rather than two lookups at every call site: the filter builder,
 * the URL parser and the saved-view validator all have to agree on what a
 * coherent condition is, and three copies of that rule would eventually be two.
 */
export function operatorsForField(
  field: string,
  customFields?: readonly CustomFieldSpec[],
): readonly FilterOperator[] {
  if (field.startsWith("cf:")) {
    const def = customFields?.find((d) => d.key === field.slice(3));
    return def ? CUSTOM_OPERATORS_BY_TYPE[def.type] : [];
  }
  return OPERATORS_BY_FIELD[field as FilterField] ?? [];
}

/** What the chip and the dropdown call this field. */
export function labelForField(
  field: string,
  customFields?: ReadonlyArray<CustomFieldSpec & { label?: string }>,
): string {
  if (field.startsWith("cf:")) {
    const key = field.slice(3);
    return customFields?.find((d) => d.key === key)?.label ?? key.replace(/_/g, " ");
  }
  return FIELD_LABELS[field as FilterField] ?? field;
}

/**
 * Mirrors `fields/types.ts` OPERATORS_BY_TYPE.
 *
 * Duplicated deliberately rather than imported: `filters.ts` is the engine and
 * has no dependencies, and importing the fields module here would make the pure
 * filter unit tests pull in zod. A unit test asserts the two stay identical.
 */
const CUSTOM_OPERATORS_BY_TYPE: Record<CustomFieldSpec["type"], readonly FilterOperator[]> = {
  TEXT: ["contains", "is", "is_set", "is_not_set"],
  URL: ["contains", "is", "is_set", "is_not_set"],
  NUMBER: ["between", "gte", "lte", "is_set", "is_not_set"],
  DATE: ["within_days", "older_than_days", "is_set", "is_not_set"],
  SELECT: ["is", "is_not", "is_any_of", "is_set", "is_not_set"],
  MULTISELECT: ["has_any_of", "has_all_of", "has_none_of", "is_set", "is_not_set"],
  CHECKBOX: ["is_true", "is_false"],
};

// ---- helpers --------------------------------------------------------------

/** Present means non-null AND not whitespace — a blank column is absence. */
function present(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/** Accent- and case-insensitive substring test, per the P3/1 folding rules. */
function foldedContains(field: string | null, needle: string): boolean {
  return foldText(field).includes(foldText(needle));
}

function foldedEquals(a: string | null, b: string): boolean {
  return foldText(a) === foldText(b);
}

/** The fields free-text search looks at. Mirrors what the P3/1 box searches. */
function searchableFields(lead: FilterableLead): Array<string | null> {
  return [lead.contactName, lead.company, lead.email, lead.title, lead.industry, lead.city];
}

function ageInDays(at: Date | null, now: Date): number | null {
  if (!at) return null;
  return (now.getTime() - at.getTime()) / 86_400_000;
}

function asNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---- evaluation -----------------------------------------------------------

/**
 * Evaluate one condition. An operator that does not apply to the field, or a
 * condition missing the value it needs, returns TRUE — an incomplete row in the
 * filter builder must not silently empty the table while the user is still
 * typing it. Validation rejects malformed conditions before they are saved;
 * this is about the half-built ones on screen.
 */
export function evaluateCondition(
  lead: FilterableLead,
  c: FilterCondition,
  now: Date,
  customFields?: readonly CustomFieldSpec[],
): boolean {
  const values = c.values ?? [];

  // Owner-defined fields (P5/1). Evaluated by the definition's TYPE rather than
  // by the operator alone, so "contains" on a multi-select cannot quietly do
  // something a text field's "contains" would.
  if (typeof c.field === "string" && c.field.startsWith("cf:")) {
    const key = c.field.slice(3);
    const def = customFields?.find((d) => d.key === key);
    // An unknown field is inert rather than exclusionary: a saved view written
    // before a field was archived must not silently empty the table.
    if (!def) return true;
    return evaluateCustom(lead.customFields?.[key], def, c, now);
  }

  switch (c.field) {
    case "text": {
      if (!present(String(c.value ?? ""))) return true;
      return scoreFields(String(c.value), searchableFields(lead)) > 0;
    }

    case "stage":
    case "source": {
      const actual = c.field === "stage" ? lead.stage : lead.source;
      if (c.operator === "is_any_of") {
        return values.length === 0 || values.includes(actual);
      }
      if (!present(String(c.value ?? ""))) return true;
      const isMatch = actual === String(c.value);
      return c.operator === "is_not" ? !isMatch : isMatch;
    }

    case "icpScore": {
      const score = lead.icpScore;
      if (c.operator === "is_set") return score !== null;
      if (c.operator === "is_not_set") return score === null;
      // An unscored lead is unknown, not zero (P1/1d made the same call). Any
      // numeric comparison against "unknown" is false, so that "score below 3"
      // does not quietly return every lead nobody has researched yet.
      if (score === null) return false;
      if (c.operator === "between") {
        const min = asNumber(c.min);
        const max = asNumber(c.max);
        if (min === null && max === null) return true;
        return (min === null || score >= min) && (max === null || score <= max);
      }
      const bound = asNumber(c.value);
      if (bound === null) return true;
      if (c.operator === "gte") return score >= bound;
      if (c.operator === "lte") return score <= bound;
      return true;
    }

    case "industry":
    case "city": {
      const actual = c.field === "industry" ? lead.industry : lead.city;
      if (c.operator === "is_set") return present(actual);
      if (c.operator === "is_not_set") return !present(actual);
      if (!present(String(c.value ?? ""))) return true;
      if (c.operator === "is") return foldedEquals(actual, String(c.value));
      return foldedContains(actual, String(c.value));
    }

    case "signals": {
      const held = lead.signals.map(foldText);
      if (c.operator === "is_set") return held.length > 0;
      if (c.operator === "is_not_set") return held.length === 0;
      if (values.length === 0) return true;
      const wanted = values.map(foldText);
      if (c.operator === "has_all_of") return wanted.every((w) => held.includes(w));
      if (c.operator === "has_none_of") return !wanted.some((w) => held.includes(w));
      return wanted.some((w) => held.includes(w));
    }

    case "owner": {
      const owner = lead.ownerId;
      if (c.operator === "is_set") return owner !== null;
      if (c.operator === "is_not_set") return owner === null;
      if (!present(String(c.value ?? ""))) return true;
      const isMatch = owner === String(c.value);
      return c.operator === "is_not" ? !isMatch : isMatch;
    }

    case "lastActivityAge": {
      const age = ageInDays(lead.lastActivityAt, now);
      if (c.operator === "is_not_set") return age === null;
      const days = asNumber(c.value);
      if (days === null) return true;
      // A lead nobody ever touched is older than every window and inside none.
      // Finding neglected leads is what this filter is for, so excluding the
      // most neglected ones would defeat it.
      if (age === null) return c.operator === "older_than_days";
      return c.operator === "within_days" ? age <= days : age > days;
    }

    case "hasEmail":
    case "hasPhone": {
      const has = present(c.field === "hasEmail" ? lead.email : lead.phone);
      return c.operator === "is_false" ? !has : has;
    }

    default:
      return true;
  }
}

/** The slice of a field definition the evaluator needs. */
export interface CustomFieldSpec {
  key: string;
  type: "TEXT" | "NUMBER" | "DATE" | "SELECT" | "MULTISELECT" | "CHECKBOX" | "URL";
}

/**
 * One custom-field condition.
 *
 * Deliberately mirrors the built-in branches rather than sharing them: the
 * built-ins read named properties, and threading a dynamic accessor through
 * them would have made every existing case harder to read for the benefit of
 * one new one.
 */
function evaluateCustom(
  raw: unknown,
  def: CustomFieldSpec,
  c: FilterCondition,
  now: Date,
): boolean {
  const set = !(
    raw === null ||
    raw === undefined ||
    (typeof raw === "string" && raw.trim() === "") ||
    (Array.isArray(raw) && raw.length === 0)
  );
  if (c.operator === "is_set") return set;
  if (c.operator === "is_not_set") return !set;

  switch (def.type) {
    case "CHECKBOX": {
      const on = raw === true;
      return c.operator === "is_false" ? !on : on;
    }
    case "NUMBER": {
      if (!set) return false;
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) return false;
      if (c.operator === "between") {
        const min = asNumber(c.min);
        const max = asNumber(c.max);
        if (min === null && max === null) return true;
        return (min === null || n >= min) && (max === null || n <= max);
      }
      const bound = asNumber(c.value);
      if (bound === null) return true;
      if (c.operator === "gte") return n >= bound;
      if (c.operator === "lte") return n <= bound;
      return true;
    }
    case "DATE": {
      if (!set) return c.operator === "older_than_days";
      const at = new Date(String(raw));
      if (Number.isNaN(at.getTime())) return false;
      const days = asNumber(c.value);
      if (days === null) return true;
      const age = ageInDays(at, now);
      if (age === null) return false;
      return c.operator === "within_days" ? age <= days : age > days;
    }
    case "MULTISELECT": {
      const held = (Array.isArray(raw) ? raw : []).map((v) => foldText(String(v)));
      const wanted = (c.values ?? []).map(foldText);
      if (wanted.length === 0) return true;
      if (c.operator === "has_all_of") return wanted.every((w) => held.includes(w));
      if (c.operator === "has_none_of") return !wanted.some((w) => held.includes(w));
      return wanted.some((w) => held.includes(w));
    }
    case "SELECT": {
      const actual = set ? String(raw) : null;
      if (c.operator === "is_any_of") {
        const wanted = c.values ?? [];
        return wanted.length === 0 || (actual !== null && wanted.includes(actual));
      }
      if (!present(String(c.value ?? ""))) return true;
      const match = actual === String(c.value);
      return c.operator === "is_not" ? !match : match;
    }
    default: {
      // TEXT and URL.
      const actual = set ? String(raw) : null;
      if (!present(String(c.value ?? ""))) return true;
      if (c.operator === "is") return foldedEquals(actual, String(c.value));
      return foldedContains(actual, String(c.value));
    }
  }
}

/**
 * Does this lead satisfy the set?
 *
 * An empty condition list passes everything in BOTH modes. Strict logic would
 * make an empty "any" vacuously false, which shows an empty table the instant
 * someone flips the match mode before adding a condition. No filter means no
 * filtering.
 */
export function matchesFilters(
  lead: FilterableLead,
  set: FilterSet,
  now: Date,
  customFields?: readonly CustomFieldSpec[],
): boolean {
  if (set.conditions.length === 0) return true;
  return set.match === "any"
    ? set.conditions.some((c) => evaluateCondition(lead, c, now, customFields))
    : set.conditions.every((c) => evaluateCondition(lead, c, now, customFields));
}

export function applyFilters<T extends FilterableLead>(
  leads: T[],
  set: FilterSet,
  now: Date = new Date(),
  customFields?: readonly CustomFieldSpec[],
): T[] {
  if (set.conditions.length === 0) return [...leads];
  return leads.filter((l) => matchesFilters(l, set, now, customFields));
}

// ---- sorting --------------------------------------------------------------

export const SORT_FIELDS = [
  "contactName",
  "company",
  "icpScore",
  "stage",
  "lastActivityAt",
  "createdAt",
] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export interface SortSpec {
  field: SortField;
  direction: "asc" | "desc";
}

export const DEFAULT_SORT: SortSpec = { field: "createdAt", direction: "desc" };

/**
 * Pipeline order, so sorting by stage produces the order people actually think
 * in. Alphabetical would read ACCEPTED, CONTACTED, DISQUALIFIED, HANDED_OFF —
 * which is no order at all.
 */
const STAGE_ORDER: Record<string, number> = {
  RESEARCHED: 0,
  CONTACTED: 1,
  ACCEPTED: 2,
  REPLIED: 3,
  QUALIFIED: 4,
  MEETING_BOOKED: 5,
  HANDED_OFF: 6,
  NOT_NOW: 7,
  DISQUALIFIED: 8,
};

/** Null for "no value here", which always sorts last. */
function sortKey(lead: FilterableLead, field: SortField): string | number | null {
  switch (field) {
    case "contactName":
      return present(lead.contactName) ? lead.contactName : null;
    case "company":
      return present(lead.company) ? lead.company : null;
    case "icpScore":
      return lead.icpScore;
    case "stage":
      return STAGE_ORDER[lead.stage] ?? 99;
    case "lastActivityAt":
      return lead.lastActivityAt ? lead.lastActivityAt.getTime() : null;
    case "createdAt":
      return lead.createdAt.getTime();
  }
}

export function applySort<T extends FilterableLead>(leads: T[], sort: SortSpec): T[] {
  const dir = sort.direction === "asc" ? 1 : -1;
  return [...leads].sort((a, b) => {
    const ka = sortKey(a, sort.field);
    const kb = sortKey(b, sort.field);

    // Missing values sort last in BOTH directions. "No value" is not the
    // smallest value — it is the least interesting one, and an ascending sort
    // that opens with a wall of unscored leads is not what was asked for.
    if (ka === null && kb === null) return a.id.localeCompare(b.id);
    if (ka === null) return 1;
    if (kb === null) return -1;

    let cmp: number;
    if (typeof ka === "number" && typeof kb === "number") {
      cmp = ka - kb;
    } else {
      // Locale-aware: Á must sort next to A, not after Z.
      cmp = String(ka).localeCompare(String(kb), "hu");
    }

    // A total order matters more than it looks: without the id tiebreak, two
    // rows with equal keys can swap places between one page request and the
    // next, and a row vanishes from the results entirely.
    return cmp === 0 ? a.id.localeCompare(b.id) : cmp * dir;
  });
}

// ---- pagination -----------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 50;

export interface Page<T> {
  rows: T[];
  /** 1-based, clamped into range. */
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
}

/**
 * Slice one page, clamping the requested page into range rather than returning
 * an empty list — deleting the last rows of a filtered set while sitting on the
 * last page otherwise leaves the user staring at nothing.
 */
export function paginate<T>(
  rows: T[],
  page: number,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Page<T> {
  const size = Math.max(1, Math.floor(pageSize));
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const clamped = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (clamped - 1) * size;
  return {
    rows: rows.slice(start, start + size),
    page: clamped,
    pageCount,
    total,
    pageSize: size,
  };
}

/**
 * A filter set in words, for the top of an export.
 *
 * An exported lead list is personal data leaving the building, and a list with
 * no statement of what it is a list OF cannot be checked by the person who
 * receives it or by the person who later has to explain it. So every format
 * carries this line: the spreadsheet in its header note, the document under its
 * title, the audit log in its meta.
 *
 * Deliberately prose rather than the JSON the filter set already is — the
 * audience is a colleague reading a PDF, not a parser.
 */
export function describeFilters(
  filters: FilterSet | null | undefined,
  customFields: ReadonlyArray<CustomFieldSpec & { label?: string }> = [],
): string {
  const conditions = filters?.conditions ?? [];
  if (conditions.length === 0) return "No filters — every lead in the workspace.";

  const parts = conditions.map((c) => describeCondition(c, customFields));
  // "and"/"or" spelled out: "match: any" is how the filter set stores it and
  // means nothing to somebody reading a document.
  return parts.join(filters?.match === "any" ? " or " : " and ");
}

function describeCondition(
  c: FilterCondition,
  customFields: ReadonlyArray<CustomFieldSpec & { label?: string }>,
): string {
  const field = labelForField(c.field, customFields);
  const op = OPERATOR_LABELS[c.operator] ?? c.operator;

  // Operators that are complete on their own — "Has email: yes" reads wrong as
  // "Has email yes ''".
  if (c.operator === "is_set" || c.operator === "is_not_set") return `${field} ${op}`;
  if (c.operator === "is_true" || c.operator === "is_false") return `${field}: ${op}`;
  if (c.operator === "between") return `${field} ${op} ${c.min ?? ""}–${c.max ?? ""}`;

  const value =
    c.values && c.values.length > 0
      ? c.values.join(", ")
      : c.value === null || c.value === undefined
        ? ""
        : String(c.value);
  return value ? `${field} ${op} ${value}` : `${field} ${op}`;
}
