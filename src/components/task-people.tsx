"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  addTaskCollaborator,
  getTaskPeople,
  removeTaskCollaborator,
  type TaskPeopleView,
} from "@/modules/tasks/collaborator-actions";
import type { WorkspaceMemberOption } from "@/modules/tasks/board-actions";
import { attempt } from "@/lib/client/server-action";
import { useToast } from "./toast";

/**
 * Collaborators and the handover trail (playbook-v5 P20/6).
 *
 * ── THE PANEL SAYS THE DIFFERENCE OUT LOUD ──────────────────────────────────
 *
 * There is one owner above this, and a list of people helping in it, and
 * anybody reading the card needs to know which is which. So the copy is
 * explicit: the assignee owes the task; a collaborator is doing some of it; a
 * follower is only watching. Without that sentence the natural reading of two
 * lists of names is "these people are all responsible", which is precisely the
 * state a board exists to prevent.
 */
export function TaskPeople({
  taskId,
  assigneeId,
  members,
  delegatedByName,
  onChanged,
}: {
  taskId: string;
  assigneeId: string | null;
  members: WorkspaceMemberOption[];
  /** Who handed this over, when somebody did. */
  delegatedByName: string | null;
  /** So the assignee picker's groups reload with the new collaborator. */
  onChanged: () => void;
}) {
  const toast = useToast();
  const [people, setPeople] = useState<TaskPeopleView | null>(null);
  const [adding, setAdding] = useState("");
  const [showTrail, setShowTrail] = useState(false);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    setPeople(await getTaskPeople(taskId).catch(() => null));
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const collaboratorIds = new Set((people?.collaborators ?? []).map((c) => c.userId));
  /** The assignee is not offered: they already own it. */
  const addable = members.filter((m) => m.id !== assigneeId && !collaboratorIds.has(m.id));

  return (
    <div className="mb-3" data-testid="task-people">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          Collaborators
        </span>
        {delegatedByName && (
          <span data-testid="task-delegated-by" className="text-[11px] text-muted">
            handed over by {delegatedByName}
          </span>
        )}
      </div>

      <p className="mb-1.5 text-[11px] text-muted">
        One person owns this task. Collaborators are working on it and see it in their own My
        Work; followers only watch.
      </p>

      {people && people.collaborators.length > 0 && (
        <ul className="mb-1.5 flex flex-wrap gap-1.5" data-testid="collaborator-list">
          {people.collaborators.map((c) => (
            <li
              key={c.userId}
              data-testid="collaborator"
              className="flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[11.5px]"
            >
              {c.name}
              <button
                type="button"
                disabled={pending}
                aria-label={`Remove ${c.name} as a collaborator`}
                data-testid="collaborator-remove"
                onClick={() =>
                  startTransition(async () => {
                    const res = await attempt(
                      removeTaskCollaborator({ taskId, userId: c.userId }),
                    );
                    if (!res.ok) {
                      toast.error(res.error);
                      return;
                    }
                    await load();
                    onChanged();
                  })
                }
                className="text-muted hover:text-[#FFB3C2]"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <select
        value={adding}
        disabled={pending || addable.length === 0}
        aria-label="Add a collaborator"
        data-testid="collaborator-add"
        onChange={(e) => {
          const userId = e.target.value;
          if (!userId) return;
          setAdding("");
          startTransition(async () => {
            const res = await attempt(addTaskCollaborator({ taskId, userId }));
            if (!res.ok) {
              toast.error(res.error);
              return;
            }
            await load();
            onChanged();
          });
        }}
        className="w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent"
      >
        <option value="">
          {addable.length === 0 ? "everybody is already on it" : "Add a collaborator…"}
        </option>
        {addable.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>

      {people && people.trail.length > 0 && (
        <>
          <button
            type="button"
            data-testid="task-trail-toggle"
            onClick={() => setShowTrail((v) => !v)}
            className="mt-1.5 text-[11px] text-accent-ink hover:underline"
          >
            {showTrail ? "Hide" : "Show"} who handed this over ({people.trail.length})
          </button>
          {showTrail && (
            <ul className="mt-1 grid gap-0.5" data-testid="task-trail">
              {people.trail.map((entry) => (
                <li key={entry.id} className="text-[11px] text-muted">
                  {entry.text}{" "}
                  <span className="tabular-nums">
                    {entry.at.slice(0, 16).replace("T", " ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
