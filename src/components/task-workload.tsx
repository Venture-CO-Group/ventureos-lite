"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_TASKS_PER_DAY,
  MINUTES_PER_DAY,
  formatHours,
  isOverloaded,
  loadAssumption,
  loadByDay,
  type DayLoad,
} from "@/modules/tasks/time-logic";
import {
  getWorkload,
  reassignTask,
  type WorkloadData,
  type WorkloadTaskRow,
} from "@/modules/tasks/workload-actions";
import { attempt } from "@/lib/client/server-action";
import { useToast } from "./toast";
import { StateCard } from "./state-card";

/**
 * Who is carrying what (playbook-v5 P19/3).
 *
 * ── THE ASSUMPTION IS IN THE HEADER, NOT A TOOLTIP ──────────────────────────
 *
 * The playbook is emphatic: a count-based load must not be presented as if it
 * were hours. So the mode is decided per DAY — a day whose tasks are all
 * estimated is reported in hours, a day where any is not is reported as a
 * count — and every cell says which it is. The header carries the sentence and
 * links to where the assumption is configured.
 *
 * Deciding once per person would have been simpler and dishonest: one
 * unestimated task would turn a whole week into a count, or an estimated day
 * would be labelled "4 tasks" when the real answer was known.
 *
 * ── UNASSIGNED IS A ROW ─────────────────────────────────────────────────────
 *
 * Work nobody owns is the work that gets forgotten. A capacity view that hides
 * it reports a team as comfortable with a pile of unowned tasks beside them.
 */
const UNASSIGNED = "__unassigned__";
const RANGE_DAYS = 14;

