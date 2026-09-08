/**
 * Board arithmetic: ordering, ranking, priority and progress.
 *
 * Pure over plain rows so the parts that decide what a person sees — and, more
 * importantly, where a dragged card lands — are testable without a database.
 * Reordering is the operation most likely to look right in a demo and be wrong
 * on the fifteenth drag, which is exactly why it belongs in a tested function
 * rather than inline in a server action.
 */

export const TASK_PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  none: "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

/** Design-system colours; urgent borrows the error red, high the warn amber. */
export const PRIORITY_CLASS: Record<TaskPriority, string> = {
  none: "bg-panel-2 text-muted",
  low: "bg-panel-2 text-[#C9CEE3]",
  medium: "bg-accent-soft text-accent-ink",
  high: "bg-[rgba(245,184,65,0.15)] text-warn",
  urgent: "bg-[rgba(255,92,122,0.15)] text-[#FF5C7A]",
};

export function isTaskPriority(v: unknown): v is TaskPriority {
  return typeof v === "string" && (TASK_PRIORITIES as readonly string[]).includes(v);
}

/** Descending urgency, for sorting a list by priority. */
const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export function priorityRank(p: string): number {
  return isTaskPriority(p) ? PRIORITY_RANK[p] : PRIORITY_RANK.none;
}

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

/**
 * The gap left between adjacent cards.
 *
 * Sparse ranks mean dropping a card between two others is ONE write — the new
 * card takes the midpoint — instead of renumbering everything below it. At a
 * step of 1024 a column tolerates ten consecutive drops into the same gap
 * before the midpoints run out, and `needsRebalance` catches that case.
 */
export const POSITION_STEP = 1024;

/** The rank a brand-new card gets at the end of a column. */
export function nextPosition(existing: number[]): number {
  if (existing.length === 0) return POSITION_STEP;
  return Math.max(...existing) + POSITION_STEP;
}

/**
 * Where a card dropped between `before` and `after` should rank.
 *
 * Both bounds are the ranks of the neighbours in the destination column, after
 * the card has been taken out of wherever it was. Either may be null, meaning
 * "dropped at the top" or "dropped at the bottom".
 *
 * Returns null when there is no room left between the two — the caller then
 * rebalances the column and retries. Returning null rather than silently
 * colliding matters: two cards with the same rank order arbitrarily, and a
 * board that reshuffles itself on refresh is a board nobody trusts.
 */
export function positionBetween(
  before: number | null,
  after: number | null,
): number | null {
  if (before === null && after === null) return POSITION_STEP;
  if (before === null) return after! - POSITION_STEP;
  if (after === null) return before + POSITION_STEP;
  if (after - before < 2) return null; // no integer strictly between them
  return Math.floor((before + after) / 2);
}

/** True when a column's ranks have been squeezed together and need respacing. */
export function needsRebalance(positions: number[]): boolean {
  const sorted = [...positions].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]! - sorted[i - 1]! < 2) return true;
  }
  return false;
}

/** Evenly spaced ranks for a column, in the order given. */
export function rebalance(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * POSITION_STEP);
}

// ---------------------------------------------------------------------------
// progress
// ---------------------------------------------------------------------------

export interface BoardProgress {
  total: number;
  done: number;
  overdue: number;
  /** 0–100, rounded. 0 when there is nothing to do rather than NaN. */
  pct: number;
}

