/**
 * The arithmetic behind the timeline (playbook-v5 P19/1).
 *
 * ── WHY ALL OF IT IS HERE ───────────────────────────────────────────────────
 *
 * A Gantt chart is geometry, and geometry that looks right in a screenshot is
 * routinely wrong at the third zoom level or across a daylight-saving
 * boundary. Every decision — where a bar starts, how wide it is, which day a
 * drop lands on, which dependents a move breaks — is a pure function over
 * plain values so it can be tested without a browser.
 *
 * ── THE RULE THE PLAYBOOK IS EMPHATIC ABOUT ─────────────────────────────────
 *
 * A task with only a due date is a MILESTONE, not a bar. Inventing a start
 * date so the chart looks fuller would be the product making up a fact about
 * somebody's work — and the invented date would then be indistinguishable
 * from a real one the moment anybody looked at the board.
 */

import { startOfDay } from "./logic";

export const ZOOMS = ["day", "week", "month"] as const;
export type Zoom = (typeof ZOOMS)[number];

/** Pixels per day at each zoom. Wide enough to read, narrow enough to scan. */
export const DAY_WIDTH: Record<Zoom, number> = { day: 48, week: 18, month: 6 };

export const ZOOM_LABEL: Record<Zoom, string> = {
  day: "Days",
  week: "Weeks",
  month: "Months",
};

export function isZoom(value: string): value is Zoom {
  return (ZOOMS as readonly string[]).includes(value);
}

export interface TimelineTask {
  id: string;
  title: string;
  startAt: Date | null;
  dueAt: Date | null;
  doneAt: Date | null;
  parentId: string | null;
  priority: string;
}

/** Whole days between two dates, on calendar-day boundaries. */
export function daysBetween(from: Date, to: Date): number {
  const a = startOfDay(from).getTime();
  const b = startOfDay(to).getTime();
  // Rounded, not floored: an hour of DST drift must not eat a day.
  return Math.round((b - a) / 86_400_000);
}

export function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * The window the chart covers.
 *
 * Padded, and never empty: a board where everything is due on one day still
 * needs somewhere to drag a bar TO, and a board with no dates at all still has
 * to render a scale rather than a division by zero.
 */
export function timelineRange(
  tasks: TimelineTask[],
  now: Date = new Date(),
  padDays = 3,
): { from: Date; to: Date; days: number } {
  const dates = tasks
    .flatMap((t) => [t.startAt, t.dueAt])
    .filter((d): d is Date => d instanceof Date);
  const earliest = dates.length > 0 ? new Date(Math.min(...dates.map((d) => d.getTime()))) : now;
  const latest = dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : now;

  // Today is always in view: a chart that opens somewhere you are not is a
  // chart you have to scroll before it says anything.
  const from = startOfDay(addDays(new Date(Math.min(earliest.getTime(), now.getTime())), -padDays));
  const to = startOfDay(addDays(new Date(Math.max(latest.getTime(), now.getTime())), padDays));
  return { from, to, days: Math.max(1, daysBetween(from, to) + 1) };
}

export type BarKind = "bar" | "milestone" | "unscheduled";

export interface Bar {
  taskId: string;
  kind: BarKind;
  /** Days from the range start. */
  offsetDays: number;
  /** Whole days. 0 for a milestone. */
  lengthDays: number;
}

/**
 * Where a task sits on the chart.
 *
 * THREE outcomes, not two:
 *   - both dates: a bar spanning them;
 *   - due date only: a MILESTONE at that day. No invented start;
 *   - neither, or a start with no due date: UNSCHEDULED. A start date with no
 *     end is not a bar either — its length would be a guess — so it is listed
 *     rather than drawn.
 */
