"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  WORK_BUCKETS,
  WORK_BUCKET_LABEL,
  WORK_BUCKET_RULE,
  bucketWork,
  type WorkBucket,
} from "@/modules/tasks/logic";
import { PRIORITY_CLASS, PRIORITY_LABEL, type TaskPriority } from "@/modules/tasks/board-logic";
import type { MyWorkItem } from "@/modules/tasks/board-actions";
import { rescheduleToBucket, setTaskDone } from "@/modules/tasks/board-actions";
import { editTaskField } from "@/modules/tasks/inline-actions";
import { InlineEdit } from "./inline-edit";
import { useToast } from "./toast";
import { StateCard } from "./state-card";
import { attempt } from "@/lib/client/server-action";

/**
 * My Work — everything on me, across every board (playbook-v5 P18/1).
 *
 * ── WHAT THIS IS FOR, AND WHY IT IS NOT A BOARD ─────────────────────────────
 *
 * A board answers "where is everything". This answers "what do I do next",
 * which is a sort across all of them PLUS the work that has no board at all —
 * follow-ups raised from a lead, a signal's suggested call, a callback
 * reminder. Those have existed since long before boards did (`boardId` is
 * nullable and must stay so), and they are precisely the tasks a
 * board-shaped screen cannot show.
 *
 * ── THE BUCKETS COME FROM THE SAME FUNCTION AS THE DASHBOARD ────────────────
 *
 * `bucketWork` subdivides `bucketOf`'s answer rather than forming its own, so
 * the Today Queue and this screen cannot disagree about what is due — the
 * playbook's requirement, and a unit test asserts it directly.
 *
 * ── AND THE DROP RULE IS WRITTEN DOWN ───────────────────────────────────────
 *
 * "Drag into Later" has no obvious date, so each bucket states what dropping
 * into it does. Overdue is not a destination: nobody means "make this late".
 */
type Grouping = "bucket" | "board" | "priority" | "entity";

const GROUPING_LABEL: Record<Grouping, string> = {
  bucket: "By date",
  board: "By board",
  priority: "By priority",
  entity: "By lead",
};