export function boardProgress(
  tasks: Array<{ doneAt: Date | null; dueAt: Date | null }>,
  now: Date = new Date(),
): BoardProgress {
  const total = tasks.length;
  const done = tasks.filter((t) => t.doneAt).length;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const overdue = tasks.filter(
    (t) => !t.doneAt && t.dueAt && t.dueAt.getTime() < startOfToday.getTime(),
  ).length;
  return {
    total,
    done,
    overdue,
    // A board with no tasks is 0% done, not 100%: "complete" is a claim, and
    // an empty board has not earned it.
    pct: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}

// ---------------------------------------------------------------------------
// subtasks
// ---------------------------------------------------------------------------

/**
 * How far through its subtasks a parent is.
 *
 * Deliberately reported rather than enforced. Ticking a parent does NOT tick
 * its children and completing every child does NOT complete the parent: a
 * summary line that makes its own children disappear is how work gets lost,
 * and a parent that closes itself takes the decision away from the person who
 * would have noticed the last step was not really finished.
 */
export function subtaskProgress(
  subtasks: Array<{ doneAt: Date | null }>,
): { done: number; total: number } | null {
  if (subtasks.length === 0) return null;
  return { done: subtasks.filter((s) => s.doneAt).length, total: subtasks.length };
}

// ---------------------------------------------------------------------------
// mentions
// ---------------------------------------------------------------------------

/**
 * The people named in a comment.
 *
 * Matched against the workspace's members by name rather than by a handle,
 * because this product has no handles — people are "Tamás" and "Fanni". Longest
 * name first, so "@Fanni Virágh" is not matched as "@Fanni" with a stray
 * surname left behind.
 *
 * Resolved at WRITE time and stored on the comment: a later rename must not
 * silently un-mention somebody who was already notified.
 */
export function extractMentions(
  body: string,
  members: Array<{ id: string; name: string }>,
): string[] {
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  const found = new Set<string>();
  const lower = body.toLowerCase();
  for (const m of byLength) {
    if (!m.name.trim()) continue;
    if (lower.includes(`@${m.name.toLowerCase()}`)) found.add(m.id);
  }
  return [...found];
}


// ---------------------------------------------------------------------------
// dependencies (P3/3.1)
// ---------------------------------------------------------------------------

export interface DependencyEdge {
  /** The task that is blocked. */
  taskId: string;
  /** The task it is waiting for. */
  blockedById: string;
}

/**
 * Would adding this edge create a cycle?
 *
 * ── WHY THIS MATTERS MORE THAN IT LOOKS ─────────────────────────────────────
 *
 * A cycle is not a cosmetic problem. "A waits for B, B waits for A" is a pair
 * of tasks that can never be started according to the graph, and once three or
 * four are involved nobody looking at the board can see why nothing is
 * startable. It is also the reason board dependencies were deliberately left
 * out of the first version: a badly drawn graph is worse than no graph.
 *
 * A depth-first walk FORWARD from the proposed blocker: if we can already reach
 * the blocked task by following "waits for" edges, adding this one closes a
 * loop. Self-dependency is the degenerate case and is caught first.
 */
export function wouldCycle(
  edges: DependencyEdge[],
  taskId: string,
  blockedById: string,
): boolean {
  if (taskId === blockedById) return true;

  // blocker -> everything that blocker is itself waiting for.
  const waitsFor = new Map<string, string[]>();
  for (const e of edges) {
    const list = waitsFor.get(e.taskId) ?? [];
    list.push(e.blockedById);
    waitsFor.set(e.taskId, list);
  }

  const seen = new Set<string>();
  const stack = [blockedById];
  while (stack.length > 0) {
    const at = stack.pop()!;
    if (at === taskId) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const next of waitsFor.get(at) ?? []) stack.push(next);
  }
  return false;
}

/**
 * Is this task waiting on something unfinished?
 *
 * Reported, never enforced: a blocked task can still be ticked. Refusing the
 * tick would mean the product deciding its own graph is more accurate than the
 * person looking at the work — and a graph somebody drew wrong would then be a
 * board on which nothing can move.
 */
export function blockedBy(
  task: { id: string },
  edges: DependencyEdge[],
  doneById: ReadonlyMap<string, boolean>,
): string[] {
  return edges
    .filter((e) => e.taskId === task.id && doneById.get(e.blockedById) === false)
    .map((e) => e.blockedById);
}

// ---------------------------------------------------------------------------
// recurrence (P3/3.2)
// ---------------------------------------------------------------------------

export interface TaskRecurrence {
  cadence: "daily" | "weekly" | "monthly";
  /** 1-7, ISO weekday. Weekly only. */
  dayOfWeek?: number;
  /** 1-28. Monthly only. */
  dayOfMonth?: number;
}

/** Read a recurrence off a JSON column, refusing anything malformed. */
export function readRecurrence(raw: unknown): TaskRecurrence | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const cadence = r.cadence;
  if (cadence !== "daily" && cadence !== "weekly" && cadence !== "monthly") return null;
  const out: TaskRecurrence = { cadence };
  if (typeof r.dayOfWeek === "number" && r.dayOfWeek >= 1 && r.dayOfWeek <= 7) {
    out.dayOfWeek = Math.round(r.dayOfWeek);
  }
  if (typeof r.dayOfMonth === "number" && r.dayOfMonth >= 1 && r.dayOfMonth <= 28) {
    out.dayOfMonth = Math.round(r.dayOfMonth);
  }
  return out;
}

/** A sentence a person can check against what they meant. */
export function describeRecurrence(r: TaskRecurrence): string {
  if (r.cadence === "daily") return "Repeats every day";
  if (r.cadence === "weekly") {
    const names = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    return `Repeats every ${names[r.dayOfWeek ?? 1]}`;
  }
  const d = r.dayOfMonth ?? 1;
  const suffix = d === 1 ? "st" : d === 2 ? "nd" : d === 3 ? "rd" : "th";
  return `Repeats on the ${d}${suffix} of every month`;
}
