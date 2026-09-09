/**
 * Checklists — the pure half (playbook-v5 P20/3).
 *
 * ── THE DISTINCTION, IN ONE LINE ────────────────────────────────────────────
 *
 * A checklist is the steps WITHIN this task; a subtask is work somebody else
 * may own. That sentence is in the UI, because without it the two controls sit
 * side by side and nobody knows which to reach for — and the answer decides
 * whether the thing can be assigned, scheduled and reported on.
 *
 * ── AND WHAT A CHECKLIST DOES NOT DO ────────────────────────────────────────
 *
 * Ticking every item does NOT complete the task. The playbook is explicit, and
 * it matches the existing rule that a parent never completes from its
 * subtasks: deciding the work is finished belongs to the person who can see
 * whether the last step was real.
 */

/**
 * ── WHY THIS FILE IS SEPARATE FROM checklist.ts ─────────────────────────────
 *
 * The detail panel renders the progress label and enforces the length cap in
 * the browser, so it imports from here. If these lived beside the queries, the
 * client component would pull `@/lib/db` — and with it the tenant guard and
 * `node:async_hooks` — into the browser bundle. The reachability test catches
 * exactly that, and it caught it here.
 */

export const MAX_CHECKLIST_ITEMS = 50;
export const MAX_ITEM_LENGTH = 200;
export const POSITION_STEP = 1024;

/** The one-liner the UI shows beside the two controls. */
export const CHECKLIST_VS_SUBTASK =
  "Checklist for steps within this task; subtask for work someone else may own.";

export interface ChecklistItem {
  id: string;
  text: string;
  doneAt: Date | null;
  position: number;
}

export interface ChecklistProgress {
  done: number;
  total: number;
}

export function progressOf(items: { doneAt: Date | null }[]): ChecklistProgress {
  return { done: items.filter((i) => i.doneAt !== null).length, total: items.length };
}

/** "3/7", or null when there is no checklist to speak of. */
export function progressLabel(progress: ChecklistProgress): string | null {
  return progress.total === 0 ? null : `${progress.done}/${progress.total}`;
}

export function nextPosition(existing: number[]): number {
  return existing.length === 0 ? POSITION_STEP : Math.max(...existing) + POSITION_STEP;
}

/**
 * Progress for many tasks at once, from rows already fetched.
 *
 * It takes the rows rather than fetching them, because the board needs this
 * inside its one batched `Promise.all` — a helper that opened its own client
 * would put the board back to a query per surface.
 */
export function groupProgress(
  rows: { taskId: string; doneAt: Date | null }[],
): Map<string, ChecklistProgress> {
  const out = new Map<string, ChecklistProgress>();
  for (const row of rows) {
    const current = out.get(row.taskId) ?? { done: 0, total: 0 };
    out.set(row.taskId, {
      done: current.done + (row.doneAt ? 1 : 0),
      total: current.total + 1,
    });
  }
  return out;
}