export function MyWork({
  items,
  includeCollaborating,
  onIncludeCollaboratingChange,
  onChanged,
  onOpen,
}: {
  items: MyWorkItem[];
  /** Whether work somebody else owns but you are helping with is in the list. */
  includeCollaborating: boolean;
  onIncludeCollaboratingChange: (next: boolean) => void;
  onChanged: () => void;
  onOpen: (taskId: string) => void;
}) {
  const toast = useToast();
  const [grouping, setGrouping] = useState<Grouping>("bucket");
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const buckets = useMemo(() => bucketWork(items), [items]);

  /** The other three groupings, as ordered [heading, rows] pairs. */
  const groups = useMemo<[string, MyWorkItem[]][]>(() => {
    if (grouping === "bucket") {
      return WORK_BUCKETS.map((b) => [WORK_BUCKET_LABEL[b], buckets[b]]);
    }
    const key = (t: MyWorkItem) => {
      if (grouping === "board") return t.boardName ?? "Loose — no board";
      if (grouping === "priority") return PRIORITY_LABEL[(t.priority as TaskPriority) ?? "none"];
      return t.entityLabel ?? "Not linked to anything";
    };
    const map = new Map<string, MyWorkItem[]>();
    for (const item of items) {
      const k = key(item);
      map.set(k, [...(map.get(k) ?? []), item]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [grouping, items, buckets]);

  /**
   * The task id travels in `dataTransfer`, not in React state.
   *
   * `onDragOver` sets the hover highlight, which re-renders the list — and a
   * re-render of the element being dragged can cancel the drag in Chromium,
   * losing a `dragId` held in state. The drop then fires with nothing to move,
   * which is exactly how this failed the first time. `dataTransfer` is owned
   * by the browser for the life of the drag, so it cannot be lost this way;
   * `dragId` is now only the dimming.
   */
  const drop = useCallback(
    async (bucket: WorkBucket, id: string) => {
      setDragId(null);
      setOver(null);
      if (!id) return;
      const res = await attempt(rescheduleToBucket(id, bucket));
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.offerUndo(res.undo);
      onChanged();
    },
    [onChanged, toast],
  );

  if (items.length === 0) {
    return (
      <StateCard
        mode="empty"
        title="nothing is on you"
        testId="my-work-empty"
        illustration="✓"
        action={{ label: "Open a board", href: "/tasks" }}
      >
        Work assigned to you shows up here from every board, along with follow-ups raised from
        a lead that never needed one.
      </StateCard>
    );
  }

  return (
    <div data-testid="my-work">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.1em] text-muted">Group</span>
        {(Object.keys(GROUPING_LABEL) as Grouping[]).map((g) => (
          <button
            key={g}
            type="button"
            data-testid={`my-work-group-${g}`}
            aria-pressed={grouping === g}
            onClick={() => setGrouping(g)}
            className={`rounded-[8px] px-2.5 py-1 text-[12px] ${
              grouping === g ? "bg-panel-2 text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {GROUPING_LABEL[g]}
          </button>
        ))}

        {/**
         * The collaborator toggle (playbook-v5 P20/6), off by default: the
         * answer to "what do I owe" gets less useful the more it is padded
         * with work somebody else is accountable for.
         */}
        <label className="ml-auto flex items-center gap-1.5 text-[12px] text-muted">
          <input
            type="checkbox"
            checked={includeCollaborating}
            data-testid="my-work-collaborating"
            onChange={(e) => onIncludeCollaboratingChange(e.target.checked)}
            style={{ accentColor: "#7427C6" }}
          />
          Include what I am helping with
        </label>
      </div>

      <div className="grid gap-3">
        {groups.map(([heading, rows], index) => {
          const bucket = grouping === "bucket" ? WORK_BUCKETS[index] : null;
          const droppable = bucket !== null && bucket !== "overdue";
          return (
            <section
              key={heading}
              data-testid="my-work-group"
              data-bucket={bucket ?? undefined}
              onDragOver={(e) => {
                if (!droppable) return;
                e.preventDefault();
                setOver(heading);
              }}
              onDragLeave={() => setOver((o) => (o === heading ? null : o))}
              onDrop={(e) => {
                if (!droppable) return;
                e.preventDefault();
                void drop(bucket!, e.dataTransfer.getData("text/plain"));
              }}
              className={`rounded-card border bg-panel p-3 transition-colors ${
                over === heading ? "border-accent" : "border-line"
              }`}
            >
              <div className="mb-2 flex items-baseline gap-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                  {heading}
                </h3>
                <span className="text-[11px] tabular-nums text-muted">{rows.length}</span>
                {bucket && (
                  <span
                    data-testid="bucket-rule"
                    className="ml-auto text-[10.5px] text-muted"
                    title={WORK_BUCKET_RULE[bucket]}
                  >
                    {WORK_BUCKET_RULE[bucket]}
                  </span>
                )}
              </div>

              {rows.length === 0 ? (
                <p className="px-1 py-2 text-[12px] text-muted">
                  {droppable ? "Drop work here to schedule it." : "Nothing."}
                </p>
              ) : (
                <ul className="grid gap-1">
                  {rows.map((t) => (
                    <li
                      key={t.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", t.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragId(t.id);
                      }}
                      onDragEnd={() => setDragId(null)}
                      data-testid="my-work-row"
                      data-task-id={t.id}
                      className={`group flex flex-wrap items-center gap-2 rounded-[9px] border border-transparent px-2 py-[var(--row-py)] text-[12.5px] hover:border-line hover:bg-panel-2 ${
                        dragId === t.id ? "opacity-40" : ""
                      }`}
                    >
                      <button
                        type="button"
                        aria-label={`Complete ${t.title}`}
                        data-testid="my-work-complete"
                        onClick={async () => {
                          const res = await attempt(setTaskDone(t.id, true));
                          if ("undo" in res) toast.offerUndo(res.undo ?? null);
                          onChanged();
                        }}
                        className="grid h-[16px] w-[16px] flex-none place-items-center rounded-full border border-line text-[9px] text-transparent hover:border-accent hover:text-muted"
                      >
                        ✓
                      </button>

                      <button
                        type="button"
                        onClick={() => onOpen(t.id)}
                        className="min-w-0 flex-1 truncate text-left text-ink hover:underline"
                      >
                        {t.title}
                      </button>

                      {/* Which piece of work this came from — the first thing
                          somebody asks when they see a cross-board list. */}
                      {t.boardName ? (
                        <span
                          data-testid="my-work-board"
                          className="flex-none rounded-full bg-panel-2 px-2 py-0.5 text-[10px] text-muted"
                        >
                          {t.boardName}
                        </span>
                      ) : (
                        <span
                          data-testid="my-work-loose"
                          title="Raised from a lead or a signal — it has no board"
                          className="flex-none rounded-full border border-dashed border-line px-2 py-0.5 text-[10px] text-muted"
                        >
                          loose
                        </span>
                      )}

                      {/* Somebody else owns this one — say so, rather than
                          letting it read as work you are accountable for. */}
                      {t.collaborating && (
                        <span
                          data-testid="my-work-collaborator"
                          title="You are a collaborator — somebody else owns this"
                          className="flex-none rounded-full border border-accent-soft px-2 py-0.5 text-[10px] text-accent-ink"
                        >
                          helping
                        </span>
                      )}

                      {t.delegatedByName && (
                        <span
                          data-testid="my-work-delegated"
                          className="flex-none text-[10px] text-muted"
                        >
                          from {t.delegatedByName}
                        </span>
                      )}

                      {t.entityHref && (
                        <Link
                          href={t.entityHref}
                          data-testid="my-work-entity"
                          className="flex-none truncate text-[11px] text-accent-ink underline underline-offset-2"
                        >
                          {t.entityLabel}
                        </Link>
                      )}

                      {t.priority !== "none" && (
                        <span
                          className={`flex-none rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                            PRIORITY_CLASS[(t.priority as TaskPriority) ?? "none"]
                          }`}
                        >
                          <InlineEdit
                            kind="select"
                            label="priority"
                            value={t.priority}
                            options={(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => ({
                              value: p,
                              label: PRIORITY_LABEL[p],
                            }))}
                            display={PRIORITY_LABEL[(t.priority as TaskPriority) ?? "none"]}
                            onSave={async (next) => {
                              const res = await editTaskField({
                                taskId: t.id,
                                field: "priority",
                                value: next,
                              });
                              if (res.ok) onChanged();
                              return res;
                            }}
                          />
                        </span>
                      )}

                      {t.tags.map((tag) => (
                        <span
                          key={tag}
                          className="flex-none rounded-full bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted"
                        >
                          {tag}
                        </span>
                      ))}

                      {t.subtasks && (
                        <span
                          data-testid="my-work-subtasks"
                          className="flex-none text-[10.5px] tabular-nums text-muted"
                        >
                          ☑ {t.subtasks.done}/{t.subtasks.total}
                        </span>
                      )}

                      {/* Reported, never enforced: a blocked task can still be
                          ticked, but presenting it as the next thing to pick
                          up without saying so would be misleading. */}
                      {t.blockedCount > 0 && (
                        <span
                          data-testid="my-work-blocked"
                          title={`Waiting on ${t.blockedCount} unfinished task${t.blockedCount === 1 ? "" : "s"}`}
                          className="flex-none rounded-full bg-[rgba(245,184,65,0.14)] px-1.5 py-0.5 text-[10px] font-semibold text-warn"
                        >
                          blocked
                        </span>
                      )}

                      {/* So a person's own work is distinguishable from ours. */}
                      {t.source && (
                        <span
                          data-testid="my-work-source"
                          title={`Raised automatically · ${t.source}`}
                          className="flex-none text-[10.5px] italic text-muted"
                        >
                          auto
                        </span>
                      )}

                      <span className="flex-none text-[11px] tabular-nums text-muted">
                        <InlineEdit
                          kind="date"
                          label="due date"
                          value={t.dueAt ? new Date(t.dueAt).toISOString().slice(0, 10) : null}
                          display={
                            t.dueAt
                              ? new Date(t.dueAt).toLocaleDateString("hu-HU", {
                                  month: "short",
                                  day: "numeric",
                                })
                              : "no date"
                          }
                          onSave={async (next) => {
                            const res = await editTaskField({
                              taskId: t.id,
                              field: "dueAt",
                              value: next,
                            });
                            if (res.ok) onChanged();
                            return res;
                          }}
                        />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