export function barFor(task: TimelineTask, from: Date): Bar {
  if (task.startAt && task.dueAt) {
    const offsetDays = daysBetween(from, task.startAt);
    // Inclusive of both ends: a task starting and ending on the same day
    // occupies one day, not zero.
    const lengthDays = Math.max(1, daysBetween(task.startAt, task.dueAt) + 1);
    return { taskId: task.id, kind: "bar", offsetDays, lengthDays };
  }
  if (task.dueAt) {
    return {
      taskId: task.id,
      kind: "milestone",
      offsetDays: daysBetween(from, task.dueAt),
      lengthDays: 0,
    };
  }
  return { taskId: task.id, kind: "unscheduled", offsetDays: 0, lengthDays: 0 };
}

/** Pixel geometry for a bar at a zoom level. */
export function barGeometry(bar: Bar, zoom: Zoom): { left: number; width: number } {
  const w = DAY_WIDTH[zoom];
  return {
    left: bar.offsetDays * w,
    // A milestone is a diamond: given a day's width so it can be grabbed.
    width: bar.kind === "milestone" ? w : Math.max(w, bar.lengthDays * w),
  };
}

/** Which day a horizontal drag of `deltaPx` lands on. Snap-to-day, always. */
export function snapDays(deltaPx: number, zoom: Zoom): number {
  return Math.round(deltaPx / DAY_WIDTH[zoom]);
}

export type DragMode = "move" | "resize-start" | "resize-end";

export interface DragResult {
  startAt: Date | null;
  dueAt: Date | null;
}

/**
 * What a drag does to a task's dates.
 *
 * `move` shifts both and keeps the length — that is what dragging a bar means
 * and the length changing under you would be a surprise. Resizing one edge
 * moves only that edge, and never past the other: a bar cannot be dragged
 * inside out, so the far edge acts as a floor.
 *
 * A milestone has only a due date, so every mode moves that one date.
 */
export function applyDrag(
  task: TimelineTask,
  mode: DragMode,
  days: number,
): DragResult | null {
  if (days === 0) return null;

  if (!task.startAt || !task.dueAt) {
    if (!task.dueAt) return null;
    return { startAt: task.startAt, dueAt: addDays(task.dueAt, days) };
  }

  if (mode === "move") {
    return { startAt: addDays(task.startAt, days), dueAt: addDays(task.dueAt, days) };
  }
  if (mode === "resize-start") {
    const next = addDays(task.startAt, days);
    // Not past its own end.
    if (daysBetween(next, task.dueAt) < 0) return { startAt: task.dueAt, dueAt: task.dueAt };
    return { startAt: next, dueAt: task.dueAt };
  }
  const next = addDays(task.dueAt, days);
  if (daysBetween(task.startAt, next) < 0) return { startAt: task.startAt, dueAt: task.startAt };
  return { startAt: task.startAt, dueAt: next };
}

// ---------------------------------------------------------------------------
// scheduling intelligence
// ---------------------------------------------------------------------------

export interface DependencyEdge {
  taskId: string;
  blockedById: string;
}

export interface BrokenDependent {
  taskId: string;
  blockerId: string;
  /** How many days it would have to move to start after its blocker ends. */
  shiftDays: number;
}

/**
 * Which dependents a move has broken, and by how much.
 *
 * ── HONEST AND OPTIONAL, WHICH IS THE POINT ─────────────────────────────────
 *
 * The playbook is explicit: never cascade silently. Moving a blocker later
 * does NOT drag its dependents with it — that would rewrite dates nobody
 * asked about, and on a chain of eight it would rewrite eight. Instead this
 * computes who now starts before their blocker ends, so the UI can highlight
 * them and offer a shift the person confirms.
 *
 * Only tasks with a real start date can be broken: a milestone has no start
 * to be too early, and unscheduled work has no dates to contradict.
 */
export function brokenDependents(
  tasks: TimelineTask[],
  edges: DependencyEdge[],
  movedId: string,
): BrokenDependent[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const moved = byId.get(movedId);
  if (!moved?.dueAt) return [];

  const out: BrokenDependent[] = [];
  for (const edge of edges) {
    if (edge.blockedById !== movedId) continue;
    const dependent = byId.get(edge.taskId);
    if (!dependent?.startAt) continue;
    const gap = daysBetween(dependent.startAt, moved.dueAt);
    // Must start at least the day AFTER its blocker ends.
    if (gap >= 0) {
      out.push({ taskId: dependent.id, blockerId: movedId, shiftDays: gap + 1 });
    }
  }
  return out;
}

