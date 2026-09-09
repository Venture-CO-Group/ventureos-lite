"use client";
import { attemptVoid } from "@/lib/client/server-action";

import { useEffect, useState } from "react";
import {
  myTasks,
  tasksForEntity,
  createTask,
  completeTask,
  reopenTask,
  snoozeTask,
  type TaskView,
} from "@/modules/tasks/actions";
import { TYPE_LABEL, groupTasks, type TaskType } from "@/modules/tasks/logic";
import { useToast } from "./toast";

/**
 * Tasks (playbook-v2 P3/3).
 *
 * Two shapes from one component: the dashboard list grouped by urgency, and the
 * per-entity list on a lead. They share the row rendering because a task should
 * look and behave the same wherever it is seen.
 */
function dueLabel(dueAt: Date | null): string {
  if (!dueAt) return "no date";
  const now = new Date();
  const days = Math.round((dueAt.getTime() - now.setHours(0, 0, 0, 0)) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return dueAt.toLocaleDateString("hu-HU");
}

function TaskRow({
  task,
  onToggle,
  onChanged,
}: {
  task: TaskView;
  onToggle: (task: TaskView) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const done = task.doneAt !== null;

  return (
    <div className="flex items-start gap-2.5 border-b border-[rgba(239,241,248,0.05)] py-2">
      <input
        type="checkbox"
        checked={done}
        disabled={busy}
        onChange={async () => {
          setBusy(true);
          await onToggle(task);
          setBusy(false);
        }}
        className="mt-[3px]"
        style={{ accentColor: "#7427C6" }}
        aria-label={done ? "Reopen task" : "Complete task"}
      />
      <div className="min-w-0 flex-1">
        <div className={`text-[13px] ${done ? "text-muted line-through" : "text-[#C9CEE3]"}`}>
          {task.title}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
          <span className="rounded-full border border-line px-1.5">
            {TYPE_LABEL[task.type as TaskType] ?? task.type}
          </span>
          <span>{dueLabel(task.dueAt)}</span>
          {task.entityLabel && task.entityHref && (
            <a href={task.entityHref} className="truncate hover:text-ink">
              {task.entityLabel}
            </a>
          )}
          {/*
            The board it lives on, and a way to it (P8/4).

            This panel and the task board read the same rows and, until now,
            never mentioned each other — so the dashboard could show you a task
            with no route to the card, its subtasks, its comments or its
            dependencies. A task you can tick but not open is half a task.
          */}
          {task.boardName && task.boardHref && (
            <a
              href={task.boardHref}
              data-testid={`task-board-link-${task.id}`}
              className="truncate rounded-full border border-line px-1.5 hover:border-accent hover:text-ink"
            >
              {task.boardName}
            </a>
          )}
          {/*
            Waiting on something else. The board knew this and the dashboard
            did not, so a blocked task sat at the top of the morning list
            looking like the next thing to pick up.
          */}
          {task.blockedBy > 0 && (
            <span
              data-testid={`task-blocked-${task.id}`}
              title="Waiting on work that is not finished yet"
              className="rounded-full bg-[rgba(245,184,65,0.15)] px-1.5 text-[#FFD79A]"
            >
              waiting on {task.blockedBy}
            </span>
          )}
          {/* Where a task came from, so a person's own list is legible: "why is
              this here" should never need asking. */}
          {task.source && <span className="opacity-70">· auto</span>}
        </div>
        {task.note && <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{task.note}</p>}
        {failure && (
          <p role="alert" className="mt-1 text-[11.5px] text-[#FFB3C2]">
            {failure}
          </p>
        )}
      </div>
      {!done && (
        <button
          onClick={async () => {
            setBusy(true);
            setFailure(null);
            const failed = await attemptVoid(snoozeTask(task.id, 1));
            if (failed) {
              setFailure(failed);
              setBusy(false);
              return;
            }
            await onChanged();
            setBusy(false);
          }}
          disabled={busy}
          title="Push to tomorrow"
          className="flex-none text-[11px] text-muted hover:text-ink disabled:opacity-50"
        >
          +1d
        </button>
      )}
    </div>
  );
}

function NewTask({
  entity,
  onCreated,
}: {
  entity?: { entityType: "lead" | "company" | "document"; entityId: string };
  onCreated: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<TaskType>("todo");
  const [days, setDays] = useState(1);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={async (e) => {
          if (e.key !== "Enter" || !title.trim() || busy) return;
          setBusy(true);
          const due = new Date();
          due.setDate(due.getDate() + days);
          due.setHours(17, 0, 0, 0);
          setFailure(null);
          // The title is cleared only once the task exists. Clearing it first
          // meant a failed create silently ate what the operator had typed.
          const failed = await attemptVoid(
            createTask({ title, type, dueAt: due.toISOString(), ...entity }),
          );
          if (failed) {
            setFailure(failed);
            setBusy(false);
            return;
          }
          setTitle("");
          await onCreated();
          setBusy(false);
        }}
        placeholder="Add a task — Enter to save"
        className="min-w-[160px] flex-1 rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent"
      />
      <select
        value={type}
        onChange={(e) => setType(e.target.value as TaskType)}
        className="rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
      >
        {(["todo", "call", "email", "follow_up"] as TaskType[]).map((t) => (
          <option key={t} value={t}>
            {TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      <select
        value={days}
        onChange={(e) => setDays(Number(e.target.value))}
        className="rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
      >
        <option value={0}>today</option>
        <option value={1}>tomorrow</option>
        <option value={3}>+3d</option>
        <option value={7}>+1w</option>
      </select>
      {failure && (
        <p role="alert" className="w-full text-[11.5px] text-[#FFB3C2]">
          {failure}
        </p>
      )}
    </div>
  );
}

/**
 * The dashboard list: overdue first, then today, then what is coming.
 *
 * The first render comes from the SERVER as a prop, not from a fetch on mount.
 * The dashboard is the first thing loaded every morning, and a client round trip
 * there costs a visible flash plus real latency on a phone — which is how this
 * component briefly broke the mobile navigation tests.
 */
export function TasksPanel({ initial }: { initial: TaskView[] }) {
  const { offerUndo } = useToast();
  const [tasks, setTasks] = useState<TaskView[]>(initial);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const grouped = await myTasks();
    setTasks([...grouped.overdue, ...grouped.today, ...grouped.upcoming, ...grouped.someday]);
  }

  /**
   * Optimistic completion (P6/3).
   *
   * The tick moves immediately and the row re-groups; the server call follows.
   * If it fails, the previous list is put back exactly as it was and the reason
   * is shown — an optimistic update that cannot roll back is not optimism, it
   * is a lie the user finds out about on the next refresh.
   */
  async function toggle(task: TaskView) {
    const previous = tasks;
    const done = task.doneAt !== null;
    setError(null);
    setTasks((list) =>
      list.map((t) =>
        t.id === task.id ? { ...t, doneAt: done ? null : new Date() } : t,
      ),
    );
    try {
      if (done) {
        await reopenTask(task.id);
      } else {
        offerUndo((await completeTask(task.id)).undo);
      }
      await refresh();
    } catch {
      setTasks(previous);
      setError("That did not save. Nothing changed.");
    }
  }

  const grouped = groupTasks(tasks);

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]" data-testid="tasks-panel">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2 className="font-display text-[15px] font-bold lowercase tracking-display">
          your work
        </h2>
        {grouped.counts.overdue > 0 && (
          <span className="rounded-full bg-[rgba(255,92,122,0.15)] px-2 py-0.5 text-[11px] font-semibold text-[#FF5C7A]">
            {grouped.counts.overdue} overdue
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted">
          {grouped.counts.today} today · {grouped.counts.open} open
        </span>
        {/*
          The way through to the boards (P8/4).

          This panel and the task board are the same rows, and the dashboard
          never said so — there was no route from the morning list to the place
          the work is organised. It is the one link somebody wants from here
          after they have read the list.
        */}
        <a
          href="/tasks"
          data-testid="tasks-panel-boards"
          className="rounded-[8px] border border-line px-2 py-0.5 text-[11px] font-semibold text-muted hover:border-accent hover:text-ink"
        >
          All boards →
        </a>
      </div>

      {error && (
        <p className="mb-2 text-[12px] text-[#FFB3C2]" data-testid="task-error">
          {error}
        </p>
      )}

      {grouped.counts.open === 0 ? (
        <p className="text-[12.5px] text-muted">Nothing due. Add one below, or enjoy it.</p>
      ) : (
        <>
          {(
            [
              ["overdue", grouped.overdue],
              ["today", grouped.today],
              ["upcoming", grouped.upcoming],
              ["someday", grouped.someday],
            ] as const
          ).map(([label, list]) =>
            list.length === 0 ? null : (
              <div key={label} className="mt-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                  {label}
                </div>
                {list.map((t) => (
                  <TaskRow key={t.id} task={t} onToggle={toggle} onChanged={refresh} />
                ))}
              </div>
            ),
          )}
        </>
      )}

      <NewTask onCreated={refresh} />
    </div>
  );
}

/** The per-entity list, for a lead or a company. */
export function EntityTasks({
  entityType,
  entityId,
}: {
  entityType: "lead" | "company" | "document";
  entityId: string;
}) {
  const { offerUndo } = useToast();
  const [tasks, setTasks] = useState<TaskView[] | null>(null);

  async function refresh() {
    setTasks(await tasksForEntity(entityType, entityId));
  }

  /** Same optimism as the dashboard panel, same rollback on failure (P6/3). */
  async function toggleHere(task: TaskView) {
    const previous = tasks;
    const done = task.doneAt !== null;
    setTasks((list) =>
      (list ?? []).map((t) =>
        t.id === task.id ? { ...t, doneAt: done ? null : new Date() } : t,
      ),
    );
    try {
      if (done) {
        await reopenTask(task.id);
      } else {
        offerUndo((await completeTask(task.id)).undo);
      }
      await refresh();
    } catch {
      setTasks(previous);
    }
  }

  useEffect(() => {
    let active = true;
    tasksForEntity(entityType, entityId).then((t) => {
      if (active) setTasks(t);
    });
    return () => {
      active = false;
    };
  }, [entityType, entityId]);

  if (!tasks) return null;
  const open = tasks.filter((t) => !t.doneAt);

  return (
    <div className="mt-3.5 rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Tasks
        </span>
        {open.length > 0 && <span className="text-[11px] text-muted">{open.length} open</span>}
      </div>
      {tasks.map((t) => (
        <TaskRow key={t.id} task={t} onToggle={toggleHere} onChanged={refresh} />
      ))}
      <NewTask entity={{ entityType, entityId }} onCreated={refresh} />
    </div>
  );
}
