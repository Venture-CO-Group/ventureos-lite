"use client";

import { useCallback, useEffect, useState } from "react";
import {
  formatHours,
  isRunaway,
  runningMinutes,
  type Estimate,
} from "@/modules/tasks/time-logic";
import {
  getRunningTimer,
  getTaskEntries,
  getTaskTime,
  logTimeManually,
  removeTimeEntry,
  setTaskEstimate,
  startTaskTimer,
  stopTaskTimer,
} from "@/modules/tasks/time-actions";
import type { TaskTime } from "@/modules/tasks/time-store";
import { attempt } from "@/lib/client/server-action";
import { useToast } from "./toast";

/**
 * Estimate and time, on a task (playbook-v5 P20/1).
 *
 * ── BOTH ESTIMATES ARE SHOWN ────────────────────────────────────────────────
 *
 * A parent's estimate can be typed or summed from its subtasks, and the
 * playbook asks to show both and mark which is in use. They will disagree —
 * four hours whose subtasks add to eleven is a plan worth another look — and
 * hiding the one not in use would hide exactly that.
 *
 * ── THE TIMER IS A DATABASE ROW ─────────────────────────────────────────────
 *
 * Not component state, so it survives a reload, a crash and a different
 * machine. This polls it rather than counting locally, because a local counter
 * and a stored start time drift apart and the stored one is the truth.
 */
