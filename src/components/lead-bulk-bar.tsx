"use client";
import { serverActionError } from "@/lib/client/server-action";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  bulkAssignOwner,
  bulkChangeStage,
  bulkDeleteLeads,
  bulkEditSignals,
  bulkExport,
  exportReady,
  resolveBulkSelection,
} from "@/modules/leads/bulk-actions";
import {
  EXPORT_FORMATS,
  FORMAT_LABEL,
  FORMAT_HINT,
  MAX_EXPORT_ROWS,
  type ExportFormat,
} from "@/modules/leads/export-formats";
import { BULK_BATCH_SIZE, chunk, mergeBulkResults, type BulkResult } from "@/modules/leads/bulk";
import { useUndo } from "./undo-toast";
import { STAGE_LABELS } from "@/modules/pipeline/transitions";
import type { FilterSet } from "@/modules/leads/filters";
import type { LeadFacets } from "@/modules/leads/table";
import { Modal } from "./modal";

/**
 * The bulk action bar (playbook-v2 P3/2).
 *
 * Two things it deliberately does NOT do:
 *
 *   - decide which leads are affected when "select all matching" is on. It asks
 *     the server to resolve the filter and uses what comes back, because which
 *     rows a mutation touches is not the browser's decision to make;
 *   - send everything in one request. Work goes out in batches so the progress
 *     bar means something and a failure loses one batch rather than all of it.
 */

type Action = "stage" | "signals" | "owner" | "delete" | "export" | null;

