/**
 * Grouping a board by something other than its columns (playbook-v5 P18/2).
 *
 * ── GROUPING IS A VIEW CONCERN. IT NEVER REWRITES sectionId ─────────────────
 *
 * This is the rule the whole item turns on. A board's columns ARE its
 * sections; grouping by assignee rearranges what you see and changes nothing
 * about where the work lives. So a drop into a group sets THE GROUPED
 * ATTRIBUTE — dragging into "High" sets priority high, into a person's column
 * assigns it — and `sectionId` is not touched. Grouped by section (the
 * default) dragging means exactly what it always did: move and reorder.
 *
 * Getting this wrong in the obvious way — treating a group as a section —
 * would silently shred a board's columns the first time somebody grouped by
 * priority and dragged a card.
 */

import { WORK_BUCKETS, WORK_BUCKET_LABEL, workBucketOf, type TaskLike } from "./logic";
import { PRIORITY_LABEL, TASK_PRIORITIES, type TaskPriority } from "./board-logic";

export const GROUP_BYS = ["section", "assignee", "priority", "due", "tag"] as const;
export type GroupBy = (typeof GROUP_BYS)[number];

export const GROUP_BY_LABEL: Record<GroupBy, string> = {
  section: "Column",
  assignee: "Assignee",
  priority: "Priority",
  due: "Due",
  tag: "Tag",
};

export function isGroupBy(value: string): value is GroupBy {
  return (GROUP_BYS as readonly string[]).includes(value);
}

/** What a drop into a group writes. `null` for section — that is a move. */
export type GroupWrite =
  | { field: "priority"; value: string }
  | { field: "assigneeId"; value: string | null }
  | { field: "dueBucket"; value: string }
  | { field: "tag"; value: string }
  | null;

/**
 * The attribute a drop into `groupKey` should set.
 *
 * Returns null for `section`, which is the signal to the caller that this is
 * an ordinary move rather than an attribute change — the two go down different
 * paths on purpose.
 */
export function writeForGroup(by: GroupBy, groupKey: string): GroupWrite {
  if (by === "section") return null;
  if (by === "priority") {
    return (TASK_PRIORITIES as readonly string[]).includes(groupKey)
      ? { field: "priority", value: groupKey }
      : null;
  }
  if (by === "assignee") {
    // The unassigned column is a real destination: taking a task off somebody
    // is as ordinary as putting it on them.
    return { field: "assigneeId", value: groupKey === UNASSIGNED ? null : groupKey };
  }
  if (by === "due") {
    return (WORK_BUCKETS as readonly string[]).includes(groupKey)
      ? { field: "dueBucket", value: groupKey }
      : null;
  }
  return groupKey === UNTAGGED ? null : { field: "tag", value: groupKey };
}

/** The key for work nobody owns, and for work with no tags. */
export const UNASSIGNED = "__unassigned__";
export const UNTAGGED = "__untagged__";

export interface GroupableTask extends TaskLike {
  sectionId: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  priority: string;
  tags: string[];
}

export interface TaskGroup<T> {
  key: string;
  label: string;
  tasks: T[];
  /** False for a group nothing can be dropped into. */
  droppable: boolean;
}

/**
 * Arrange a board's tasks into groups.
 *
 * `section` is not handled here — the board already has its columns and their
 * order, which this function has no way to know. Everything else is derived.
 */
export function groupTasksBy<T extends GroupableTask>(
  tasks: T[],
  by: Exclude<GroupBy, "section">,
  members: { id: string; name: string }[],
  now: Date = new Date(),
): TaskGroup<T>[] {
  if (by === "priority") {
    // Highest first, and every priority shown even when empty: an empty
    // "Urgent" column is information, and it is also somewhere to drop.
    return [...TASK_PRIORITIES]
      .reverse()
      .map((p) => ({
        key: p,
        label: PRIORITY_LABEL[p as TaskPriority],
        tasks: tasks.filter((t) => (t.priority ?? "none") === p),
        droppable: true,
      }));
  }

  if (by === "assignee") {
    const groups: TaskGroup<T>[] = members.map((m) => ({
      key: m.id,
      label: m.name,
      tasks: tasks.filter((t) => t.assigneeId === m.id),
      droppable: true,
    }));
    // Unassigned last, and always present: work nobody owns must be visible
    // rather than tucked away, which is the same reason the board shows it.
    groups.push({
      key: UNASSIGNED,
      label: "Unassigned",
      tasks: tasks.filter((t) => !t.assigneeId),
      droppable: true,
    });
    return groups;
  }

  if (by === "due") {
    return WORK_BUCKETS.map((bucket) => ({
      key: bucket,
      label: WORK_BUCKET_LABEL[bucket],
      tasks: tasks.filter((t) => workBucketOf(t, now) === bucket),
      // Overdue is not a destination — nobody means "make this late".
      droppable: bucket !== "overdue",
    }));
  }

  // Tags: one group per tag in use, and one for the untagged. A task with two
  // tags appears in both groups, which is the honest rendering of a set — and
  // is why the untagged group is not droppable: dropping onto it would have to
  // mean "remove which tag?".
  const tags = [...new Set(tasks.flatMap((t) => t.tags))].sort();
  const groups: TaskGroup<T>[] = tags.map((tag) => ({
    key: tag,
    label: tag,
    tasks: tasks.filter((t) => t.tags.includes(tag)),
    droppable: true,
  }));
  groups.push({
    key: UNTAGGED,
    label: "No tag",
    tasks: tasks.filter((t) => t.tags.length === 0),
    droppable: false,
  });
  return groups;
}

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

export const COMPLETION_FILTERS = ["open", "done", "all"] as const;
export type CompletionFilter = (typeof COMPLETION_FILTERS)[number];

export interface TaskFilter {
  assigneeId: string | null;
  priority: string | null;
  tag: string | null;
  /** A work bucket, or null for any. */
  due: string | null;
  completion: CompletionFilter;
  /** True = only blocked, false = only unblocked, null = either. */
  blocked: boolean | null;
}

export const EMPTY_TASK_FILTER: TaskFilter = {
  assigneeId: null,
  priority: null,
  tag: null,
  due: null,
  completion: "open",
  blocked: null,
};

export function filterIsEmpty(filter: TaskFilter): boolean {
  return (
    filter.assigneeId === null &&
    filter.priority === null &&
    filter.tag === null &&
    filter.due === null &&
    filter.completion === "open" &&
    filter.blocked === null
  );
}

export function matchesTaskFilter<T extends GroupableTask & { blockedCount?: number }>(
  task: T,
  filter: TaskFilter,
  now: Date = new Date(),
): boolean {
  if (filter.completion === "open" && task.doneAt) return false;
  if (filter.completion === "done" && !task.doneAt) return false;
  if (filter.assigneeId !== null) {
    const want = filter.assigneeId === UNASSIGNED ? null : filter.assigneeId;
    if ((task.assigneeId ?? null) !== want) return false;
  }
  if (filter.priority !== null && (task.priority ?? "none") !== filter.priority) return false;
  if (filter.tag !== null && !task.tags.includes(filter.tag)) return false;
  if (filter.due !== null && workBucketOf(task, now) !== filter.due) return false;
  if (filter.blocked !== null) {
    const isBlocked = (task.blockedCount ?? 0) > 0;
    if (isBlocked !== filter.blocked) return false;
  }
  return true;
}
