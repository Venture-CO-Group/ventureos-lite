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

/**
 * `custom` is grouping by an Owner-defined field (playbook-v5 P20/2).
 *
 * The KEY travels separately rather than becoming part of this list, because
 * the list is a closed set the URL codec validates against — and a workspace's
 * field keys are not knowable in advance. So the URL says `g=custom&cf=segment`
 * and the key is validated against the live definitions.
 */
export const GROUP_BYS = ["section", "assignee", "priority", "due", "tag", "custom"] as const;
export type GroupBy = (typeof GROUP_BYS)[number];

export const GROUP_BY_LABEL: Record<GroupBy, string> = {
  section: "Column",
  assignee: "Assignee",
  priority: "Priority",
  due: "Due",
  tag: "Tag",
  custom: "Your field",
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
  | { field: "custom"; key: string; value: string | null }
  | null;

/**
 * The attribute a drop into `groupKey` should set.
 *
 * Returns null for `section`, which is the signal to the caller that this is
 * an ordinary move rather than an attribute change — the two go down different
 * paths on purpose.
 */
export function writeForGroup(by: GroupBy, groupKey: string, customKey?: string): GroupWrite {
  if (by === "section") return null;
  if (by === "custom") {
    if (!customKey) return null;
    // The "not set" column is a real destination: clearing a field is as
    // ordinary as setting it.
    return { field: "custom", key: customKey, value: groupKey === UNSET ? null : groupKey };
  }
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

/** The keys for work nobody owns, work with no tags, and a field left blank. */
export const UNASSIGNED = "__unassigned__";
export const UNTAGGED = "__untagged__";
export const UNSET = "__unset__";

export interface GroupableTask extends TaskLike {
  sectionId: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  priority: string;
  tags: string[];
  /** Owner-defined field values, in the same shape every other entity uses. */
  customFields?: Record<string, unknown> | null;
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
  /** For `custom`: which field, and its options in their defined order. */
  custom?: { key: string; options: { value: string; label: string }[] },
): TaskGroup<T>[] {
  if (by === "custom") {
    if (!custom) return [];
    const valueOf = (t: T) => {
      const raw = (t.customFields ?? {})[custom.key];
      if (raw === null || raw === undefined || raw === "") return null;
      return Array.isArray(raw) ? raw.map(String) : [String(raw)];
    };
    /**
     * Columns come from the DEFINITION's options, in their defined order —
     * not from the values in use. An option nobody has chosen is still a
     * column, because it is somewhere to drop; deriving them from the data
     * would make the board rearrange itself as work moved.
     */
    const groups: TaskGroup<T>[] = custom.options.map((option) => ({
      key: option.value,
      label: option.label,
      tasks: tasks.filter((t) => valueOf(t)?.includes(option.value) ?? false),
      droppable: true,
    }));
    // Free-text and number fields have no options, so their columns ARE the
    // values in use — sorted, so the board is stable between renders.
    if (custom.options.length === 0) {
      const seen = [...new Set(tasks.flatMap((t) => valueOf(t) ?? []))].sort();
      for (const value of seen) {
        groups.push({
          key: value,
          label: value,
          tasks: tasks.filter((t) => valueOf(t)?.includes(value) ?? false),
          // A free-text column cannot be a drop target: dropping would have to
          // invent the exact string, and "roughly this text" is not a value.
          droppable: false,
        });
      }
    }
    groups.push({
      key: UNSET,
      label: "Not set",
      tasks: tasks.filter((t) => valueOf(t) === null),
      droppable: custom.options.length > 0,
    });
    return groups;
  }

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
  /** One Owner-defined field, as `{ key, value }`. */
  custom: { key: string; value: string } | null;
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
  custom: null,
  due: null,
  completion: "open",
  blocked: null,
};

export function filterIsEmpty(filter: TaskFilter): boolean {
  return (
    filter.assigneeId === null &&
    filter.priority === null &&
    filter.tag === null &&
    filter.custom === null &&
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
  if (filter.custom !== null) {
    const raw = (task.customFields ?? {})[filter.custom.key];
    const held = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)];
    if (!held.includes(filter.custom.value)) return false;
  }
  if (filter.due !== null && workBucketOf(task, now) !== filter.due) return false;
  if (filter.blocked !== null) {
    const isBlocked = (task.blockedCount ?? 0) > 0;
    if (isBlocked !== filter.blocked) return false;
  }
  return true;
}
