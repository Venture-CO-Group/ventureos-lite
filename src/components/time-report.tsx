"use client";

import { useCallback, useEffect, useState } from "react";
import { formatHours, varianceLabel } from "@/modules/tasks/time-logic";
import { getBoardTimeReport, getMyWeek } from "@/modules/tasks/time-actions";
import type { BoardTimeReport } from "@/modules/tasks/time-store";
import { startOfWeek } from "@/modules/tasks/calendar";

/**
 * Estimate against actual (playbook-v5 P20/1).
 *
 * ── WHY THE COVERAGE FIGURE IS AS PROMINENT AS THE VARIANCE ─────────────────
 *
 * A board where three of forty tasks are estimated has a variance number that
 * means almost nothing, and a report that shows the number without the
 * coverage invites somebody to price the next project on it. So "estimated on
 * 3 of 40" sits beside the totals rather than in a tooltip.
 *
 * ── AND WHY THE PERSON SUMMARY IS A WEEK ────────────────────────────────────
 *
 * A month of logged time is a payroll question; a week is the one somebody can
 * still remember and correct. It is their own week only — one person's hours
 * are not a thing colleagues need on a board screen.
 */
export function TimeReport({ boardId }: { boardId: string }) {
  const [report, setReport] = useState<BoardTimeReport | null>(null);
  const [week, setWeek] = useState<{ byDay: Record<string, number>; totalMinutes: number } | null>(
    null,
  );

  const load = useCallback(async () => {
    const from = startOfWeek(new Date());
    const [r, w] = await Promise.all([
      getBoardTimeReport(boardId).catch(() => null),
      getMyWeek(from.toISOString()).catch(() => null),
    ]);
    setReport(r);
    setWeek(w ? { byDay: w.byDay, totalMinutes: w.totalMinutes } : null);
  }, [boardId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!report) return null;
  const label = varianceLabel(report.variance);

  return (
    <div
      data-testid="time-report"
      className="mb-3 grid gap-2 rounded-card border border-line bg-panel p-3 sm:grid-cols-2"
    >
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          This board
        </p>
        <p className="mt-1 text-[12.5px] text-muted">
          Estimated <b className="text-ink">{formatHours(report.estimateMinutes || null)}</b> ·
          logged <b className="text-ink">{formatHours(report.actualMinutes)}</b>
          {label !== "unknown" && (
            <>
              {" · "}
              <span
                data-testid="board-variance"
                className={
                  label === "over" ? "text-warn" : label === "under" ? "text-pos" : "text-muted"
                }
              >
                {label === "over" ? "over" : label === "under" ? "under" : "on estimate"}
              </span>
            </>
          )}
        </p>
        {/* The honesty figure, beside the number rather than behind it. */}
        <p data-testid="board-coverage" className="mt-0.5 text-[11px] text-muted">
          Estimated on {report.estimatedTasks} of {report.totalTasks} task
          {report.totalTasks === 1 ? "" : "s"}
          {report.estimatedTasks < report.totalTasks / 2 && report.totalTasks > 0 && (
            <span className="text-warn"> — too few to price from</span>
          )}
        </p>
      </div>

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          Your week
        </p>
        <p className="mt-1 text-[12.5px] text-muted" data-testid="my-week-total">
          <b className="text-ink">{formatHours(week?.totalMinutes ?? 0)}</b> logged since Monday
        </p>
        <div className="mt-1 flex gap-1">
          {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((label_, i) => {
            const day = new Date(startOfWeek(new Date()));
            day.setDate(day.getDate() + i);
            const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
            const minutes = week?.byDay[key] ?? 0;
            return (
              <span
                key={label_}
                title={`${label_}: ${formatHours(minutes)}`}
                className="grid flex-1 place-items-center rounded-[6px] bg-panel-2 py-1 text-[10px] tabular-nums text-muted"
              >
                {minutes > 0 ? formatHours(minutes) : "—"}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
