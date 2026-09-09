"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CALENDAR_MODES,
  CALENDAR_MODE_LABEL,
  addDays,
  calendarDays,
  dayKey,
  calendarTitle,
  isOtherMonth,
  itemsByDay,
  itemsOn,
  sameDay,
  shiftAnchor,
  startOfWeek,
  type CalendarItem,
  type CalendarMode,
} from "@/modules/tasks/calendar";
import {
  dropTaskOnDay,
  getCalendar,
  getUnscheduled,
  type CalendarRow,
} from "@/modules/tasks/calendar-actions";
import { attempt } from "@/lib/client/server-action";
import { useToast } from "./toast";

/**
 * The calendar (playbook-v5 P19/2).
 *
 * ── ONE SCREEN THAT ANSWERS "WHAT DOES THIS WEEK ACTUALLY CONTAIN" ──────────
 *
 * Tasks by due date, with meetings and callbacks as OVERLAYS that can each be
 * switched off. They are visually distinct and separately toggleable because
 * they are different kinds of commitment: a meeting is not something you tick,
 * and a callback belongs to a call record. Folding them into the task list
 * would make the screen tidier and less true.
 *
 * ── DRAGGING ────────────────────────────────────────────────────────────────
 *
 * Onto a day sets the due date. Across days in week view sets a start AND a
 * due date, which is the one gesture that can express a span. Both undoable,
 * because a calendar is the easiest place to drop something by accident.
 */
const KIND_STYLE: Record<CalendarItem["kind"], string> = {
  task: "border-accent-soft bg-accent-soft text-[#E4D3FF]",
  meeting: "border-[rgba(61,220,151,0.4)] bg-[rgba(61,220,151,0.12)] text-[#8CEFC0]",
  callback: "border-[rgba(245,184,65,0.4)] bg-[rgba(245,184,65,0.12)] text-warn",
};