export function TaskTimePanel({ taskId }: { taskId: string }) {
  const toast = useToast();
  const [time, setTime] = useState<TaskTime | null>(null);
  const [running, setRunning] = useState<{ taskId: string; startedAt: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [hours, setHours] = useState("");
  const [manual, setManual] = useState("");
  const [note, setNote] = useState("");
  const [entries, setEntries] = useState<
    { id: string; minutes: number; startedAt: string; note: string | null; running: boolean; mine: boolean }[]
  >([]);

  const load = useCallback(async () => {
    const [t, r, e] = await Promise.all([
      getTaskTime(taskId).catch(() => null),
      getRunningTimer().catch(() => null),
      getTaskEntries(taskId).catch(() => []),
    ]);
    setTime(t);
    setEntries(e);
    setRunning(r ? { taskId: r.taskId, startedAt: r.startedAt } : null);
    setHours(t?.estimate.own !== null && t?.estimate.own !== undefined ? String(t.estimate.own / 60) : "");
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A ticking display, from the stored start time rather than a local count.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [running]);

  const isRunningHere = running?.taskId === taskId;
  const startedAt = running ? new Date(running.startedAt) : null;
  const elapsed = startedAt ? runningMinutes(startedAt, new Date(now)) : 0;

  return (
    <div className="grid gap-2 rounded-[10px] border border-line bg-panel-2 p-3" data-testid="task-time">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
        Estimate and time
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[12px] text-muted">
          Estimate
          <input
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            onBlur={async () => {
              const res = await attempt(setTaskEstimate({ taskId, hours }));
              if (!res.ok) {
                toast.error(res.error);
                return;
              }
              await load();
            }}
            placeholder="1.5 / 90m / 1h30"
            aria-label="Estimate in hours"
            data-testid="task-estimate"
            className="w-[110px] rounded-[8px] border border-line bg-[rgba(0,5,29,0.6)] px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
          />
        </label>

        {time && <EstimateReadout estimate={time.estimate} />}
      </div>

      {time && (
        <p className="text-[12px] text-muted" data-testid="task-actual">
          Logged <b className="text-ink">{formatHours(time.actualMinutes)}</b>
          {time.variance.ratio !== null && (
            <>
              {" · "}
              <span
                data-testid="task-variance"
                className={
                  time.variance.deltaMinutes > 0
                    ? "text-warn"
                    : time.variance.deltaMinutes < 0
                      ? "text-pos"
                      : "text-muted"
                }
              >
                {time.variance.deltaMinutes > 0 ? "over by " : "under by "}
                {formatHours(Math.abs(time.variance.deltaMinutes))}
              </span>
            </>
          )}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {isRunningHere ? (
          <>
            <button
              type="button"
              data-testid="timer-stop"
              onClick={async () => {
                const res = await attempt(stopTaskTimer());
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                toast.success(`Logged ${formatHours(res.minutes)}.`);
                await load();
              }}
              className="rounded-[8px] border border-accent bg-accent-soft px-2.5 py-1 text-[12px] font-semibold text-[#E4D3FF]"
            >
              Stop · {formatHours(elapsed)}
            </button>
            {startedAt && isRunaway(startedAt, new Date(now)) && (
              <span data-testid="timer-runaway" className="text-[11.5px] text-warn">
                This has been running over twelve hours — stop it and correct the entry if that is
                not right.
              </span>
            )}
          </>
        ) : (
          <button
            type="button"
            data-testid="timer-start"
            onClick={async () => {
              const res = await attempt(startTaskTimer(taskId));
              if (!res.ok) {
                toast.error(res.error);
                return;
              }
              // Said out loud, because it stopped something else.
              if (res.stoppedPrevious) {
                toast.info(`Stopped the timer on “${res.stoppedPrevious}”.`);
              }
              await load();
            }}
            className="rounded-[8px] border border-line bg-panel px-2.5 py-1 text-[12px] text-muted hover:text-ink"
          >
            Start timer
          </button>
        )}

        <span className="flex items-center gap-1.5">
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="1h30"
            aria-label="Time to log"
            data-testid="manual-hours"
            className="w-[80px] rounded-[8px] border border-line bg-[rgba(0,5,29,0.6)] px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What for?"
            aria-label="Note"
            data-testid="manual-note"
            className="w-[130px] rounded-[8px] border border-line bg-[rgba(0,5,29,0.6)] px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
          />
          <button
            type="button"
            data-testid="manual-log"
            disabled={manual.trim().length === 0}
            onClick={async () => {
              const res = await attempt(
                logTimeManually({
                  taskId,
                  hours: manual,
                  day: new Date().toISOString(),
                  note,
                }),
              );
              if (!res.ok) {
                toast.error(res.error);
                return;
              }
              setManual("");
              setNote("");
              await load();
            }}
            className="rounded-[8px] border border-line bg-panel px-2 py-1 text-[12px] text-muted hover:text-ink disabled:opacity-50"
          >
            Log
          </button>
        </span>
      </div>
      {/**
       * The entries, so a mistyped one can be removed — by the person who made
       * it and nobody else. Without this list, `removeTimeEntry` would have
       * had no way in, which is how a delete path ends up untested.
       */}
      {entries.length > 0 && (
        <ul className="grid gap-1 border-t border-line pt-2" data-testid="time-entries">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center gap-2 text-[11.5px] text-muted">
              <span className="tabular-nums text-ink">
                {e.running ? "running" : formatHours(e.minutes)}
              </span>
              <span className="tabular-nums">
                {new Date(e.startedAt).toLocaleDateString("hu-HU", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
              {e.note && <span className="min-w-0 flex-1 truncate">{e.note}</span>}
              {e.mine && !e.running && (
                <button
                  type="button"
                  aria-label="Remove this entry"
                  data-testid="time-entry-remove"
                  onClick={async () => {
                    const res = await attempt(removeTimeEntry(e.id));
                    if (!res.ok) {
                      toast.error(res.error);
                      return;
                    }
                    await load();
                  }}
                  className="ml-auto text-[11px] text-muted hover:text-[#FFB3C2]"
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

    </div>
  );
}

function EstimateReadout({ estimate }: { estimate: Estimate }) {
  if (estimate.mode === "none") {
    return <span className="text-[11.5px] text-muted">No estimate yet.</span>;
  }
  return (
    <span className="text-[11.5px] text-muted" data-testid="estimate-readout">
      {estimate.mode === "own" ? (
        <>
          Using <b className="text-ink">{formatHours(estimate.own)}</b> typed here
          {estimate.fromSubtasks !== null && (
            <> · subtasks add to {formatHours(estimate.fromSubtasks)}</>
          )}
        </>
      ) : (
        <>
          Using <b className="text-ink">{formatHours(estimate.fromSubtasks)}</b> from its subtasks
        </>
      )}
    </span>
  );
}
