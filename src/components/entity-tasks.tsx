"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { completeTask, reopenTask } from "@/modules/tasks/actions";
import {
  addTaskForEntity,
  getEntityTasks,
  type EntityTaskPanelView,
  type EntityTaskRowView,
} from "@/modules/tasks/entity-task-actions";
import { ENTITY_NOUN, entityHref, taskHref, type EntityKind } from "@/modules/tasks/links";
import { PRIORITY_LABEL, isTaskPriority } from "@/modules/tasks/board-logic";
import { attempt, attemptData, attemptVoid } from "@/lib/client/server-action";
import { useToast } from "./toast";
import { ErrorState } from "./state-card";

/**
 * What is open on this lead, company, deal or project (playbook-v5 P20/4).
 *
 * ── ONE PANEL, FOUR SURFACES ────────────────────────────────────────────────
 *
 * Tasks already knew what they were about; the entity did not know what was
 * open on it. This is that direction, and it is one component rather than
 * four, because a task should look and behave the same wherever it is seen —
 * and because the union of the fast path and the link table is easy to get
 * subtly different in four places.
 *
 * ── LEAVING AND COMING BACK ─────────────────────────────────────────────────
 *
 * Every task title links to the task on its board, carrying `from` — the href
 * of the surface you left. The task detail turns that into a "back to…"
 * control, so following a task out of a lead and returning lands on the lead
 * rather than at the top of a list.
 */
function dueLabel(iso: string | null): { text: string; overdue: boolean } {
  if (!iso) return { text: "no date", overdue: false };
  const due = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, overdue: true };
  if (days === 0) return { text: "today", overdue: false };
  if (days === 1) return { text: "tomorrow", overdue: false };
  return { text: due.toLocaleDateString("hu-HU"), overdue: false };
}