export function TaskCalendar({
  boardId,
  onOpen,
  onChanged,
}: {
  boardId: string | null;
  onOpen: (taskId: string) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<CalendarMode>("month");
  const [anchor, setAnchor] = useState(() => new Date());
  const [showMeetings, setShowMeetings] = useState(true);
  const [showCallbacks, setShowCallbacks] = useState(true);
  const [tasks, setTasks] = useState<CalendarRow[]>([]);
  const [meetings, setMeetings] = useState<CalendarRow[]>([]);
  const [callbacks, setCallbacks] = useState<CalendarRow[]>([]);
  const [unscheduled, setUnscheduled] = useState<CalendarRow[]>([]);
  const [dragFrom, setDragFrom] = useState<Date | null>(null);

  const days = useMemo(() => calendarDays(mode, anchor), [mode, anchor]);

  const load = useCallback(async () => {
    const from = days[0]!;
    const to = addDays(days.at(-1)!, 1);
    const data = await getCalendar({
      from: from.toISOString(),
      to: to.toISOString(),
      boardId,
    }).catch(() => ({ tasks: [], meetings: [], callbacks: [] }));
    setTasks(data.tasks);
    setMeetings(data.meetings);
    setCallbacks(data.callbacks);
    if (mode === "week") {
      setUnscheduled(await getUnscheduled(boardId).catch(() => []));
    }
  }, [days, boardId, mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const byDay = useMemo(() => {
    const items: CalendarItem[] = [
      ...tasks.map((t) => ({
        id: t.id,
        kind: "task" as const,
        title: t.title,
        at: new Date(t.at),
        doneAt: t.doneAt ? new Date(t.doneAt) : null,
        href: t.href,
        priority: t.priority,
      })),
      ...(showMeetings
        ? meetings.map((m) => ({
            id: m.id,
            kind: "meeting" as const,
            title: m.title,
            at: new Date(m.at),
            href: m.href,
          }))
        : []),
      ...(showCallbacks
        ? callbacks.map((c) => ({
            id: c.id,
            kind: "callback" as const,
            title: c.title,
            at: new Date(c.at),
            href: c.href,
          }))
        : []),
    ];
    return itemsByDay(items);
  }, [tasks, meetings, callbacks, showMeetings, showCallbacks]);

  const drop = useCallback(
    async (taskId: string, day: Date, through: Date | null) => {
      if (!taskId) return;
      const res = await attempt(
        dropTaskOnDay({
          taskId,
          day: day.toISOString(),
          throughDay: through ? through.toISOString() : null,
        }),
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

  return (
    <div data-testid="task-calendar">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {CALENDAR_MODES.map((m) => (
          <button
            key={m}
            type="button"
            data-testid={`calendar-mode-${m}`}
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className={`rounded-[8px] px-2.5 py-1 text-[12px] ${
              mode === m ? "bg-panel-2 text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {CALENDAR_MODE_LABEL[m]}
          </button>
        ))}

        <button
          type="button"
          aria-label="Previous"
          data-testid="calendar-prev"
          onClick={() => setAnchor((a) => shiftAnchor(mode, a, -1))}
          className="rounded-[8px] border border-line bg-panel px-2 py-1 text-[12px] text-muted hover:text-ink"
        >
          ‹
        </button>
        <span data-testid="calendar-title" className="text-[12.5px] font-semibold text-ink">
          {calendarTitle(mode, anchor)}
        </span>
        <button
          type="button"
          aria-label="Next"
          data-testid="calendar-next"
          onClick={() => setAnchor((a) => shiftAnchor(mode, a, 1))}
          className="rounded-[8px] border border-line bg-panel px-2 py-1 text-[12px] text-muted hover:text-ink"
        >
          ›
        </button>
        <button
          type="button"
          data-testid="calendar-today"
          onClick={() => setAnchor(new Date())}
          className="rounded-[8px] border border-line bg-panel px-2 py-1 text-[12px] text-muted hover:text-ink"
        >
          Today
        </button>

        {/* The overlays. Individually toggleable, which is the point of them. */}
        <label className="ml-auto flex items-center gap-1.5 text-[11.5px] text-muted">
          <input
            type="checkbox"
            checked={showMeetings}
            onChange={(e) => setShowMeetings(e.target.checked)}
            data-testid="calendar-overlay-meetings"
            style={{ accentColor: "#3DDC97" }}
          />
          Meetings
        </label>
        <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <input
            type="checkbox"
            checked={showCallbacks}
            onChange={(e) => setShowCallbacks(e.target.checked)}
            data-testid="calendar-overlay-callbacks"
            style={{ accentColor: "#F5B841" }}
          />
          Callbacks
        </label>
      </div>

      <div className={mode === "week" ? "flex gap-3" : ""}>
        <div className="min-w-0 flex-1">
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-card border border-line bg-line">
            {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((label) => (
              <div
                key={label}
                className="bg-panel px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted"
              >
                {label}
              </div>
            ))}

            {days.map((day) => {
              const items = itemsOn(byDay, day);
              const other = mode === "month" && isOtherMonth(day, anchor);
              const today = sameDay(day, new Date());
              return (
                <div
                  key={dayKey(day)}
                  data-testid="calendar-day"
                  /* Local calendar day — see dayKey for why not toISOString. */
                  data-day={dayKey(day)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = e.dataTransfer.getData("text/plain");
                    // A drag that began on another day in week view is a SPAN.
                    const through = mode === "week" && dragFrom && !sameDay(dragFrom, day) ? day : null;
                    setDragFrom(null);
                    void drop(id, through ? dragFrom! : day, through);
                  }}
                  className={`min-h-[92px] bg-panel p-1.5 ${other ? "opacity-45" : ""} ${
                    today ? "ring-1 ring-inset ring-accent" : ""
                  }`}
                >
                  <button
                    type="button"
                    data-testid="calendar-day-number"
                    title="Add a task on this day"
                    onClick={() => onOpen("")}
                    className="mb-1 block text-[11px] tabular-nums text-muted hover:text-ink"
                  >
                    {day.getDate()}
                  </button>

                  <div className="grid gap-1">
                    {items.map((item) => (
                      <div
                        key={`${item.kind}:${item.id}`}
                        draggable={item.kind === "task"}
                        onDragStart={(e) => {
                          if (item.kind !== "task") return;
                          e.dataTransfer.setData("text/plain", item.id);
                          setDragFrom(day);
                        }}
                        data-testid={`calendar-item-${item.kind}`}
                        data-item-id={item.id}
                        className={`truncate rounded-[6px] border px-1.5 py-0.5 text-[10.5px] ${
                          KIND_STYLE[item.kind]
                        } ${item.doneAt ? "line-through opacity-60" : ""}`}
                      >
                        {item.kind === "task" ? (
                          <button
                            type="button"
                            onClick={() => onOpen(item.id)}
                            className="block w-full truncate text-left"
                          >
                            {item.title}
                          </button>
                        ) : (
                          <Link href={item.href ?? "#"} className="block truncate">
                            {item.title}
                          </Link>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/**
         * The week view's side rail: work with no date, ready to be dragged
         * onto a day. The playbook asks for it, and it is the answer to "what
         * have I not scheduled" — which a calendar otherwise cannot show,
         * because unscheduled work has nowhere to appear.
         */}
        {mode === "week" && (
          <aside
            data-testid="calendar-unscheduled"
            className="w-[200px] flex-none rounded-card border border-line bg-panel p-2"
          >
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
              No date · {unscheduled.length}
            </p>
            <div className="grid gap-1">
              {unscheduled.length === 0 && (
                <p className="text-[11.5px] text-muted">Everything has a date.</p>
              )}
              {unscheduled.map((t) => (
                <div
                  key={t.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", t.id);
                    setDragFrom(null);
                  }}
                  data-testid="calendar-unscheduled-item"
                  data-item-id={t.id}
                  className="cursor-grab truncate rounded-[6px] border border-line bg-panel-2 px-1.5 py-1 text-[11px] text-[#C9CEE3]"
                >
                  {t.title}
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>

      <p className="mt-1.5 text-[10.5px] text-muted">
        Drag a task onto a day to reschedule it. In week view, drag it across days to set a start
        and a due date.
      </p>
    </div>
  );
}