export function TaskWorkload({
  boardId,
  onOpen,
  onChanged,
}: {
  boardId: string | null;
  onOpen: (taskId: string) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<WorkloadData | null>(null);
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [tasksPerDay, setTasksPerDay] = useState(DEFAULT_TASKS_PER_DAY);
  const [byTeam, setByTeam] = useState(false);

  const load = useCallback(async () => {
    setData(
      await getWorkload({ from: from.toISOString(), days: RANGE_DAYS, boardId }).catch(() => ({
        tasks: [],
        members: [],
        days: [],
      })),
    );
  }, [from, boardId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    const tasksOf = (id: string | null) =>
      data.tasks
        .filter((t) => (t.assigneeId ?? null) === id)
        .map((t) => ({
          id: t.id,
          dueAt: t.dueAt ? new Date(t.dueAt) : null,
          estimateMinutes: t.estimateMinutes,
        }));

    const people = data.members.map((m) => ({
      key: m.id,
      label: m.name,
      teams: m.teams,
      tasks: data.tasks.filter((t) => t.assigneeId === m.id),
      load: loadByDay(tasksOf(m.id), data.days, tasksPerDay),
    }));

    // Last, and always present.
    people.push({
      key: UNASSIGNED,
      label: "Unassigned",
      teams: [],
      tasks: data.tasks.filter((t) => !t.assigneeId),
      load: loadByDay(tasksOf(null), data.days, tasksPerDay),
    });
    return people;
  }, [data, tasksPerDay]);

  const grouped = useMemo(() => {
    if (!byTeam) return [["Everybody", rows]] as [string, typeof rows][];
    const map = new Map<string, typeof rows>();
    for (const row of rows) {
      const keys = row.teams.length > 0 ? row.teams : ["No team"];
      for (const key of keys) map.set(key, [...(map.get(key) ?? []), row]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [byTeam, rows]);

  const anyEstimates = useMemo(
    () => (data?.tasks ?? []).some((t) => t.estimateMinutes !== null),
    [data],
  );

  const drop = useCallback(
    async (taskId: string, memberKey: string) => {
      if (!taskId) return;
      const res = await attempt(
        reassignTask(taskId, memberKey === UNASSIGNED ? null : memberKey),
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.offerUndo(res.undo);
      await load();
      onChanged();
    },
    [load, onChanged, toast],
  );

  if (!data) {
    return <p className="p-6 text-center text-[12.5px] text-muted">Loading the workload…</p>;
  }

  if (data.tasks.length === 0) {
    return (
      <StateCard mode="empty" title="nothing scheduled" testId="workload-empty" illustration="▤">
        Workload shows dated, unfinished work over the next fortnight. Give a task a due date and
        it appears here against whoever owns it.
      </StateCard>
    );
  }

  return (
    <div data-testid="task-workload">
      {/**
       * The assumption, said out loud. Which mode is in use depends on the
       * data, so the header states the general rule and every cell states its
       * own — because a "4" that means tasks and a "4h" that means hours must
       * never be mistakable.
       */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label="Previous fortnight"
          data-testid="workload-prev"
          onClick={() => setFrom((f) => new Date(f.getTime() - RANGE_DAYS * 86_400_000))}
          className="rounded-[8px] border border-line bg-panel px-2 py-1 text-[12px] text-muted hover:text-ink"
        >
          ‹
        </button>
        <span className="text-[12.5px] font-semibold text-ink">
          {from.toLocaleDateString("hu-HU", { month: "short", day: "numeric" })} —{" "}
          {new Date(from.getTime() + (RANGE_DAYS - 1) * 86_400_000).toLocaleDateString("hu-HU", {
            month: "short",
            day: "numeric",
          })}
        </span>
        <button
          type="button"
          aria-label="Next fortnight"
          data-testid="workload-next"
          onClick={() => setFrom((f) => new Date(f.getTime() + RANGE_DAYS * 86_400_000))}
          className="rounded-[8px] border border-line bg-panel px-2 py-1 text-[12px] text-muted hover:text-ink"
        >
          ›
        </button>

        <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <input
            type="checkbox"
            checked={byTeam}
            onChange={(e) => setByTeam(e.target.checked)}
            data-testid="workload-by-team"
            style={{ accentColor: "#7427C6" }}
          />
          Group by team
        </label>

        <label className="ml-auto flex items-center gap-1.5 text-[11.5px] text-muted">
          Tasks a day
          <input
            type="number"
            min={1}
            max={20}
            value={tasksPerDay}
            onChange={(e) => setTasksPerDay(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
            data-testid="workload-tasks-per-day"
            aria-label="Assumed tasks per day"
            className="w-[54px] rounded-[8px] border border-line bg-[rgba(0,5,29,0.6)] px-2 py-1 text-[12px] text-ink outline-none"
          />
        </label>
      </div>

      <p data-testid="workload-assumption" className="mb-2 text-[11.5px] text-muted">
        {loadAssumption(anyEstimates ? "estimates" : "count", tasksPerDay)}{" "}
        {anyEstimates && (
          <>
            Days with any unestimated work fall back to the count. A full day is{" "}
            {MINUTES_PER_DAY / 60} hours.
          </>
        )}
      </p>

      <div className="grid gap-3">
        {grouped.map(([team, members]) => (
          <div key={team}>
            {byTeam && (
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                {team}
              </p>
            )}
            <div className="overflow-x-auto rounded-card border border-line bg-panel">
              <table className="w-full min-w-[720px] border-collapse text-[12px]">
                <thead>
                  <tr>
                    <th className="w-[160px] border-b border-line px-2.5 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                      Who
                    </th>
                    {data.days.map((day) => (
                      <th
                        key={day}
                        className="border-b border-line px-1 py-2 text-[9.5px] font-semibold text-muted"
                      >
                        {day.slice(8)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {members.map((row) => (
                    <tr
                      key={`${team}:${row.key}`}
                      data-testid="workload-row"
                      data-member={row.key}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        void drop(e.dataTransfer.getData("text/plain"), row.key);
                      }}
                    >
                      <td className="border-b border-line px-2.5 py-1.5 align-top">
                        <span className={row.key === UNASSIGNED ? "text-warn" : "text-ink"}>
                          {row.label}
                        </span>
                        <span className="ml-1 text-[10.5px] text-muted">
                          {row.tasks.length}
                        </span>
                        {/* Draggable chips, so a task can be moved to another row. */}
                        <span className="mt-1 flex flex-wrap gap-1">
                          {row.tasks.slice(0, 6).map((t) => (
                            <button
                              key={t.id}
                              type="button"
                              draggable
                              onDragStart={(e) => {
                                e.dataTransfer.setData("text/plain", t.id);
                                e.dataTransfer.effectAllowed = "move";
                              }}
                              onClick={() => onOpen(t.id)}
                              data-testid="workload-task"
                              data-task-id={t.id}
                              title={taskTitle(t)}
                              className="max-w-[130px] cursor-grab truncate rounded-[5px] border border-line bg-panel-2 px-1.5 py-px text-[10px] text-[#C9CEE3]"
                            >
                              {t.title}
                            </button>
                          ))}
                          {row.tasks.length > 6 && (
                            <span className="text-[10px] text-muted">
                              +{row.tasks.length - 6}
                            </span>
                          )}
                        </span>
                      </td>

                      {row.load.map((day) => (
                        <td
                          key={day.day}
                          data-testid="workload-cell"
                          data-mode={day.mode}
                          data-overloaded={isOverloaded(day) ? "true" : "false"}
                          title={cellTitle(day)}
                          className={`border-b border-line px-1 py-1.5 text-center align-top text-[10px] tabular-nums ${
                            isOverloaded(day)
                              ? "bg-[rgba(255,92,122,0.16)] text-[#FFB3C2]"
                              : day.load > 0
                                ? "text-muted"
                                : "text-muted/40"
                          }`}
                        >
                          {day.taskCount === 0
                            ? "·"
                            : day.mode === "estimates"
                              ? formatHours(day.estimatedMinutes)
                              : `${day.taskCount}×`}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-1.5 text-[10.5px] text-muted">
        A cell reading <b className="text-ink">4×</b> is four TASKS, not four hours — only cells
        showing an <b className="text-ink">h</b> are hours. Drag a task onto another row to
        reassign it.
      </p>
    </div>
  );
}

function taskTitle(t: WorkloadTaskRow): string {
  const due = t.dueAt ? new Date(t.dueAt).toLocaleDateString("hu-HU") : "no date";
  const estimate = t.estimateMinutes !== null ? formatHours(t.estimateMinutes) : "no estimate";
  return `${t.title} · ${due} · ${estimate}`;
}

/** Never a bare number: the unit is the whole point. */
function cellTitle(day: DayLoad): string {
  if (day.taskCount === 0) return `${day.day}: nothing`;
  if (day.mode === "estimates") {
    return `${day.day}: ${formatHours(day.estimatedMinutes)} estimated across ${day.taskCount} task${day.taskCount === 1 ? "" : "s"}`;
  }
  return `${day.day}: ${day.taskCount} task${day.taskCount === 1 ? "" : "s"} — not all estimated, so this is a count rather than hours`;
}