function Row({
  row,
  from,
  onToggle,
}: {
  row: EntityTaskRowView;
  from: string;
  onToggle: (row: EntityTaskRowView) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const done = row.doneAt !== null;
  const due = dueLabel(row.dueAt);

  return (
    <li
      className="flex items-start gap-2.5 border-b border-[rgba(239,241,248,0.05)] py-[var(--row-py)] last:border-0"
      data-testid="entity-task-row"
      data-task-id={row.id}
    >
      <input
        type="checkbox"
        checked={done}
        disabled={busy}
        aria-label={done ? `Reopen ${row.title}` : `Complete ${row.title}`}
        data-testid="entity-task-toggle"
        style={{ accentColor: "#7427C6" }}
        className="mt-[3px] flex-none"
        onChange={async () => {
          setBusy(true);
          await onToggle(row);
          setBusy(false);
        }}
      />
      <div className="min-w-0 flex-1">
        <a
          href={taskHref(row, from)}
          data-testid="entity-task-open"
          className={`block truncate text-[12.5px] ${
            done ? "text-muted line-through" : "text-ink hover:text-accent-ink"
          }`}
          title={row.title}
        >
          {row.title}
        </a>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-muted">
          <span className={due.overdue ? "text-[#FFB0A0]" : undefined}>{due.text}</span>
          {row.boardName ? (
            <span data-testid="entity-task-board">{row.boardName}</span>
          ) : (
            // A loose task — raised from a lead, suggested by a signal — has
            // no board and never had one. Saying so beats an empty gap.
            <span title="Not on a board — it lives in My Work">loose</span>
          )}
          {row.priority !== "none" && (
            <span>{isTaskPriority(row.priority) ? PRIORITY_LABEL[row.priority] : row.priority}</span>
          )}
          {row.assigneeName && <span>{row.assigneeName}</span>}
          {row.source && <span title={`Raised by ${row.source}`}>raised from a signal</span>}
          {/**
           * This task's own entity is something else and it is here through a
           * link. Worth saying: a task mainly about the deal, showing under
           * the company, should be legible as exactly that.
           */}
          {!row.primary && <span data-testid="entity-task-linked">linked</span>}
        </span>
      </div>
    </li>
  );
}

export function EntityTasks({
  kind,
  entityId,
  from,
  onCountChange,
}: {
  kind: EntityKind;
  entityId: string;
  /** Where to come back to. Defaults to this entity's own href. */
  from?: string;
  /** So an entity header can show the badge without a second query. */
  onCountChange?: (openCount: number) => void;
}) {
  const toast = useToast();
  const [panel, setPanel] = useState<EntityTaskPanelView | null>(null);
  /** Set when the read itself failed, so the panel does not sit on "Loading…". */
  const [failed, setFailed] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const back = from ?? entityHref(kind, entityId);

  const load = useCallback(async () => {
    const next = await attemptData(getEntityTasks(kind, entityId));
    if (!next.ok) {
      // A panel stuck on "Loading…" forever is indistinguishable from a slow
      // network, and tells nobody there is anything to retry.
      setFailed(next.error);
      return;
    }
    setFailed(null);
    setPanel(next.data);
    onCountChange?.(next.data.openCount);
    // `onCountChange` is intentionally out of the dependency list: a parent
    // that passes a fresh closure each render would otherwise reload forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, entityId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Optimistic, and rolled back on failure — as everywhere else a task ticks. */
  async function toggle(row: EntityTaskRowView) {
    const previous = panel;
    const done = row.doneAt !== null;
    setPanel((current) =>
      current
        ? {
            ...current,
            open: current.open.map((r) =>
              r.id === row.id ? { ...r, doneAt: done ? null : new Date().toISOString() } : r,
            ),
            recentlyDone: current.recentlyDone.map((r) =>
              r.id === row.id ? { ...r, doneAt: done ? null : new Date().toISOString() } : r,
            ),
          }
        : current,
    );
    if (done) {
      const err = await attemptVoid(reopenTask(row.id));
      if (err) {
        setPanel(previous);
        toast.error(err);
        return;
      }
    } else {
      const res = await attempt(completeTask(row.id));
      if (!res.ok) {
        setPanel(previous);
        toast.error("error" in res ? res.error : "Could not complete the task.");
        return;
      }
      toast.offerUndo(res.undo ?? null);
    }
    await load();
  }

  const noun = ENTITY_NOUN[kind];

  return (
    <section
      className="grid gap-2 rounded-[11px] border border-line p-3"
      data-testid="entity-tasks"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Tasks</p>
        {panel && panel.openCount > 0 && (
          <span
            data-testid="entity-tasks-count"
            className="rounded-full border border-line px-1.5 text-[10.5px] tabular-nums text-muted"
          >
            {panel.openCount} open
          </span>
        )}
        {panel && panel.doneCount > 0 && (
          <span className="text-[10.5px] tabular-nums text-muted">{panel.doneCount} done</span>
        )}
      </div>

      {failed ? (
        <ErrorState
          title="the tasks did not load"
          detail={failed}
          inset
          onRetry={() => {
            setFailed(null);
            void load();
          }}
        />
      ) : !panel ? (
        <p className="text-[12px] text-muted">Loading…</p>
      ) : panel.open.length === 0 && panel.recentlyDone.length === 0 ? (
        <p className="text-[12px] text-muted">
          Nothing on this {noun} yet. Add the next step and it will show up in My Work too.
        </p>
      ) : (
        <>
          {panel.open.length > 0 && (
            <ul className="grid" data-testid="entity-tasks-open">
              {panel.open.map((row) => (
                <Row key={row.id} row={row} from={back} onToggle={toggle} />
              ))}
            </ul>
          )}

          {panel.recentlyDone.length > 0 && (
            <div data-testid="entity-tasks-done">
              <p className="mb-0.5 mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                Recently completed
                {panel.doneCount > panel.recentlyDone.length && (
                  <span className="ml-1.5 font-normal normal-case tracking-normal">
                    — {panel.recentlyDone.length} of {panel.doneCount}
                  </span>
                )}
              </p>
              <ul className="grid">
                {panel.recentlyDone.map((row) => (
                  <Row key={row.id} row={row} from={back} onToggle={toggle} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <input
        value={draft}
        maxLength={200}
        disabled={pending}
        placeholder={`Add a task for this ${noun} — Enter to save`}
        aria-label={`Add a task for this ${noun}`}
        data-testid="entity-task-input"
        className="rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || draft.trim().length < 2) return;
          const title = draft;
          startTransition(async () => {
            const res = await attempt(addTaskForEntity({ kind, entityId, title }));
            if (!res.ok) {
              toast.error(res.error);
              return;
            }
            setDraft("");
            await load();
          });
        }}
      />
    </section>
  );
}
