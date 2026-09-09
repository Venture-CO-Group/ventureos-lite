/**
 * The task trail (playbook-v5 P20/6). Pure.
 *
 * ── WHY A TRAIL AND NOT JUST THE CURRENT STATE ──────────────────────────────
 *
 * `delegatedBy` on the task says who handed it over most recently. It does not
 * say that it went from Anna to Béla to Anna again over three days, which is
 * the shape of a task nobody wants — and the only way anybody notices that is
 * if the handovers are written down.
 *
 * Deliberately the same vocabulary as `MembershipEvent`: kind, the person it
 * happened to, the actor, before and after.
 */

export const TASK_EVENT_KINDS = [
  "assigned",
  "unassigned",
  "delegated",
  "collaborator_added",
  "collaborator_removed",
] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

export function isTaskEventKind(value: string): value is TaskEventKind {
  return (TASK_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * How a person is related to a task. Three relationships, not one list.
 *
 * The order is the order of obligation: an assignee owes the task, a
 * collaborator is doing some of it, a follower is watching.
 */
export const TASK_RELATIONS = ["assignee", "collaborator", "follower"] as const;
export type TaskRelation = (typeof TASK_RELATIONS)[number];

/** What a notification should say this change means for the person reading it. */
export const RELATION_NOTE: Record<TaskRelation, string> = {
  assignee: "You own this.",
  collaborator: "You are working on this with them.",
  follower: "You are following this.",
};

export interface TaskEventView {
  id: string;
  kind: TaskEventKind;
  at: string;
  /** Resolved names, because an id in a trail is not a trail anybody reads. */
  actorName: string | null;
  userName: string | null;
  fromName: string | null;
}

/**
 * One line of the trail.
 *
 * "Anna reassigned this to Béla" rather than "assignee_changed", because the
 * panel this appears in is read by the person trying to work out why the task
 * is theirs.
 */
export function describeTaskEvent(event: TaskEventView): string {
  const actor = event.actorName ?? "The system";
  switch (event.kind) {
    case "assigned":
      return `${actor} assigned this to ${event.userName ?? "somebody"}.`;
    case "unassigned":
      return `${actor} left this unassigned.`;
    case "delegated":
      return `${actor} handed this from ${event.fromName ?? "somebody"} to ${
        event.userName ?? "somebody"
      }.`;
    case "collaborator_added":
      return `${actor} added ${event.userName ?? "somebody"} as a collaborator.`;
    case "collaborator_removed":
      return `${actor} removed ${event.userName ?? "somebody"} as a collaborator.`;
    default: {
      const exhaustive: never = event.kind;
      throw new Error(`unhandled task event kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Which event a change of assignee is.
 *
 * A HANDOVER is the interesting one: a task that already had an owner and now
 * has a different one. First assignment is not a delegation — nobody handed it
 * over, it was simply given out — and conflating the two makes the delegation
 * trail meaningless on the boards where every task starts unassigned.
 */
export function assignmentKind(
  before: string | null,
  after: string | null,
): TaskEventKind | null {
  if (before === after) return null;
  if (!after) return "unassigned";
  if (!before) return "assigned";
  return "delegated";
}
