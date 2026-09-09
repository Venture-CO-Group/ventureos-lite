"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DAY_WIDTH,
  ZOOMS,
  ZOOM_LABEL,
  addDays,
  barFor,
  barGeometry,
  snapDays,
  timelineRange,
  timelineRows,
  todayOffset,
  visibleRowRange,
  weekendDays,
  type DragMode,
  type TimelineTask,
  type Zoom,
} from "@/modules/tasks/timeline";
import {
  dragTimelineTask,
  getTimeline,
  shiftDependentsAction,
  type TimelineView,
} from "@/modules/tasks/timeline-actions";
import { addDependency } from "@/modules/tasks/board-actions";
import { attempt } from "@/lib/client/server-action";
import { useToast } from "./toast";
import { StateCard } from "./state-card";

/**
 * The timeline (playbook-v5 P19/1).
 *
 * ── WHAT IS HERE AND WHAT IS IN modules/tasks/timeline.ts ───────────────────
 *
 * Every decision — where a bar starts, how wide it is, which day a drop lands
 * on, which dependents a move broke — is a pure function over plain values,
 * tested without a browser. This file owns the pointer handling, the DOM and
 * the scroll, and nothing else. A Gantt chart looks right in a screenshot and
 * is wrong at the third zoom level, which is why the arithmetic is not here.
 *
 * ── BELOW ~900px IT IS A LIST ───────────────────────────────────────────────
 *
 * The playbook asks for a read-only fallback on narrow screens, and it is the
 * right call: a timeline squeezed into 390px is a chart of nothing. The
 * fallback is the same rows with their date ranges written out, which is what
 * somebody on a phone actually wants from a schedule.
 */
const ROW_HEIGHT = 34;
const NARROW = 900;