/**
 * The whole downstream shift, when somebody confirms it.
 *
 * Walks the chain: shifting B may break C. Bounded by the number of tasks, so
 * a cycle that slipped past the guard cannot spin here.
 */
export function planDependentShift(
  tasks: TimelineTask[],
  edges: DependencyEdge[],
  movedId: string,
): Map<string, { startAt: Date; dueAt: Date }> {
  const byId = new Map(tasks.map((t) => [t.id, { ...t }]));
  const plan = new Map<string, { startAt: Date; dueAt: Date }>();
  const queue = [movedId];
  let steps = 0;

  while (queue.length > 0 && steps < tasks.length * 2 + 10) {
    steps += 1;
    const id = queue.shift()!;
    for (const broken of brokenDependents([...byId.values()], edges, id)) {
      const task = byId.get(broken.taskId);
      if (!task?.startAt || !task.dueAt) continue;
      const startAt = addDays(task.startAt, broken.shiftDays);
      const dueAt = addDays(task.dueAt, broken.shiftDays);
      byId.set(broken.taskId, { ...task, startAt, dueAt });
      plan.set(broken.taskId, { startAt, dueAt });
      queue.push(broken.taskId);
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

export interface TimelineRow<T extends TimelineTask> {
  task: T;
  depth: number;
  /** Set for a parent that has children. */
  childCount: number;
}

/**
 * Parents, then their subtasks under them.
 *
 * Subtasks are indented rather than listed flat, and a parent can be
 * collapsed — a board with forty parents of five subtasks each is two hundred
 * rows, which is a chart nobody can read.
 */
export function timelineRows<T extends TimelineTask>(
  tasks: T[],
  collapsed: Set<string> = new Set(),
): TimelineRow<T>[] {
  const children = new Map<string, T[]>();
  for (const t of tasks) {
    if (!t.parentId) continue;
    children.set(t.parentId, [...(children.get(t.parentId) ?? []), t]);
  }
  const out: TimelineRow<T>[] = [];
  for (const task of tasks) {
    if (task.parentId) continue;
    const kids = children.get(task.id) ?? [];
    out.push({ task, depth: 0, childCount: kids.length });
    if (collapsed.has(task.id)) continue;
    for (const kid of kids) out.push({ task: kid, depth: 1, childCount: 0 });
  }
  /**
   * A subtask whose parent is not in the list still has to appear.
   *
   * Filters can hide a parent while keeping its child, and dropping the child
   * would mean the chart quietly showed less work than the board did.
   *
   * Keyed on whether the PARENT EXISTS, not on whether the child was already
   * emitted — the first version tested the latter and duly re-added every
   * child of a collapsed parent, undoing the collapse. Caught by its own test.
   */
  const present = new Set(tasks.map((t) => t.id));
  for (const task of tasks) {
    if (!task.parentId) continue;
    if (present.has(task.parentId)) continue;
    out.push({ task, depth: 0, childCount: 0 });
  }
  return out;
}

/**
 * Which rows are worth rendering for a given scroll window.
 *
 * The playbook asks for virtualization so hundreds of tasks stay smooth. Rows
 * are a fixed height, so this is arithmetic rather than measurement — and an
 * overscan either side keeps a fast scroll from showing gaps.
 */
export function visibleRowRange(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 6,
): { start: number; end: number } {
  if (total === 0) return { start: 0, end: 0 };
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  return { start: first, end: Math.min(total, first + visible) };
}

/** Weekend columns, for shading. Indices into the range. */
export function weekendDays(from: Date, days: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = addDays(from, i).getDay();
    if (day === 0 || day === 6) out.push(i);
  }
  return out;
}

/** Where today sits, or null when it is outside the window. */
export function todayOffset(from: Date, days: number, now: Date = new Date()): number | null {
  const offset = daysBetween(from, now);
  return offset >= 0 && offset < days ? offset : null;
}
