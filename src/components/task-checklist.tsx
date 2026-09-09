"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CHECKLIST_VS_SUBTASK,
  MAX_ITEM_LENGTH,
  progressLabel,
  progressOf,
} from "@/modules/tasks/checklist-logic";
import {
  addChecklistStep,
  deleteChecklistStep,
  getChecklist,
  promoteChecklistStep,
  renameChecklistStep,
  tickChecklistStep,
} from "@/modules/tasks/checklist-actions";
import { attempt } from "@/lib/client/server-action";
import { useToast } from "./toast";
import { InlineEdit } from "./inline-edit";

/**
 * The checklist (playbook-v5 P20/3).
 *
 * ── THE ONE-LINER IS THE FEATURE ────────────────────────────────────────────
 *
 * Two controls sit side by side in this panel and nobody knows which to reach
 * for unless told, so the distinction is printed: a checklist is the steps
 * within this task; a subtask is work someone else may own. The answer decides
 * whether the thing can be assigned, scheduled and reported on, which is not a
 * detail.
 *
 * ── TICKING EVERYTHING DOES NOT COMPLETE THE TASK ───────────────────────────
 *
 * Nothing here writes the task's `doneAt`, deliberately — the same rule as
 * subtasks, for the same reason: deciding the work is finished belongs to
 * whoever can see whether the last step was real.
 */
export function TaskChecklist({ taskId, onPromoted }: { taskId: string; onPromoted: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<
    { id: string; text: string; doneAt: string | null; position: number }[]
  >([]);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    setItems(await getChecklist(taskId).catch(() => []));
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const progress = progressOf(items.map((i) => ({ doneAt: i.doneAt ? new Date(i.doneAt) : null })));
  const label = progressLabel(progress);

  return (
    <div className="mb-3" data-testid="task-checklist">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          Checklist
        </span>
        {label && (
          <span data-testid="checklist-progress" className="text-[11px] tabular-nums text-muted">
            {label}
          </span>
        )}
      </div>

      {/* The distinction, said once, where the choice is made. */}
      <p className="mb-1.5 text-[11px] text-muted">{CHECKLIST_VS_SUBTASK}</p>

      <ul className="grid gap-1">
        {items.map((item) => (
          <li key={item.id} className="group flex items-center gap-2 text-[12.5px]">
            <input
              type="checkbox"
              checked={item.doneAt !== null}
              onChange={async (e) => {
                /**
                 * The box moves at once and is put back if the write fails.
                 * Without this it is a controlled input whose `checked` only
                 * changes after a round trip, so the tick visibly springs
                 * back under the cursor — which reads as "it did not work".
                 */
                const next = e.target.checked;
                setItems((current) =>
                  current.map((i) =>
                    i.id === item.id
                      ? { ...i, doneAt: next ? new Date().toISOString() : null }
                      : i,
                  ),
                );
                const res = await attempt(tickChecklistStep(item.id, next));
                if (!res.ok) {
                  toast.error(res.error);
                }
                await load();
              }}
              data-testid="checklist-tick"
              aria-label={item.text}
              style={{ accentColor: "#7427C6" }}
              className="flex-none"
            />
            <span
              className={`min-w-0 flex-1 ${item.doneAt ? "text-muted line-through" : "text-ink"}`}
            >
              <InlineEdit
                kind="text"
                label="step"
                value={item.text}
                display={item.text}
                onSave={async (next) => {
                  const res = await attempt(
                    renameChecklistStep({ itemId: item.id, text: String(next ?? "") }),
                  );
                  if (!res.ok) return res;
                  await load();
                  return { ok: true as const, value: next };
                }}
              />
            </span>

            {/* The escape hatch: it turned out to need an owner and a date. */}
            <button
              type="button"
              data-testid="checklist-promote"
              title="Make this a subtask — it can then be assigned and scheduled"
              aria-label={`Promote ${item.text} to a subtask`}
              onClick={async () => {
                const res = await attempt(promoteChecklistStep(item.id));
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                toast.success("Promoted to a subtask.");
                await load();
                onPromoted();
              }}
              className="flex-none text-[11px] text-muted opacity-0 transition-opacity hover:text-accent-ink focus-visible:opacity-100 group-hover:opacity-100"
            >
              ↑ subtask
            </button>
            <button
              type="button"
              aria-label={`Remove ${item.text}`}
              data-testid="checklist-remove"
              onClick={async () => {
                const res = await attempt(deleteChecklistStep(item.id));
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                await load();
              }}
              className="flex-none text-[12px] text-muted opacity-0 transition-opacity hover:text-[#FFB3C2] focus-visible:opacity-100 group-hover:opacity-100"
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <input
        value={draft}
        maxLength={MAX_ITEM_LENGTH}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={async (e) => {
          if (e.key !== "Enter" || draft.trim().length === 0) return;
          const res = await attempt(addChecklistStep({ taskId, text: draft }));
          if (!res.ok) {
            toast.error(res.error);
            return;
          }
          setDraft("");
          await load();
        }}
        placeholder="Add a step — Enter to save"
        aria-label="Add a checklist step"
        data-testid="checklist-input"
        className="mt-1.5 w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent"
      />
    </div>
  );
}