export function TaskTimeline({
  boardId,
  onOpen,
  onChanged,
}: {
  boardId: string;
  onOpen: (taskId: string) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<TimelineView | null>(null);
  const [zoom, setZoom] = useState<Zoom>("week");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);
  const [narrow, setNarrow] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [broken, setBroken] = useState<
    { movedId: string; rows: { taskId: string; title: string; shiftDays: number }[] } | null
  >(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ taskId: string; mode: DragMode; startX: number } | null>(null);

  const load = useCallback(async () => {
    setData(await getTimeline(boardId).catch(() => ({ tasks: [], edges: [] })));
  }, [boardId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const check = () => setNarrow(window.innerWidth < NARROW);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const tasks = useMemo<TimelineTask[]>(
    () =>
      (data?.tasks ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        startAt: t.startAt ? new Date(t.startAt) : null,
        dueAt: t.dueAt ? new Date(t.dueAt) : null,
        doneAt: t.doneAt ? new Date(t.doneAt) : null,
        parentId: t.parentId,
        priority: t.priority,
      })),
    [data],
  );

  const range = useMemo(() => timelineRange(tasks), [tasks]);
  const rows = useMemo(() => timelineRows(tasks, collapsed), [tasks, collapsed]);
  const weekends = useMemo(() => weekendDays(range.from, range.days), [range]);
  const today = useMemo(() => todayOffset(range.from, range.days), [range]);
  const window_ = visibleRowRange(rows.length, scrollTop, viewportHeight, ROW_HEIGHT);
  const chartWidth = range.days * DAY_WIDTH[zoom];

  /** A row's vertical centre, for drawing a dependency arrow to it. */
  const rowIndex = useMemo(
    () => new Map(rows.map((r, i) => [r.task.id, i])),
    [rows],
  );

  async function commitDrag(taskId: string, mode: DragMode, days: number) {
    const res = await attempt(dragTimelineTask({ taskId, mode, days }));
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.offerUndo(res.undo);
    if (res.broken.length > 0) setBroken({ movedId: taskId, rows: res.broken });
    await load();
    onChanged();
  }

  if (data === null) {
    return <p className="p-6 text-center text-[12.5px] text-muted">Loading the timeline…</p>;
  }

  if (tasks.length === 0) {
    return (
      <StateCard mode="empty" title="nothing to schedule" testId="timeline-empty" illustration="▦">
        A timeline draws tasks that have dates. Give one a start and a due date and it appears
        here as a bar.
      </StateCard>
    );
  }

  if (narrow) {
    return (
      <div data-testid="timeline-narrow" className="grid gap-1.5">
        <p className="text-[11.5px] text-muted">
          The timeline needs a wider screen. Here are the same tasks with their dates.
        </p>
        {rows.map(({ task, depth }) => (
          <button
            key={task.id}
            type="button"
            onClick={() => onOpen(task.id)}
            className="flex items-center gap-2 rounded-[9px] border border-line bg-panel px-2.5 py-2 text-left text-[12.5px] hover:bg-panel-2"
            style={{ paddingLeft: 10 + depth * 14 }}
          >
            <span className="min-w-0 flex-1 truncate text-ink">{task.title}</span>
            <span className="flex-none text-[11px] tabular-nums text-muted">
              {task.startAt && task.dueAt
                ? `${task.startAt.toLocaleDateString("hu-HU", { month: "short", day: "numeric" })} – ${task.dueAt.toLocaleDateString("hu-HU", { month: "short", day: "numeric" })}`
                : task.dueAt
                  ? `due ${task.dueAt.toLocaleDateString("hu-HU", { month: "short", day: "numeric" })}`
                  : "no dates"}
            </span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div data-testid="task-timeline">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.1em] text-muted">Zoom</span>
        {ZOOMS.map((z) => (
          <button
            key={z}
            type="button"
            data-testid={`timeline-zoom-${z}`}
            aria-pressed={zoom === z}
            onClick={() => setZoom(z)}
            className={`rounded-[8px] px-2.5 py-1 text-[12px] ${
              zoom === z ? "bg-panel-2 text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {ZOOM_LABEL[z]}
          </button>
        ))}
        {linking && (
          <span data-testid="timeline-linking" className="ml-auto text-[11.5px] text-accent-ink">
            Pick the task that has to wait for it — Esc to stop.
          </span>
        )}
      </div>

      {/**
       * The shift offer. Never automatic: moving a blocker computes who it
       * broke and asks, because rewriting eight dates nobody mentioned is
       * exactly what "never cascade silently" forbids.
       */}
      {broken && (
        <div
          data-testid="timeline-broken"
          role="alert"
          className="mb-2 rounded-card border border-warn/40 bg-[rgba(245,184,65,0.08)] p-3 text-[12.5px]"
        >
          <p className="text-warn">
            {broken.rows.length} task{broken.rows.length === 1 ? "" : "s"} now start before what
            they wait for finishes:{" "}
            {broken.rows.map((r) => r.title).join(", ")}.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              data-testid="timeline-shift-dependents"
              onClick={async () => {
                const res = await attempt(shiftDependentsAction(broken.movedId));
                setBroken(null);
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                toast.offerUndo(res.undo, `Shifted ${res.moved} dependent tasks`);
                await load();
                onChanged();
              }}
              className="rounded-[8px] border border-accent bg-accent-soft px-2.5 py-1 text-[12px] font-semibold text-[#E4D3FF]"
            >
              Shift them
            </button>
            <button
              type="button"
              data-testid="timeline-leave-dependents"
              onClick={() => setBroken(null)}
              className="text-[12px] text-muted hover:text-ink"
            >
              Leave them
            </button>
          </div>
        </div>
      )}

      <div className="flex rounded-card border border-line bg-panel">
        {/* The frozen row labels. */}
        <div className="w-[220px] flex-none border-r border-line">
          <div className="h-[28px] border-b border-line px-2.5 text-[10px] font-semibold uppercase leading-[28px] tracking-[0.12em] text-muted">
            Task
          </div>
          <div style={{ height: viewportHeight, overflow: "hidden" }}>
            <div style={{ transform: `translateY(${-scrollTop}px)` }}>
              {rows.map(({ task, depth, childCount }) => (
                <div
                  key={task.id}
                  className="flex items-center gap-1 border-b border-line px-2.5 text-[12px]"
                  style={{ height: ROW_HEIGHT, paddingLeft: 10 + depth * 14 }}
                >
                  {childCount > 0 && (
                    <button
                      type="button"
                      aria-label={collapsed.has(task.id) ? `Expand ${task.title}` : `Collapse ${task.title}`}
                      data-testid="timeline-collapse"
                      onClick={() =>
                        setCollapsed((c) => {
                          const next = new Set(c);
                          if (next.has(task.id)) next.delete(task.id);
                          else next.add(task.id);
                          return next;
                        })
                      }
                      className="flex-none text-[10px] text-muted hover:text-ink"
                    >
                      {collapsed.has(task.id) ? "▸" : "▾"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpen(task.id)}
                    className="min-w-0 flex-1 truncate text-left text-ink hover:underline"
                  >
                    {task.title}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* The chart. Scrolls in both directions; keyboard-scrollable. */}
        <div
          ref={scroller}
          tabIndex={0}
          data-testid="timeline-scroller"
          aria-label="Timeline. Arrow keys scroll."
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
          onKeyDown={(e) => {
            const el = scroller.current;
            if (!el) return;
            const step = DAY_WIDTH[zoom] * 3;
            if (e.key === "ArrowRight") {
              e.preventDefault();
              el.scrollLeft += step;
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              el.scrollLeft -= step;
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              el.scrollTop += ROW_HEIGHT;
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              el.scrollTop -= ROW_HEIGHT;
            } else if (e.key === "Escape") {
              setLinking(null);
            }
          }}
          className="min-w-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-accent"
          style={{ height: viewportHeight + 28 }}
        >
          <div style={{ width: chartWidth, position: "relative" }}>
            {/* The scale. */}
            <div className="sticky top-0 z-10 h-[28px] border-b border-line bg-panel">
              {Array.from({ length: range.days }, (_, i) => {
                const day = addDays(range.from, i);
                const w = DAY_WIDTH[zoom];
                // Only label what there is room for.
                const label =
                  zoom === "day"
                    ? String(day.getDate())
                    : zoom === "week"
                      ? day.getDay() === 1
                        ? day.toLocaleDateString("hu-HU", { month: "short", day: "numeric" })
                        : ""
                      : day.getDate() === 1
                        ? day.toLocaleDateString("hu-HU", { month: "short" })
                        : "";
                return (
                  <span
                    key={i}
                    className="absolute top-0 text-[9.5px] leading-[28px] text-muted"
                    style={{ left: i * w, width: zoom === "day" ? w : 60 }}
                  >
                    {label}
                  </span>
                );
              })}
            </div>

            {/* Weekend shading and the today marker, behind the bars. */}
            <div className="absolute inset-x-0" style={{ top: 28, bottom: 0 }}>
              {weekends.map((i) => (
                <span
                  key={i}
                  aria-hidden="true"
                  className="absolute top-0 bottom-0 bg-[rgba(239,241,248,0.03)]"
                  style={{ left: i * DAY_WIDTH[zoom], width: DAY_WIDTH[zoom] }}
                />
              ))}
              {today !== null && (
                <span
                  data-testid="timeline-today"
                  className="absolute top-0 bottom-0 w-px bg-accent"
                  style={{ left: today * DAY_WIDTH[zoom] + DAY_WIDTH[zoom] / 2 }}
                />
              )}
            </div>

            {/* Dependency arrows, from the real records. */}
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute left-0"
              style={{ top: 28, width: chartWidth, height: rows.length * ROW_HEIGHT }}
            >
              {(data.edges ?? []).map((edge) => {
                const from = rowIndex.get(edge.blockedById);
                const to = rowIndex.get(edge.taskId);
                if (from === undefined || to === undefined) return null;
                const blocker = tasks.find((t) => t.id === edge.blockedById);
                const dependent = tasks.find((t) => t.id === edge.taskId);
                if (!blocker || !dependent) return null;
                const a = barGeometry(barFor(blocker, range.from), zoom);
                const b = barGeometry(barFor(dependent, range.from), zoom);
                const x1 = a.left + a.width;
                const y1 = from * ROW_HEIGHT + ROW_HEIGHT / 2;
                const x2 = b.left;
                const y2 = to * ROW_HEIGHT + ROW_HEIGHT / 2;
                return (
                  <path
                    key={`${edge.blockedById}-${edge.taskId}`}
                    d={`M ${x1} ${y1} L ${(x1 + x2) / 2} ${y1} L ${(x1 + x2) / 2} ${y2} L ${x2} ${y2}`}
                    stroke="rgba(199,155,255,0.55)"
                    strokeWidth="1.5"
                    fill="none"
                  />
                );
              })}
            </svg>

            {/* The bars. Only the visible window is rendered. */}
            <div style={{ position: "relative", height: rows.length * ROW_HEIGHT }}>
              {rows.slice(window_.start, window_.end).map((row, i) => {
                const index = window_.start + i;
                const bar = barFor(row.task, range.from);
                const geo = barGeometry(bar, zoom);
                const top = index * ROW_HEIGHT + 6;
                if (bar.kind === "unscheduled") return null;

                return (
                  <div
                    key={row.task.id}
                    data-testid={bar.kind === "milestone" ? "timeline-milestone" : "timeline-bar"}
                    data-task-id={row.task.id}
                    role="button"
                    tabIndex={-1}
                    title={
                      bar.kind === "milestone"
                        ? `${row.task.title} — due ${row.task.dueAt!.toLocaleDateString("hu-HU")}`
                        : `${row.task.title} — ${row.task.startAt!.toLocaleDateString("hu-HU")} to ${row.task.dueAt!.toLocaleDateString("hu-HU")}`
                    }
                    onPointerDown={(e) => {
                      if (linking) return;
                      drag.current = { taskId: row.task.id, mode: "move", startX: e.clientX };
                      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                    }}
                    onPointerUp={(e) => {
                      const d = drag.current;
                      drag.current = null;
                      if (!d || d.taskId !== row.task.id) return;
                      const days = snapDays(e.clientX - d.startX, zoom);
                      if (days !== 0) void commitDrag(d.taskId, d.mode, days);
                    }}
                    onClick={() => {
                      if (!linking) return;
                      const blockedById = linking;
                      setLinking(null);
                      void (async () => {
                        const res = await attempt(
                          addDependency({ taskId: row.task.id, blockedById }),
                        );
                        if (!res.ok) {
                          // Names the chain — see modules/tasks/board-logic.cyclePath.
                          toast.error(res.error);
                          return;
                        }
                        await load();
                      })();
                    }}
                    className={`absolute cursor-grab ${
                      bar.kind === "milestone"
                        ? "grid place-items-center"
                        : "rounded-[6px] border border-accent bg-accent-soft"
                    } ${row.task.doneAt ? "opacity-50" : ""}`}
                    style={{
                      left: geo.left,
                      width: geo.width,
                      top,
                      height: ROW_HEIGHT - 12,
                    }}
                  >
                    {bar.kind === "milestone" ? (
                      <span
                        aria-hidden="true"
                        className="block h-[11px] w-[11px] rotate-45 border border-accent bg-accent-soft"
                      />
                    ) : (
                      <>
                        {/* Edge handles. Resize one end without moving the other. */}
                        <span
                          data-testid="timeline-resize-start"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            drag.current = {
                              taskId: row.task.id,
                              mode: "resize-start",
                              startX: e.clientX,
                            };
                          }}
                          className="absolute left-0 top-0 h-full w-[6px] cursor-col-resize"
                        />
                        <span
                          data-testid="timeline-resize-end"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            drag.current = {
                              taskId: row.task.id,
                              mode: "resize-end",
                              startX: e.clientX,
                            };
                          }}
                          className="absolute right-0 top-0 h-full w-[6px] cursor-col-resize"
                        />
                        <button
                          type="button"
                          aria-label={`Draw a dependency from ${row.task.title}`}
                          data-testid="timeline-link"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setLinking(row.task.id);
                          }}
                          className="absolute -right-3 top-1/2 h-[10px] w-[10px] -translate-y-1/2 rounded-full border border-accent bg-canvas opacity-0 focus-visible:opacity-100 group-hover:opacity-100 hover:opacity-100"
                        />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <p className="mt-1.5 text-[10.5px] text-muted">
        Drag a bar to move it, its edges to resize. A task with only a due date is a diamond —
        it has no start date, and one is never invented for it.
      </p>
      {/* Kept honest: the viewport height is fixed, so virtualization has a
          number to work from rather than measuring during a scroll. */}
      <button
        type="button"
        onClick={() => setViewportHeight((h) => (h === 480 ? 720 : 480))}
        data-testid="timeline-taller"
        className="mt-1 text-[11px] text-muted hover:text-ink"
      >
        {viewportHeight === 480 ? "Taller" : "Shorter"}
      </button>
    </div>
  );
}
