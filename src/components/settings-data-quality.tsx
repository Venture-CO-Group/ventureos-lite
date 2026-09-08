"use client";
import { attempt } from "@/lib/client/server-action";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  dismissDuplicatePair,
  getMergePreview,
  performMerge,
  restoreDuplicatePair,
  undoMerge,
  type DataQualityView,
} from "@/modules/merge/actions";
import type { MergePreview } from "@/modules/merge/store";
import type { FieldChoice } from "@/modules/merge/detect";
import { rollbackBatch } from "@/modules/import/actions";
import type { RollbackConflict } from "@/modules/import/store";

/**
 * Settings → Data quality (playbook-v2 P5/2 and P5/3).
 *
 * Two lists that answer two different questions: what looks duplicated, and
 * what has been imported. Neither does anything on its own — a merge and a
 * rollback are both explicit, and a merge shows the field-by-field comparison
 * first, because the point of the screen is that a person looks before two
 * records become one.
 */

const BTN =
  "min-h-[36px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
/**
 * How many candidate pairs the panel shows at once.
 *
 * A cap exists because a workspace with similarly-named companies can produce
 * hundreds of pairs, and a list nobody scrolls is a list nobody reads. What was
 * missing was saying so: see the note beside the list.
 */
const DUPLICATE_LIMIT = 25;

const LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted";

function confidenceChip(confidence: number): string {
  if (confidence >= 95) return "bg-[rgba(255,92,122,0.14)] text-[#FFB3C2]";
  if (confidence >= 75) return "bg-accent-soft text-accent-ink";
  return "bg-panel text-muted";
}

