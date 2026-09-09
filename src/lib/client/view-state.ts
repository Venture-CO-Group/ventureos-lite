/**
 * A view is a place, so it lives in the URL (playbook-v5 P16/5).
 *
 * ── WHY A CODEC AND NOT JUST useState ──────────────────────────────────────
 *
 * Which board you are on, which card is open, whether you are looking at the
 * list or the board, whether "only mine" is on: all of that was component
 * state. So a filtered board could not be sent to anybody, a reload lost it,
 * and the browser's Back button did not close the card it had just opened —
 * it left the page entirely, which is the single most disorienting thing a
 * detail overlay can do.
 *
 * ── THE TWO RULES THAT MAKE THE URLS BEARABLE ──────────────────────────────
 *
 * SHORT KEYS, and DEFAULTS OMITTED. A view sitting at its defaults has a clean
 * URL — `/tasks` — and only what somebody actually changed shows up:
 * `/tasks?v=list&mine=1`. Without the second rule every link carries every
 * key at its default value, which is unreadable and, worse, makes two
 * identical views produce different URLs.
 *
 * ── AND WHY UNKNOWN PARAMETERS SURVIVE ─────────────────────────────────────
 *
 * `encode` merges into whatever is already there rather than replacing it.
 * Other systems put things in the query string — `?task=` comes from a
 * notification link — and a view update must not silently drop them.
 */

export interface ViewField<T> {
  /** The query-string key. Short, because people read these. */
  key: string;
  /**
   * Total: a missing or malformed value returns the default, never throws.
   *
   * Declared as METHODS rather than arrow properties, deliberately: TypeScript
   * checks method parameters bivariantly, which is what lets a
   * `Record<string, ViewField<unknown>>` hold fields of differing value types
   * without an `any` in the middle of the schema type. `ViewValues` then
   * recovers each field's real type by inference, so nothing loses safety at
   * the call site.
   */
  fromParam(raw: string | null): T;
  /** `null` means "this is the default, leave it out of the URL". */
  toParam(value: T): string | null;
  /**
   * Whether changing this adds a history entry.
   *
   * "push" for things Back should undo: opening a card, switching a tab.
   * "replace" for things it should not: a filter toggled four times must not
   * need four Backs to leave the page.
   */
  history: "push" | "replace";
}

export type ViewSchema = Record<string, ViewField<unknown>>;

export type ViewValues<S extends ViewSchema> = {
  [K in keyof S]: ReturnType<S[K]["fromParam"]>;
};

/** Read a whole view out of a query string. Never throws. */
export function decodeView<S extends ViewSchema>(
  schema: S,
  search: URLSearchParams | string,
): ViewValues<S> {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  // Built as a loose record and asserted once at the boundary: the loop cannot
  // know which key it is on, and asserting per-assignment would be the same
  // cast repeated with more noise.
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema)) {
    out[name] = field.fromParam(params.get(field.key));
  }
  return out as ViewValues<S>;
}

/**
 * Write a view into a query string, keeping anything else that was there.
 * Values equal to their default are removed rather than written.
 */
export function encodeView<S extends ViewSchema>(
  schema: S,
  values: Partial<ViewValues<S>>,
  existing?: URLSearchParams | string,
): URLSearchParams {
  const params = new URLSearchParams(
    typeof existing === "string" ? existing : (existing?.toString() ?? ""),
  );
  for (const [name, field] of Object.entries(schema)) {
    if (!(name in values)) continue;
    const raw = field.toParam(values[name as keyof S]);
    if (raw === null || raw === "") params.delete(field.key);
    else params.set(field.key, raw);
  }
  return params;
}

/** `?a=1&b=2`, or the empty string when everything is at its default. */
export function viewQuery<S extends ViewSchema>(
  schema: S,
  values: Partial<ViewValues<S>>,
  existing?: URLSearchParams | string,
): string {
  const q = encodeView(schema, values, existing).toString();
  return q ? `?${q}` : "";
}

/** Which of the changed fields wants a history entry. */
export function historyModeFor<S extends ViewSchema>(
  schema: S,
  patch: Partial<ViewValues<S>>,
): "push" | "replace" {
  // If ANY changed field wants a push, push: the surprising failure is Back
  // not undoing something it should, not an extra entry.
  for (const name of Object.keys(patch)) {
    if (schema[name]?.history === "push") return "push";
  }
  return "replace";
}

// ---------------------------------------------------------------------------
// field builders
// ---------------------------------------------------------------------------

/** One of a fixed set. Anything else is the default — a hand-edited URL must
 *  not be able to put a surface into a state it cannot render. */
export function enumField<const T extends readonly string[]>(
  key: string,
  options: T,
  fallback: T[number],
  history: "push" | "replace" = "push",
): ViewField<T[number]> {
  return {
    key,
    history,
    fromParam: (raw) => (raw && options.includes(raw) ? (raw as T[number]) : fallback),
    toParam: (value) => (value === fallback ? null : value),
  };
}

/** An on/off flag, written as `1` and absent when off. */
export function boolField(
  key: string,
  fallback = false,
  history: "push" | "replace" = "replace",
): ViewField<boolean> {
  return {
    key,
    history,
    fromParam: (raw) => (raw === null ? fallback : raw === "1" || raw === "true"),
    toParam: (value) => (value === fallback ? null : value ? "1" : "0"),
  };
}

/** An id, or nothing. The open-detail case. */
export function idField(key: string, history: "push" | "replace" = "push"): ViewField<string | null> {
  return {
    key,
    history,
    // Bounded: an id is a cuid, and a megabyte in the query string is not one.
    fromParam: (raw) => (raw && raw.length <= 60 ? raw : null),
    toParam: (value) => value ?? null,
  };
}

/** A whole number within bounds. Out of range clamps rather than failing. */
export function numField(
  key: string,
  fallback: number,
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {},
  history: "push" | "replace" = "replace",
): ViewField<number> {
  return {
    key,
    history,
    fromParam: (raw) => {
      if (raw === null) return fallback;
      const n = Number(raw);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.trunc(n)));
    },
    toParam: (value) => (value === fallback ? null : String(value)),
  };
}

/** Free text — a search box. Trimmed and bounded. */
export function textField(
  key: string,
  fallback = "",
  maxLength = 120,
  history: "push" | "replace" = "replace",
): ViewField<string> {
  return {
    key,
    history,
    fromParam: (raw) => (raw ?? fallback).slice(0, maxLength),
    toParam: (value) => {
      const text = value.trim().slice(0, maxLength);
      return text === fallback ? null : text;
    },
  };
}

/** A set of values, comma-separated. Order is not meaningful, duplicates go. */
export function setField(
  key: string,
  allowed: readonly string[],
  history: "push" | "replace" = "replace",
): ViewField<string[]> {
  return {
    key,
    history,
    fromParam: (raw) =>
      raw === null
        ? []
        : [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => allowed.includes(s)))],
    toParam: (value) => {
      const kept = [...new Set(value.filter((v) => allowed.includes(v)))];
      return kept.length === 0 ? null : kept.join(",");
    },
  };
}
