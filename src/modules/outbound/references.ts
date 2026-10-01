/**
 * Reference companies and who may be named (CLAUDE.md hard rule 13,
 * spec §4.43.1).
 *
 * A product carries two kinds of reference: true clients, whose name may
 * appear in an outbound message ("for companies like X we found…"), and
 * targeting patterns — "find companies like PwC" — whose name must never
 * appear, because claiming a relationship we do not have is a lie with our
 * name on it.
 *
 * ── WHY A BRANDED TYPE AND NOT A FILTER AT THE CALL SITE ──────────────────
 *
 * A filter at the call site works until the second call site. The draft
 * generator's input takes `NameableReference[]`, and the only way to make one
 * is `nameableReferences()` below — so a raw reference row handed to the
 * drafting path is a TYPE error, not a review comment. The test that proves a
 * pattern reference cannot reach the prompt leans on exactly that.
 */

export interface ReferenceRow {
  companyName: string;
  taxNumber: string | null;
  isClient: boolean;
  note: string | null;
}

declare const nameable: unique symbol;

/** A reference that is a real client, and therefore safe to name. */
export type NameableReference = {
  readonly companyName: string;
  readonly note: string | null;
  readonly [nameable]: true;
};

export function nameableReferences(rows: readonly ReferenceRow[]): NameableReference[] {
  return rows
    .filter((r) => r.isClient === true && r.companyName.trim().length > 0)
    .map((r) => ({ companyName: r.companyName.trim(), note: r.note }) as NameableReference);
}

/**
 * Every name in `text` that belongs to a NON-client reference.
 *
 * The belt to the type system's braces: the draft validator runs this over
 * the generated subject and body, because a model can surface a name from
 * anywhere it saw one — including the ICP profile a pattern reference shaped.
 */
export function leakedPatternNames(text: string, rows: readonly ReferenceRow[]): string[] {
  const hay = text.toLowerCase();
  const out: string[] = [];
  for (const r of rows) {
    if (r.isClient) continue;
    const name = r.companyName.trim();
    if (!name) continue;
    // The distinctive part: "PwC Magyarország Kft." is caught as "PwC".
    const core = name
      .replace(/\b(kft|zrt|nyrt|bt|kkt|ev|e\.v|plc|ltd|gmbh|inc)\.?/gi, "")
      .replace(/magyarország|hungary|hungária/gi, "")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join(" ")
      .toLowerCase();
    if (core.length >= 3 && hay.includes(core)) out.push(name);
  }
  return out;
}