export function SettingsDataQuality({ view }: { view: DataQualityView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [choices, setChoices] = useState<Record<string, FieldChoice>>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<RollbackConflict[]>([]);

  /**
   * One runner for the small mutations, so none of them can fail in silence.
   */
  function run(
    fn: () => Promise<{ ok: boolean; error?: string }>,
    okText: string,
  ) {
    setError(null);
    setNote(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        setError(res.error ?? "That did not work.");
        return;
      }
      setNote(okText);
      router.refresh();
    });
  }

  function open(entity: "company" | "lead", survivorId: string, loserId: string) {
    setError(null);
    setNote(null);
    startTransition(async () => {
      const res = await attempt(getMergePreview({ entity, survivorId, loserId }));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPreview(res.preview);
      setChoices(Object.fromEntries(res.preview.fields.map((f) => [f.field, f.suggested])));
    });
  }

  function commit() {
    if (!preview) return;
    setError(null);
    startTransition(async () => {
      const res = await attempt(performMerge({
        entity: preview.entity,
        survivorId: preview.survivorId,
        loserId: preview.loserId,
        choices,
      }));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const moved = Object.entries(res.moved)
        .map(([k, n]) => `${n} ${k}`)
        .join(", ");
      setPreview(null);
      setNote(`Merged. ${moved || "Nothing"} re-linked — undoable for 30 days.`);
      router.refresh();
    });
  }

  function revert(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await attempt(undoMerge(id));
      if (!res.ok) setError(res.error);
      else {
        setNote(`Merge undone — ${res.restored} row(s) put back.`);
        router.refresh();
      }
    });
  }

  function rollback(batchId: string) {
    setError(null);
    setConflicts([]);
    startTransition(async () => {
      const res = await attempt(rollbackBatch(batchId));
      if (!res.ok) {
        setError(res.error);
        // `attempt` can also answer with a bare { ok:false, error } when the
        // action threw, and that shape carries no conflict list.
        setConflicts("conflicts" in res ? (res.conflicts ?? []) : []);
        return;
      }
      setNote(`Import rolled back — ${res.deleted} deleted, ${res.reverted} reverted.`);
      router.refresh();
    });
  }

  const nothing = view.companies.length === 0 && view.leads.length === 0;

  return (
    <section
      data-testid="settings-data-quality"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <h2 className="mb-1 font-display text-[18px] lowercase tracking-display">data quality</h2>
      <p className="mb-4 max-w-[620px] text-[12.5px] text-muted">
        Records that look like the same company or the same person, and every import that
        has run. Merging moves every activity, document and deal onto the survivor and
        leaves the other as a tombstone, so old links still resolve — undoable for 30 days.
        An import is undoable for 7.
      </p>

      {error && <p className="mb-3 text-[12.5px] text-[#FFB3C2]">{error}</p>}
      {conflicts.length > 0 && (
        <ul
          className="mb-3 grid gap-1 rounded-[10px] border border-[rgba(255,176,66,0.4)] bg-[rgba(255,176,66,0.08)] px-3 py-2"
          data-testid="rollback-conflicts"
        >
          {conflicts.map((c) => (
            <li key={c.id} className="text-[12px] text-[#FFD79A]">
              <b>{c.label}</b> — {c.reason}
            </li>
          ))}
        </ul>
      )}
      {note && <p className="mb-3 text-[12.5px] text-pos">{note}</p>}

      {nothing ? (
        <p className="mb-4 text-[12.5px] text-muted" data-testid="no-duplicates">
          Nothing looks duplicated.
        </p>
      ) : (
        <div className="mb-4 grid gap-3">
          {(["companies", "leads"] as const).map((group) => {
            const rows = view[group];
            if (rows.length === 0) return null;
            const entity = group === "companies" ? "company" : "lead";
            return (
              <div key={group}>
                <p className={`${LABEL} mb-1.5`}>{group}</p>
                <ul className="grid gap-1.5" data-testid={`duplicates-${group}`}>
                  {rows.slice(0, DUPLICATE_LIMIT).map((c) => (
                    <li
                      key={`${c.aId}:${c.bId}`}
                      className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-[rgba(0,5,29,0.35)] px-3 py-2 text-[12.5px]"
                    >
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${confidenceChip(c.confidence)}`}
                      >
                        {c.confidence}%
                      </span>
                      <span className="min-w-0 flex-1 truncate">{c.detail}</span>
                      {view.canMerge && (
                        <button
                          type="button"
                          className={BTN}
                          disabled={pending}
                          data-testid="duplicate-dismiss"
                          title="Record that these two are different records, so this pair stops being offered."
                          onClick={() =>
                            run(
                              () =>
                                dismissDuplicatePair({
                                  entity,
                                  aId: c.aId,
                                  bId: c.bId,
                                  reason:
                                    window.prompt("Why are these different? (optional)") ??
                                    undefined,
                                }),
                              "Noted — that pair will not be offered again.",
                            )
                          }
                        >
                          Not a duplicate
                        </button>
                      )}
                      {view.canMerge && (
                        <button
                          type="button"
                          className={BTN}
                          disabled={pending}
                          data-testid="merge-open"
                          onClick={() => open(entity, c.aId, c.bId)}
                        >
                          Compare…
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {/*
                  The list is capped, and silence about it is the problem: with
                  thirty near-identical pairs the panel looked complete while
                  hiding most of them. Candidates are already ordered by
                  confidence, so the ones on screen are the ones worth looking
                  at first — but the reader has to know there are more.
                */}
                {rows.length > DUPLICATE_LIMIT && (
                  <p className="mt-1.5 text-[11.5px] text-muted" data-testid={`duplicates-more-${group}`}>
                    {rows.length - DUPLICATE_LIMIT} more, ordered behind these by
                    confidence. Merge or dismiss some to see the rest.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/*
        What has been dismissed, and a way back.

        A one-way "not a duplicate" button is worse than no button: the pair
        disappears and nobody can learn it ever existed, so a mis-click quietly
        hides a real duplicate for ever.
      */}
      {view.dismissed.length > 0 && (
        <div className="mb-4">
          <p className={`${LABEL} mb-1.5`}>not duplicates</p>
          <ul className="grid gap-1.5" data-testid="dismissed-pairs">
            {view.dismissed.map((d) => (
              <li
                key={`${d.entity}:${d.aId}:${d.bId}`}
                className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-[rgba(0,5,29,0.35)] px-3 py-2 text-[12.5px]"
              >
                <span className="rounded-full bg-panel-2 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted">
                  {d.entity}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted">
                  {d.label}
                  {d.reason ? ` — ${d.reason}` : ""}
                </span>
                {view.canMerge && (
                  <button
                    type="button"
                    className={BTN}
                    disabled={pending}
                    data-testid="duplicate-restore"
                    onClick={() =>
                      run(
                        () =>
                          restoreDuplicatePair({
                            entity: d.entity as "company" | "lead",
                            aId: d.aId,
                            bId: d.bId,
                          }),
                        "Back on the review list.",
                      )
                    }
                  >
                    Put it back
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.history.length > 0 && (
        <div>
          <p className={`${LABEL} mb-1.5`}>Recent merges</p>
          <ul className="grid gap-1.5" data-testid="merge-history">
            {view.history.slice(0, 15).map((h) => (
              <li
                key={h.id}
                className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line px-3 py-2 text-[12.5px]"
              >
                <span className="min-w-0 flex-1 truncate">
                  <b>{h.loserLabel}</b> → <b>{h.survivorLabel}</b>
                  <span className="ml-2 text-[11px] text-muted">{h.at.slice(0, 10)}</span>
                </span>
                {h.revertedAt ? (
                  <span className="text-[11px] text-muted">undone</span>
                ) : h.canRevert ? (
                  view.canMerge && (
                    <button
                      type="button"
                      className={BTN}
                      disabled={pending}
                      data-testid="merge-undo"
                      onClick={() => revert(h.id)}
                    >
                      Undo
                    </button>
                  )
                ) : (
                  <span className="text-[11px] text-muted">window closed</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.batches.length > 0 && (
        <div className="mt-4">
          <p className={`${LABEL} mb-1.5`}>Imports</p>
          <ul className="grid gap-1.5" data-testid="import-batches">
            {view.batches.slice(0, 15).map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line px-3 py-2 text-[12.5px]"
              >
                <span className="min-w-0 flex-1 truncate">
                  <b>{b.filename ?? "(unnamed file)"}</b>
                  <span className="ml-2 text-[11px] text-muted tabular-nums">
                    {b.created} created · {b.updated} updated · {b.skipped} skipped ·{" "}
                    {b.at.slice(0, 10)}
                  </span>
                </span>
                {b.rolledBackAt ? (
                  <span className="text-[11px] text-muted">rolled back</span>
                ) : b.canRollback && view.canRollback ? (
                  <button
                    type="button"
                    className={BTN}
                    disabled={pending}
                    data-testid="import-rollback"
                    onClick={() => rollback(b.id)}
                  >
                    Roll back
                  </button>
                ) : (
                  <span className="text-[11px] text-muted">window closed</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <div className="max-h-[90vh] w-full max-w-[720px] overflow-y-auto rounded-card border border-line bg-[rgba(6,11,38,0.98)] p-5 backdrop-blur">
            <div className="mb-3 flex items-center">
              <b className="text-[13px]">
                Merge {preview.loserLabel} into {preview.survivorLabel}
              </b>
              <button
                onClick={() => setPreview(null)}
                className="ml-auto text-muted hover:text-ink"
              >
                ✕
              </button>
            </div>

            <table className="mb-4 w-full border-collapse text-[12.5px]">
              <thead>
                <tr className={LABEL}>
                  <th className="pb-2 pr-2 text-left font-semibold">Field</th>
                  <th className="pb-2 pr-2 text-left font-semibold">
                    Survivor — {preview.survivorLabel}
                  </th>
                  <th className="pb-2 text-left font-semibold">Other — {preview.loserLabel}</th>
                </tr>
              </thead>
              <tbody data-testid="merge-fields">
                {preview.fields.map((f) => (
                  <tr key={f.field} className="border-t border-line">
                    <td className="py-1.5 pr-2 text-muted">{f.field}</td>
                    {(["survivor", "loser"] as const).map((side) => {
                      const value = side === "survivor" ? f.survivorValue : f.loserValue;
                      const on = (choices[f.field] ?? f.suggested) === side;
                      return (
                        <td key={side} className="py-1.5 pr-2">
                          <button
                            type="button"
                            onClick={() => setChoices((c) => ({ ...c, [f.field]: side }))}
                            className={`w-full rounded-[8px] border px-2 py-1 text-left ${
                              on
                                ? "border-accent bg-accent-soft text-[#E4D3FF]"
                                : "border-line text-muted hover:text-ink"
                            }`}
                          >
                            {value === null || value === undefined || value === ""
                              ? "—"
                              : String(value)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="mb-4 text-[12px] text-muted">
              Moving onto the survivor:{" "}
              {Object.entries(preview.impact)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${n} ${k}`)
                .join(", ") || "nothing"}
              .
            </p>

            <div className="flex justify-end gap-2">
              <button onClick={() => setPreview(null)} className={BTN}>
                Cancel
              </button>
              <button
                onClick={commit}
                disabled={pending}
                data-testid="merge-confirm"
                className="min-h-[40px] rounded-[9px] bg-grad px-3.5 py-2 text-[12.5px] font-semibold text-ink disabled:opacity-45"
              >
                {pending ? "Merging…" : "Merge"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
