"use client";

import { useState } from "react";
import { attempt } from "@/lib/client/server-action";
import {
  patchTaskView,
  removeTaskView,
  saveTaskView,
} from "@/modules/tasks/board-view-actions";
import type { TaskBoardView } from "@/modules/tasks/board-views";
import type { GroupBy, TaskFilter } from "@/modules/tasks/grouping";
import { filterIsEmpty } from "@/modules/tasks/grouping";

/**
 * Saved views, as tabs above a board (playbook-v5 P18/2).
 *
 * The same shape as the leads table's tab strip, on the same table and the
 * same sharing rules — a view is personal until somebody shares it, only its
 * creator edits their own, and a seated member may curate the shared ones. The
 * rules live in modules/leads/views.ts and are imported, not re-implemented.
 *
 * "Update" appears only when the current arrangement differs from the tab it
 * came from, which is the leads strip's behaviour and the reason a tab can be
 * trusted to still mean what it says.
 */
export function BoardViewTabs({
  views,
  activeId,
  currentUserId,
  current,
  onOpen,
  onChanged,
}: {
  views: TaskBoardView[];
  activeId: string | null;
  currentUserId: string;
  /** What the board is showing right now, for saving and for the diff. */
  current: { boardId: string | null; groupBy: GroupBy; filter: TaskFilter };
  onOpen: (view: TaskBoardView | null) => void;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = views.find((v) => v.id === activeId) ?? null;
  const drifted =
    active !== null &&
    (active.groupBy !== current.groupBy ||
      active.boardId !== current.boardId ||
      JSON.stringify(active.filter) !== JSON.stringify(current.filter));

  async function save() {
    setError(null);
    const res = await attempt(
      saveTaskView({ name, shared, ...current }),
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSaving(false);
    setName("");
    setShared(false);
    onChanged();
  }

  return (
    <div className="mb-3" data-testid="board-view-tabs">
      {error && (
        <p className="mb-2 text-[12px] text-[#FFB3C2]" role="status">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5 border-b border-line pb-2">
        <button
          type="button"
          data-testid="board-view-all"
          aria-current={activeId === null ? "page" : undefined}
          onClick={() => onOpen(null)}
          className={`rounded-[10px] border px-3 py-1.5 text-[12.5px] ${
            activeId === null
              ? "border-accent bg-accent-soft text-[#E4D3FF]"
              : "border-line bg-panel text-muted hover:text-ink"
          }`}
        >
          Everything
        </button>

        {views.map((v) => (
          <span key={v.id} className="group inline-flex items-center">
            <button
              type="button"
              data-testid="board-view-tab"
              aria-current={v.id === activeId ? "page" : undefined}
              onClick={() => onOpen(v)}
              className={`rounded-[10px] border px-3 py-1.5 text-[12.5px] ${
                v.id === activeId
                  ? "border-accent bg-accent-soft text-[#E4D3FF]"
                  : "border-line bg-panel text-muted hover:text-ink"
              }`}
            >
              {v.name}
              {v.shared && (
                <span
                  data-testid="board-view-shared"
                  title="Shared with the workspace"
                  className="ml-1.5 text-[10px] text-accent-ink"
                >
                  shared
                </span>
              )}
            </button>
            {(v.ownerId === currentUserId || v.shared) && (
              <button
                type="button"
                aria-label={`Delete view ${v.name}`}
                data-testid="board-view-delete"
                onClick={async () => {
                  const res = await attempt(removeTaskView(v.id));
                  if (!res.ok) {
                    setError(res.error);
                    return;
                  }
                  if (v.id === activeId) onOpen(null);
                  onChanged();
                }}
                className="ml-0.5 rounded px-1 text-[11px] text-muted opacity-40 transition-opacity hover:text-[#FFB3C2] hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
              >
                ✕
              </button>
            )}
          </span>
        ))}

        {/* Only offered when there is something to absorb. */}
        {drifted && (
          <button
            type="button"
            data-testid="board-view-update"
            onClick={async () => {
              const res = await attempt(patchTaskView(active!.id, current));
              if (!res.ok) {
                setError(res.error);
                return;
              }
              onChanged();
            }}
            className="rounded-[10px] border border-warn/40 bg-[rgba(245,184,65,0.1)] px-2.5 py-1.5 text-[12px] text-warn"
          >
            Update “{active!.name}”
          </button>
        )}

        {saving ? (
          <span className="flex items-center gap-1.5">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") setSaving(false);
              }}
              placeholder="View name"
              aria-label="View name"
              data-testid="board-view-name"
              className="w-[140px] rounded-[8px] border border-accent bg-[rgba(0,5,29,0.6)] px-2 py-1 text-[12px] text-ink outline-none"
            />
            <label className="flex items-center gap-1 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={shared}
                onChange={(e) => setShared(e.target.checked)}
                data-testid="board-view-shared-toggle"
                style={{ accentColor: "#7427C6" }}
              />
              Share
            </label>
            <button
              type="button"
              data-testid="board-view-save-confirm"
              disabled={name.trim().length === 0}
              onClick={() => void save()}
              className="rounded-[8px] border border-accent bg-accent-soft px-2 py-1 text-[12px] font-semibold text-[#E4D3FF] disabled:opacity-60"
            >
              Save
            </button>
          </span>
        ) : (
          <button
            type="button"
            data-testid="board-view-save"
            onClick={() => setSaving(true)}
            className="ml-auto rounded-[10px] border border-line bg-panel px-2.5 py-1.5 text-[12px] text-muted hover:text-ink"
          >
            {filterIsEmpty(current.filter) && current.groupBy === "section"
              ? "Save this board"
              : "Save this view"}
          </button>
        )}
      </div>
    </div>
  );
}
