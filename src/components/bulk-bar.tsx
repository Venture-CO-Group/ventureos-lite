"use client";

import { useState, type ReactNode } from "react";
import {
  BULK_BATCH_SIZE,
  chunk,
  groupSkipped,
  mergeBulkResults,
  summarizeBulk,
  type BulkResult,
} from "@/lib/bulk";
import { useToast } from "./toast";
import { serverActionError } from "@/lib/client/server-action";
import type { BulkSelection } from "./use-bulk-selection";

/**
 * The action bar every bulk surface shares (playbook-v5 P17/1).
 *
 * ── WHY ONE BAR AND NOT SIX ─────────────────────────────────────────────────
 *
 * The leads table had a 747-line bar with all of this in it, and five more
 * surfaces need the same behaviour: a persistent count, the escalation from
 * "this page" to "everything matching", batched execution with a progress
 * bar, and — the part that is always dropped when this gets rewritten — a
 * PER-ROW report of what was skipped and why. Copying it five times would mean
 * five places for that report to quietly disappear from.
 *
 * So the bar is generic and each surface supplies its actions. What an action
 * DOES stays with its own module, where its per-row rules live.
 *
 * ── PARTIAL FAILURE IS NEVER SILENT ─────────────────────────────────────────
 *
 * Moving 200 leads where 30 fail the score gate is not "170 updated". It is
 * "170 updated, 30 skipped", followed by the reasons — grouped, because two
 * hundred rows skipped for one reason is one sentence, not two hundred lines.
 *
 * ── AND WHY IT BATCHES ──────────────────────────────────────────────────────
 *
 * One request per 50 rows. The progress bar can then move, a failure loses
 * little work, and no single request has to hold a 500-row transaction open.
 */

export interface BulkAction<T = void> {
  key: string;
  label: string;
  /** Rendered inside the bar when this action is armed — a select, a date. */
  form?: (state: T, set: (next: T) => void) => ReactNode;
  /** Initial value for `form`'s state. */
  initial?: T;
  /** Refuse to run, with a reason, before anything is sent. */
  validate?: (state: T) => string | null;
  /** Typed confirmation for a destructive action. The exact word required. */
  confirmWord?: string;
  /** One batch. Called repeatedly with at most BULK_BATCH_SIZE ids. */
  run: (ids: string[], state: T) => Promise<BulkResult>;
  /** What the summary calls a row: "lead", "task", "recipient". */
  noun: string;
  /** The verb for the summary: "updated", "completed", "removed". */
  verb?: string;
  destructive?: boolean;
}