/** Save a base64 payload the server built, without a round trip through a URL. */
function saveBase64(base64: string, filename: string, mime: string): void {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const STAGES = Object.keys(STAGE_LABELS) as Array<keyof typeof STAGE_LABELS>;

export function LeadBulkBar({
  ids,
  allMatching,
  filters,
  matchingTotal,
  pageIds,
  columns,
  facets,
  canDelete,
  canExport,
  onSelectAllMatching,
  onClear,
}: {
  /** Explicitly ticked ids. Ignored when `allMatching` is true. */
  ids: string[];
  allMatching: boolean;
  filters: FilterSet;
  matchingTotal: number;
  pageIds: string[];
  columns: string[];
  facets: LeadFacets;
  canDelete: boolean;
  canExport: boolean;
  onSelectAllMatching: () => void;
  onClear: () => void;
}) {
  const router = useRouter();
  const [action, setAction] = useState<Action>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const { offerUndo } = useUndo();
  const [summary, setSummary] = useState<(BulkResult & { note?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state for the dialogs.
  const [stage, setStage] = useState<string>("CONTACTED");
  const [reason, setReason] = useState("");
  const [wakeUpAt, setWakeUpAt] = useState("");
  const [addTags, setAddTags] = useState("");
  const [removeTags, setRemoveTags] = useState("");
  const [ownerId, setOwnerId] = useState<string>("");
  /** Which format row is highlighted; the click is what actually exports. */
  const [exportFormat, setExportFormat] = useState<ExportFormat>("xlsx");

  const count = allMatching ? matchingTotal : ids.length;
  const everyRowOnPageSelected = pageIds.length > 0 && pageIds.every((id) => ids.includes(id));
  const canOfferSelectAll = !allMatching && everyRowOnPageSelected && matchingTotal > pageIds.length;

  function close() {
    setAction(null);
    setError(null);
  }

  /** Resolve the target ids, then run `fn` over them one batch at a time. */
  async function run(fn: (batch: string[]) => Promise<BulkResult>, note?: string) {
    setError(null);
    setSummary(null);
    try {
      const targets = allMatching ? await resolveBulkSelection(filters) : ids;
      if (targets.length === 0) {
        setError("Nothing selected.");
        return;
      }
      const batches = chunk(targets, BULK_BATCH_SIZE);
      const results: BulkResult[] = [];
      setProgress({ done: 0, total: targets.length });
      for (const batch of batches) {
        results.push(await fn(batch));
        setProgress((p) => ({ done: (p?.done ?? 0) + batch.length, total: targets.length }));
      }
      const merged = mergeBulkResults(results);
      setSummary({ ...merged, note });
      // The LAST batch's handle: each batch is its own undoable action, and
      // offering the last one undoes the last fifty rather than pretending the
      // whole run was atomic (see BulkResult.undoId).
      const lastUndo = [...results].reverse().find((r) => r.undoId);
      if (lastUndo?.undoId) {
        offerUndo({
          id: lastUndo.undoId,
          label:
            batches.length > 1
              ? `${lastUndo.undoLabel} (last batch of ${batches.length})`
              : (lastUndo.undoLabel ?? "Done"),
        });
      }
      close();
      onClear();
      router.refresh();
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setProgress(null);
    }
  }

  /**
   * Export the selection in one of three formats.
   *
   * ── WHY THE BATCHING CHANGED ────────────────────────────────────────────
   *
   * CSV used to be fetched in batches and stitched together in the browser by
   * dropping every header row after the first. That works for a line-based
   * format and for nothing else: an XLSX is a ZIP container and a PDF is a
   * document, and neither can be concatenated. So a selection is resolved
   * here, and the whole thing is built server-side in one pass — which is also
   * where the row cap lives, because a browser assembling a 40MB spreadsheet
   * from fragments was never a good idea.
   */
  async function runExport(format: ExportFormat) {
    setError(null);
    try {
      const targets = allMatching ? await resolveBulkSelection(filters) : ids;
      if (targets.length === 0) {
        setError("Nothing selected.");
        return;
      }
      if (targets.length > MAX_EXPORT_ROWS) {
        setError(
          `That is ${targets.length} leads; the export limit is ${MAX_EXPORT_ROWS}. ` +
            `Narrow the filter and export in parts.`,
        );
        return;
      }

      setProgress({ done: 0, total: targets.length });
      const subtitle = allMatching
        ? `${targets.length} leads · all matching the current filter`
        : `${targets.length} selected lead${targets.length === 1 ? "" : "s"}`;
      const res = await bulkExport({ ids: targets, columns, format, subtitle });
      if (!res.ok) {
        setError(res.error);
        return;
      }

      if (res.kind === "inline") {
        saveBase64(res.base64, res.filename, res.mime);
        setProgress({ done: targets.length, total: targets.length });
      } else {
        // The PDF is rendered by the worker (Chromium lives only there), so we
        // wait for the file rather than for the response.
        setProgress({ done: 0, total: targets.length });
        const started = Date.now();
        let ready = false;
        while (Date.now() - started < 90_000) {
          await new Promise((r) => setTimeout(r, 1500));
          if ((await exportReady(res.rel)).ready) {
            ready = true;
            break;
          }
        }
        if (!ready) {
          setError(
            "The PDF is taking longer than expected. It is still rendering in the background — try the export again in a moment.",
          );
          return;
        }
        window.open(`/api/files/${res.rel}`, "_blank", "noopener");
      }

      setSummary({ applied: targets.length, skipped: [], note: "exported" });
      close();
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setProgress(null);
    }
  }

  const buttonClass =
    "rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2 disabled:opacity-50";

  return (
    <>
      {summary && (
        <div
          data-testid="bulk-summary"
          className="mb-3 rounded-[10px] border border-line bg-panel px-3.5 py-2.5 text-[12.5px]"
        >
          <b>
            {summary.applied} lead{summary.applied === 1 ? "" : "s"}{" "}
            {summary.note ?? "updated"}
          </b>
          {summary.skipped.length > 0 && (
            <>
              {" · "}
              <span className="text-warn">{summary.skipped.length} skipped</span>
              <ul className="mt-1.5 max-h-[120px] list-disc overflow-y-auto pl-5 text-[12px] text-muted">
                {summary.skipped.slice(0, 25).map((s) => (
                  <li key={s.id}>{s.reason}</li>
                ))}
                {summary.skipped.length > 25 && (
                  <li>…and {summary.skipped.length - 25} more</li>
                )}
              </ul>
            </>
          )}
          <button
            type="button"
            onClick={() => setSummary(null)}
            className="ml-2 text-[12px] text-muted underline hover:text-ink"
          >
            dismiss
          </button>
        </div>
      )}

      {count > 0 && (
        <div
          data-testid="bulk-bar"
          className="mb-3 flex flex-wrap items-center gap-2 rounded-card border border-accent-soft bg-accent-soft/25 px-3.5 py-2.5"
        >
          <b data-testid="bulk-count" className="text-[12.5px]">
            {count} selected
          </b>

          {canOfferSelectAll && (
            <button
              type="button"
              onClick={onSelectAllMatching}
              data-testid="bulk-select-all-matching"
              className="text-[12px] text-accent-ink underline hover:text-ink"
            >
              Select all {matchingTotal} matching
            </button>
          )}

          <span className="mx-1 h-4 w-px bg-line" />

          <button type="button" className={buttonClass} onClick={() => setAction("stage")}>
            Change stage
          </button>
          <button type="button" className={buttonClass} onClick={() => setAction("signals")}>
            Signals
          </button>
          <button type="button" className={buttonClass} onClick={() => setAction("owner")}>
            Assign owner
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={!canExport}
            title={canExport ? undefined : "Needs the exports.run grant"}
            data-testid="bulk-export"
            onClick={() => setAction("export")}
          >
            Export
          </button>
          <button
            type="button"
            className={`${buttonClass} ${canDelete ? "hover:text-[#FFB3C2]" : ""}`}
            disabled={!canDelete}
            title={canDelete ? undefined : "Needs the leads.delete capability"}
            data-testid="bulk-delete"
            onClick={() => setAction("delete")}
          >
            Delete
          </button>

          <button
            type="button"
            onClick={onClear}
            data-testid="bulk-clear"
            className="ml-auto text-[12px] text-muted underline hover:text-ink"
          >
            clear selection
          </button>
        </div>
      )}

      {progress && (
        <div
          data-testid="bulk-progress"
          className="mb-3 rounded-[10px] border border-line bg-panel px-3.5 py-2.5"
        >
          <div className="mb-1.5 flex justify-between text-[12px] text-muted">
            <span>
              Working… {progress.done} of {progress.total}
            </span>
            <span className="tabular-nums">
              {Math.round((progress.done / Math.max(1, progress.total)) * 100)}%
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div
              className="h-full bg-grad transition-[width]"
              style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
            />
          </div>
        </div>
      )}

      {action && (
        <Modal onClose={close}>
          <div className="mb-3 flex items-center">
            <h3 className="font-display text-lg font-bold lowercase">
              {action === "stage" && "change stage"}
              {action === "signals" && "edit signals"}
              {action === "owner" && "assign owner"}
              {action === "delete" && "delete leads"}
              {action === "export" && "export leads"}
            </h3>
            <button onClick={close} className="ml-auto text-muted hover:text-ink">
              ✕
            </button>
          </div>
          <p className="mb-3 text-[12px] text-muted">
            {count} lead{count === 1 ? "" : "s"} selected.
          </p>
          {error && <p className="mb-2 text-[12px] text-[#FFB3C2]">{error}</p>}

          {action === "stage" && (
            <>
              <select
                value={stage}
                onChange={(e) => setStage(e.target.value)}
                data-testid="bulk-stage-select"
                className="mb-3 w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent"
              >
                {STAGES.map((s) => (
                  <option key={s} value={s}>
                    {STAGE_LABELS[s]}
                  </option>
                ))}
              </select>
              <p className="mb-3 text-[12px] text-muted">
                The score gate still applies to each lead. Any that cannot move
                are listed afterwards rather than moved anyway.
              </p>
              {stage === "NOT_NOW" && (
                <label className="mb-3 block text-[12.5px]">
                  Wake up on
                  <input
                    type="date"
                    value={wakeUpAt}
                    onChange={(e) => setWakeUpAt(e.target.value)}
                    data-testid="bulk-wakeup"
                    className="mt-1 w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent"
                  />
                  <span className="mt-1 block text-[11.5px] text-muted">
                    Left empty, the default +6 months applies.
                  </span>
                </label>
              )}
              {stage === "DISQUALIFIED" && (
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason (required)"
                  data-testid="bulk-reason"
                  className="mb-3 w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent"
                />
              )}
            </>
          )}

          {action === "signals" && (
            <>
              <label className="mb-3 block text-[12.5px]">
                Add
                <input
                  value={addTags}
                  onChange={(e) => setAddTags(e.target.value)}
                  list="bulk-signal-facets"
                  placeholder="comma-separated"
                  data-testid="bulk-signals-add"
                  className="mt-1 w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent"
                />
              </label>
              <label className="mb-3 block text-[12.5px]">
                Remove
                <input
                  value={removeTags}
                  onChange={(e) => setRemoveTags(e.target.value)}
                  list="bulk-signal-facets"
                  placeholder="comma-separated"
                  data-testid="bulk-signals-remove"
                  className="mt-1 w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent"
                />
              </label>
              <datalist id="bulk-signal-facets">
                {facets.signals.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </>
          )}

          {action === "owner" && (
            <select
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
              data-testid="bulk-owner-select"
              className="mb-3 w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent"
            >
              <option value="">Unassigned</option>
              {facets.owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}

          {action === "export" && (
            <div className="mb-3 grid gap-2">
              {EXPORT_FORMATS.map((f) => (
                <button
                  key={f}
                  data-testid={`export-format-${f}`}
                  disabled={!!progress}
                  onClick={() => void runExport(f)}
                  className={`rounded-[11px] border px-3.5 py-3 text-left transition-colors disabled:opacity-60 ${
                    exportFormat === f
                      ? "border-accent bg-accent-soft"
                      : "border-line bg-panel-2 hover:border-accent"
                  }`}
                  onMouseEnter={() => setExportFormat(f)}
                  onFocus={() => setExportFormat(f)}
                >
                  <b className="block text-[13px]">{FORMAT_LABEL[f]}</b>
                  <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted">
                    {FORMAT_HINT[f]}
                  </span>
                </button>
              ))}
              <p className="text-[11.5px] leading-relaxed text-muted">
                Exports the columns currently on screen, in the order they are on
                screen. Every export is recorded in the audit log.
              </p>
            </div>
          )}

          {action === "delete" && (
            <p className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3 py-2.5 text-[12.5px] text-[#FFB3C2]">
              This erases {count} lead{count === 1 ? "" : "s"} and the data
              derived from them. It cannot be undone, and every deletion is
              recorded in the audit log.
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={close} className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2">
              Cancel
            </button>
            <button
              // The export dialog's three format buttons ARE its confirm: a
              // fourth button after them would ask "which format?" twice.
              hidden={action === "export"}
              data-testid="bulk-confirm"
              disabled={
                !!progress ||
                (action === "stage" && stage === "DISQUALIFIED" && !reason.trim())
              }
              onClick={() => {
                if (action === "stage") {
                  void run((batch) =>
                    bulkChangeStage({
                      ids: batch,
                      toStage: stage,
                      reason: reason.trim() || undefined,
                      wakeUpAt: wakeUpAt ? new Date(wakeUpAt).toISOString() : undefined,
                    }),
                  );
                } else if (action === "signals") {
                  const split = (s: string) =>
                    s.split(",").map((t) => t.trim()).filter(Boolean);
                  void run((batch) =>
                    bulkEditSignals({
                      ids: batch,
                      add: split(addTags),
                      remove: split(removeTags),
                    }),
                  );
                } else if (action === "owner") {
                  void run((batch) =>
                    bulkAssignOwner({ ids: batch, ownerId: ownerId || null }),
                  );
                } else if (action === "delete") {
                  void run(async (batch) => {
                    const res = await bulkDeleteLeads(batch);
                    if (res.error) throw new Error(res.error);
                    return res;
                  }, "deleted");
                }
              }}
              className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
            >
              {action === "delete" ? `Delete ${count}` : "Apply"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
