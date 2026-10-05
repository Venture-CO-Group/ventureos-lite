/**
 * The hook gate, in code (CLAUDE.md hard rule 10, spec §4.43.7).
 *
 * A generated draft is accepted only when every personalisation point cites
 * a fact id the candidate actually carries, and quotes words that actually
 * appear in the message. The model is told to do this; this file is what
 * makes it true. A draft that cannot be grounded is not "sent with generic
 * copy" — the candidate leaves the funnel as NO_HOOK.
 *
 * SCOPE (CLAUDE.md hard rule 10): the hook is a GENERATION-time rule. It
 * governs what the motor may write and queue on its own. Once a person has
 * edited the text, their judgement supersedes it — exactly as approval
 * supersedes the mandatory-edit rule on this path — so the hook is checked at
 * approval and at send ONLY while the text is still the machine's own
 * (`isHumanEdited` false). For edited copy `hookStatus` is information shown
 * to the reviewer, never a refusal. Pure.
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

/**
 * Has a person changed the machine's text? Compared against the stored
 * original, which every draft keeps, so the answer cannot drift from a flag.
 * Whitespace-only changes do not count as an edit.
 */
export function isHumanEdited(d: { subject: string; body: string; originalSubject: string; originalBody: string }): boolean {
  const n = (s: string) => s.replace(/\s+/g, " ").trim();
  return n(d.subject) !== n(d.originalSubject) || n(d.body) !== n(d.originalBody);
}

export interface HookStatus {
  /** The text still states at least one cited company-specific fact. */
  grounded: boolean;
  /** The cited points whose quote is still in the text. */
  present: PersonalisationPoint[];
}

/** What the reviewer sees: does this text carry a company-specific fact? Information only. */
export function hookStatus(text: { subject: string; body: string }, points: readonly PersonalisationPoint[]): HookStatus {
  const t = norm(`${text.subject}\n${text.body}`);
  const present = points.filter((p) => t.includes(norm(p.quote)));
  return { grounded: present.length > 0, present };
}

/**
 * The send/approval gate for the hook: required only for unedited machine
 * text. An edited draft passes on approval alone.
 */
export function hookRequiredAndMissing(
  d: { subject: string; body: string; originalSubject: string; originalBody: string },
  points: readonly PersonalisationPoint[],
): boolean {
  if (isHumanEdited(d)) return false;
  return !stillGrounded(d, points);
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
