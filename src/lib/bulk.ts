/**
 * The shape of a bulk action, for every surface that has one (playbook-v5 P17/1).
 *
 * ── WHY THIS MOVED OUT OF modules/leads ─────────────────────────────────────
 *
 * All of it was already written — batching, per-row skip reasons, merged
 * results, an undo handle per batch — and it was lead-specific only by
 * LOCATION. Five more surfaces need the same contract, and the playbook is
 * explicit that they should extend the pattern rather than grow their own. So
 * the generic half lives here and `modules/leads/bulk.ts` re-exports it, which
 * means nothing that already imported from there had to move.
 *
 * ── THE CONTRACT, AND WHY EACH PART EXISTS ──────────────────────────────────
 *
 * `applied` and `skipped` are separate because a bulk action that reports only
 * a count is lying by omission: moving 200 leads where 30 fail the score gate
 * is not "170 updated", it is "170 updated, 30 skipped, and here is why each
 * one was". Per-row rules still apply per row — that is the whole point — so
 * the result has to carry per-row reasons.
 *
 * `undoId` is per BATCH. A 500-row action is ten round trips and produces ten
 * handles; the bar keeps the last. Undoing the whole thing would mean one
 * transaction spanning ten requests, which is precisely the shape batching
 * exists to avoid.
 */

/** One row that did not get the action, and the reason a person can act on. */
export interface SkippedRow {
  id: string;
  reason: string;
}

export interface BulkResult {
  applied: number;
  skipped: SkippedRow[];
  /** The toast's undo handle, when this kind of action has an inverse. */
  undoId?: string | null;
  undoLabel?: string | null;
}

/**
 * How many rows one server round trip touches.
 *
 * Small enough that the progress bar moves and a failure loses little work,
 * large enough that 500 rows is ten calls rather than five hundred.
 */
export const BULK_BATCH_SIZE = 50;

export function chunk<T>(items: T[], size: number = BULK_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function mergeBulkResults(results: BulkResult[]): BulkResult {
  return {
    applied: results.reduce((n, r) => n + r.applied, 0),
    skipped: results.flatMap((r) => r.skipped),
    // The last batch's handle: see the header for why it is not all of them.
    undoId: [...results].reverse().find((r) => r.undoId)?.undoId ?? null,
    undoLabel: [...results].reverse().find((r) => r.undoLabel)?.undoLabel ?? null,
  };
}

/** Nothing happened, and nothing was skipped. The identity for a merge. */
export const EMPTY_BULK_RESULT: BulkResult = { applied: 0, skipped: [] };

/**
 * One line summarising a finished run.
 *
 * Written here so every surface says it the same way, and so "and 30 skipped"
 * is never quietly dropped — a summary that mentions only successes is how a
 * partial failure goes unnoticed.
 */
export function summarizeBulk(result: BulkResult, noun: string, verb = "updated"): string {
  const plural = (n: number) => (n === 1 ? noun : `${noun}s`);
  const parts = [`${result.applied} ${plural(result.applied)} ${verb}`];
  if (result.skipped.length > 0) {
    parts.push(`${result.skipped.length} skipped`);
  }
  return `${parts.join(", ")}.`;
}

/**
 * Skipped rows grouped by reason.
 *
 * Two hundred rows skipped for the same reason is one sentence, not two
 * hundred lines — but the ids stay attached so a person can find them.
 */
export function groupSkipped(skipped: SkippedRow[]): { reason: string; ids: string[] }[] {
  const byReason = new Map<string, string[]>();
  for (const row of skipped) {
    const ids = byReason.get(row.reason) ?? [];
    ids.push(row.id);
    byReason.set(row.reason, ids);
  }
  return [...byReason.entries()]
    .map(([reason, ids]) => ({ reason, ids }))
    .sort((a, b) => b.ids.length - a.ids.length);
}
