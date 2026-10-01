/**
 * The hook gate, in code (CLAUDE.md hard rule 10, spec §4.43.7).
 *
 * A generated draft is accepted only when every personalisation point cites
 * a fact id the candidate actually carries, and quotes words that actually
 * appear in the message. The model is told to do this; this file is what
 * makes it true. A draft that cannot be grounded is not "sent with generic
 * copy" — the candidate leaves the funnel as NO_HOOK.
 *
 * It also re-checks at approval: a person may edit, and an edit that deletes
 * the only company-specific sentence turns a grounded message into a generic
 * one. Pure.
 */
import type { CandidateFact } from "./facts";
import { leakedPatternNames, type ReferenceRow } from "./references";

export interface PersonalisationPoint {
  factId: string;
  quote: string;
}

const norm = (s: string) =>
  s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[„”“"'’‘]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export type DraftCheck = { ok: true; points: PersonalisationPoint[] } | { ok: false; error: string };

export function validateDraft(
  draft: { subject: string; body: string; personalisationPoints: PersonalisationPoint[] },
  facts: readonly CandidateFact[],
  references: readonly ReferenceRow[],
): DraftCheck {
  if (draft.personalisationPoints.length === 0) {
    return { ok: false, error: "no personalisation point cited" };
  }
  const ids = new Set(facts.map((f) => f.id));
  const text = norm(`${draft.subject}\n${draft.body}`);
  for (const p of draft.personalisationPoints) {
    if (!ids.has(p.factId)) return { ok: false, error: `cites "${p.factId}", which is not one of this company's facts` };
    if (!text.includes(norm(p.quote))) return { ok: false, error: `the quote for ${p.factId} ("${p.quote}") is not in the message` };
  }
  const leaked = leakedPatternNames(`${draft.subject}\n${draft.body}`, references);
  if (leaked.length > 0) {
    return { ok: false, error: `names ${leaked.join(", ")}, which is a targeting pattern and not a client` };
  }
  if (/\{\{|\}\}|\[(név|name|company|cég)\]/i.test(draft.body)) {
    return { ok: false, error: "contains an unfilled placeholder" };
  }
  return { ok: true, points: draft.personalisationPoints };
}

/**
 * Is the text a person is about to approve still grounded? At least one
 * cited quote must survive the edit. If every company-specific sentence was
 * deleted, approval is refused — the human may rewrite, but not into a
 * message the rule forbids.
 */
export function stillGrounded(
  text: { subject: string; body: string },
  points: readonly PersonalisationPoint[],
): boolean {
  const t = norm(`${text.subject}\n${text.body}`);
  return points.some((p) => t.includes(norm(p.quote)));
}

/** Character ranges of each quote in the body, for highlighting in the queue. */
export function highlightRanges(body: string, points: readonly PersonalisationPoint[]): Array<{ start: number; end: number; factId: string }> {
  const lower = body.toLowerCase();
  const out: Array<{ start: number; end: number; factId: string }> = [];
  for (const p of points) {
    const q = p.quote.toLowerCase().trim();
    if (!q) continue;
    const at = lower.indexOf(q);
    if (at >= 0) out.push({ start: at, end: at + q.length, factId: p.factId });
  }
  // Non-overlapping, in order.
  return out
    .sort((a, b) => a.start - b.start)
    .filter((r, i, all) => i === 0 || r.start >= all[i - 1]!.end);
}