export function BulkBar({
  selection,
  actions,
  /** Resolves "everything matching" to real ids, on the server. */
  resolveAll,
  onDone,
  testId = "bulk-bar",
}: {
  selection: BulkSelection;
  /**
   * `unknown` state, not `any`: each action owns the shape of its own form
   * state and the bar never inspects it — it only stores it and hands it back.
   * A generic parameter here would have to be the union of six unrelated
   * shapes for no gain.
   */
  actions: BulkAction<unknown>[];
  resolveAll?: () => Promise<string[]>;
  onDone?: () => void;
  testId?: string;
}) {
  const [armed, setArmed] = useState<string | null>(null);
  const [state, setState] = useState<unknown>(undefined);
  const [confirmText, setConfirmText] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const action = actions.find((a) => a.key === armed) ?? null;

  function arm(next: BulkAction<unknown>) {
    setArmed(next.key);
    setState(next.initial);
    setConfirmText("");
    setError(null);
    setResult(null);
  }

  function reset() {
    setArmed(null);
    setState(undefined);
    setConfirmText("");
    setProgress(null);
  }

  async function execute() {
    if (!action) return;
    setError(null);
    setResult(null);

    const refusal = action.validate?.(state) ?? null;
    if (refusal) {
      setError(refusal);
      return;
    }

    let targets: string[];
    try {
      targets = selection.allMatching && resolveAll ? await resolveAll() : selection.ids;
    } catch (e) {
      setError(serverActionError(e));
      return;
    }
    if (targets.length === 0) {
      setError("Nothing selected.");
      return;
    }

    const batches = chunk(targets, BULK_BATCH_SIZE);
    const results: BulkResult[] = [];
    setProgress({ done: 0, total: targets.length });
    try {
      for (const batch of batches) {
        results.push(await action.run(batch, state));
        setProgress({
          done: results.reduce((n, r) => n + r.applied + r.skipped.length, 0),
          total: targets.length,
        });
      }
    } catch (e) {
      // Whatever landed before the failure still happened, and saying so is
      // more useful than a bare error — the person needs to know the action
      // was partial rather than assume it did nothing.
      const partial = mergeBulkResults(results);
      setResult(partial);
      setError(serverActionError(e));
      setProgress(null);
      return;
    }

    const merged = mergeBulkResults(results);
    setProgress(null);
    setResult(merged);
    reset();
    selection.clear();

    if (merged.undoId) {
      toast.offerUndo(
        { id: merged.undoId, label: merged.undoLabel ?? "Done" },
        merged.undoLabel ?? undefined,
      );
    } else {
      toast.success(summarizeBulk(merged, action.noun, action.verb));
    }
    onDone?.();
  }

  if (selection.empty && !result) return null;

  const confirmed =
    !action?.confirmWord || confirmText.trim().toUpperCase() === action.confirmWord.toUpperCase();

  return (
    <div
      data-testid={testId}
      className="sticky bottom-20 z-40 mb-3 rounded-card border border-accent-soft bg-[rgba(6,11,38,0.97)] p-3 shadow-glow-lg backdrop-blur nav:bottom-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        {!selection.empty && (
          <span data-testid="bulk-count" className="text-[12.5px] font-semibold text-ink">
            {selection.count} selected
          </span>
        )}

        {!armed &&
          actions.map((a) => (
            <button
              key={a.key}
              type="button"
              data-testid={`bulk-${a.key}`}
              onClick={() => arm(a)}
              className={`rounded-[10px] border px-2.5 py-1.5 text-[12px] ${
                a.destructive
                  ? "border-[rgba(255,92,122,0.35)] text-[#FFB3C2] hover:bg-[rgba(255,92,122,0.1)]"
                  : "border-line bg-panel text-muted hover:text-ink"
              }`}
            >
              {a.label}
            </button>
          ))}

        {!armed && (
          <button
            type="button"
            data-testid="bulk-clear"
            onClick={selection.clear}
            className="ml-auto text-[12px] text-muted hover:text-ink"
          >
            Clear
          </button>
        )}

        {action && (
          <>
            <span className="text-[12.5px] text-muted">{action.label}</span>
            {action.form?.(state, setState)}
            {action.confirmWord && (
              <input
                data-testid="bulk-confirm-word"
                aria-label={`Type ${action.confirmWord} to confirm`}
                placeholder={action.confirmWord}
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                className="w-[120px] rounded-[8px] border border-[rgba(255,92,122,0.35)] bg-[rgba(0,5,29,0.6)] px-2 py-1 text-[12px] text-ink outline-none"
              />
            )}
            <button
              type="button"
              data-testid="bulk-confirm"
              disabled={!!progress || !confirmed}
              onClick={() => void execute()}
              className="rounded-[10px] border border-accent bg-accent-soft px-3 py-1.5 text-[12px] font-semibold text-[#E4D3FF] disabled:opacity-60"
            >
              {progress ? "Working…" : "Apply"}
            </button>
            <button
              type="button"
              data-testid="bulk-cancel"
              onClick={reset}
              className="text-[12px] text-muted hover:text-ink"
            >
              Cancel
            </button>
          </>
        )}
      </div>

      {/**
       * The escalation. Offered only once every row on screen is ticked and
       * there is more behind the filter — see useBulkSelection for why.
       */}
      {selection.allMatching ? (
        <p data-testid="bulk-all-matching" className="mt-1.5 text-[11px] text-accent-ink">
          Everything matching the current filter is selected.
        </p>
      ) : null}

      {progress && (
        <div className="mt-2" data-testid="bulk-progress">
          <div className="mb-1 flex justify-between text-[11px] text-muted">
            <span>
              Working… {progress.done} of {progress.total}
            </span>
            <span className="tabular-nums">
              {Math.round((progress.done / Math.max(1, progress.total)) * 100)}%
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-panel-2">
            <div
              className="h-full bg-grad transition-[width]"
              style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <p data-testid="bulk-error" className="mt-2 text-[12px] text-[#FFB3C2]">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-2" data-testid="bulk-summary">
          <p className="text-[12px] text-ink">
            {summarizeBulk(result, actions[0]?.noun ?? "row", actions[0]?.verb)}
          </p>
          {/**
           * The per-row report. Grouped by reason, with the count, because the
           * useful question is "why were thirty skipped" and not "which
           * thirty" — and the ids are there for when it is.
           */}
          {result.skipped.length > 0 && (
            <ul className="mt-1.5 grid gap-1" data-testid="bulk-skipped">
              {groupSkipped(result.skipped).map((group) => (
                <li key={group.reason} className="text-[11.5px] text-warn">
                  <b className="font-semibold">{group.ids.length}</b> skipped — {group.reason}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            data-testid="bulk-summary-dismiss"
            onClick={() => setResult(null)}
            className="mt-1.5 text-[11px] text-muted hover:text-ink"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
