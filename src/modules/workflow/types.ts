/**
 * Workflow-lite: the vocabulary and the matcher (playbook-v2 P7/5). Pure.
 *
 * "Lite" is load-bearing. One trigger per rule, a flat ANDed condition list, a
 * short ordered action list, twenty rules per workspace — deliberately not a
 * graph, because a workflow engine you can draw a loop in is one somebody will
 * draw a loop in.
 *
 * THE RULE THAT CANNOT BEND (CLAUDE.md hard rule #2): the email action produces
 * a DRAFT a human must open, read and send. There is no configuration that
 * makes it send, and `ACTION_DEFS` says so in the UI copy so nobody has to read
 * this file to find out.
 */

import { z } from "zod";
import { foldText } from "../search/fuzzy";

// ---- triggers ---------------------------------------------------------------

export const TRIGGERS = [
  "lead_stage_changed",
  "deal_stage_changed",
  "quote_accepted",
  "meeting_outcome_logged",
  "task_overdue",
  "lead_created",
  // Board automations (playbook-v5 P20/5). Same engine, same log, same cycle
  // protection — a second automation system is the thing not to build.
  "task_created",
  "task_moved",
  "task_completed",
  "task_priority_changed",
  "task_assignee_changed",
] as const;
export type Trigger = (typeof TRIGGERS)[number];

export interface TriggerDef {
  id: Trigger;
  label: string;
  description: string;
  /** Which extra setting the trigger takes, if any. */
  config: "stage" | "deal_stage" | "days" | "source" | "section" | "none";
}

export const TRIGGER_DEFS: Record<Trigger, TriggerDef> = {
  lead_stage_changed: {
    id: "lead_stage_changed",
    label: "A lead reaches a stage",
    description: "Fires when a lead moves into the stage you pick.",
    config: "stage",
  },
  deal_stage_changed: {
    id: "deal_stage_changed",
    label: "A deal reaches a stage",
    description: "Fires when a deal moves into the stage you pick, on any pipeline.",
    config: "deal_stage",
  },
  quote_accepted: {
    id: "quote_accepted",
    label: "A quote is accepted",
    description: "Fires when a client accepts a quote on the public page.",
    config: "none",
  },
  meeting_outcome_logged: {
    id: "meeting_outcome_logged",
    label: "A meeting outcome is logged",
    description: "Fires when someone records how a meeting went.",
    config: "none",
  },
  task_overdue: {
    id: "task_overdue",
    label: "A task is overdue by N days",
    description: "Checked once a day by the sweep, not the moment the clock passes.",
    config: "days",
  },
  lead_created: {
    id: "lead_created",
    label: "A lead arrives from a source",
    description: "Fires when a lead is captured from the source you pick.",
    config: "source",
  },
  task_created: {
    id: "task_created",
    label: "A task is created",
    description: "Fires the moment a task appears on a board.",
    config: "none",
  },
  task_moved: {
    id: "task_moved",
    label: "A task moves to a section",
    description: "Fires when a task lands in the column you pick, on the rule's board.",
    config: "section",
  },
  task_completed: {
    id: "task_completed",
    label: "A task is completed",
    description: "Fires when somebody ticks it. Reopening does not fire anything.",
    config: "none",
  },
  task_priority_changed: {
    id: "task_priority_changed",
    label: "A task's priority changes",
    description: "Fires on the new priority, whatever it was before.",
    config: "none",
  },
  task_assignee_changed: {
    id: "task_assignee_changed",
    label: "A task is reassigned",
    description: "Fires when the accountable owner changes, including to nobody.",
    config: "none",
  },
};

/**
 * Which triggers are about a task (playbook-v5 P20/5).
 *
 * It decides two things: which condition fields the builder offers, and — more
 * importantly — that a task action cannot be attached to a lead trigger. "Set
 * the priority" on "a lead reaches a stage" has no task to set it on, and a
 * rule that can be saved but can never do anything is worse than one refused.
 */
export const TASK_TRIGGERS = [
  "task_created",
  "task_moved",
  "task_completed",
  "task_priority_changed",
  "task_assignee_changed",
  "task_overdue",
] as const;

export function isTaskTrigger(trigger: string): boolean {
  return (TASK_TRIGGERS as readonly string[]).includes(trigger);
}

// ---- conditions --------------------------------------------------------------

export const CONDITION_OPERATORS = [
  "is",
  "is_not",
  "contains",
  "gte",
  "lte",
  "is_set",
  "is_not_set",
  "has_signal",
  "not_has_signal",
  // Task tags are a JSON array like signals, and read the same way — but they
  // are a different field, so they get their own operators rather than
  // overloading "has_signal" to mean two things depending on the trigger.
  "has_tag",
  "not_has_tag",
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  gte: "is at least",
  lte: "is at most",
  is_set: "is set",
  is_not_set: "is not set",
  has_signal: "has the signal",
  not_has_signal: "does not have the signal",
  has_tag: "has the tag",
  not_has_tag: "does not have the tag",
};

export interface Condition {
  /** A fact key, or `cf:<key>` for a custom field. */
  field: string;
  operator: ConditionOperator;
  value?: string | number | null;
}

/**
 * The facts a rule can look at.
 *
 * A FLAT BAG rather than the entity itself: the trigger decides what is in it,
 * the matcher never touches a database, and a condition on a field the trigger
 * does not supply is simply false rather than an error. That last part matters
 * — a rule written for one trigger and re-pointed at another must go quiet, not
 * explode in a background job.
 */
export interface WorkflowFacts {
  [key: string]: string | number | boolean | string[] | null | undefined;
  signals?: string[];
}

export const CONDITION_FIELDS = [
  { key: "stage", label: "Lead stage" },
  { key: "source", label: "Lead source" },
  { key: "icpScore", label: "ICP score" },
  { key: "industry", label: "Industry" },
  { key: "city", label: "City" },
  { key: "ownerId", label: "Owner" },
  { key: "email", label: "Email" },
  { key: "signals", label: "Signals" },
  { key: "dealValue", label: "Deal value" },
  { key: "dealStage", label: "Deal stage" },
  { key: "pipeline", label: "Pipeline" },
] as const;

/** The facts a TASK trigger supplies (playbook-v5 P20/5). */
export const TASK_CONDITION_FIELDS = [
  { key: "board", label: "Board" },
  { key: "section", label: "Section" },
  { key: "tags", label: "Tags" },
  { key: "priority", label: "Priority" },
  { key: "assigneeId", label: "Assignee" },
  { key: "taskType", label: "Task type" },
  { key: "overdueDays", label: "Days overdue" },
] as const;

/** Which condition fields the builder should offer for a trigger. */
export function conditionFieldsFor(
  trigger: string,
): readonly { key: string; label: string }[] {
  return isTaskTrigger(trigger) ? TASK_CONDITION_FIELDS : CONDITION_FIELDS;
}

function present(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** One condition against the facts. Unknown fields are FALSE, never an error. */
export function evaluateCondition(facts: WorkflowFacts, c: Condition): boolean {
  const raw = facts[c.field];

  if (c.operator === "is_set") return present(raw);
  if (c.operator === "is_not_set") return !present(raw);

  if (c.operator === "has_signal" || c.operator === "not_has_signal") {
    const held = (Array.isArray(facts.signals) ? facts.signals : []).map(foldText);
    const has = held.includes(foldText(String(c.value ?? "")));
    return c.operator === "has_signal" ? has : !has;
  }

  if (c.operator === "has_tag" || c.operator === "not_has_tag") {
    const held = (Array.isArray(facts.tags) ? facts.tags : []).map(foldText);
    const has = held.includes(foldText(String(c.value ?? "")));
    return c.operator === "has_tag" ? has : !has;
  }

  if (!present(raw)) return false;

  if (c.operator === "gte" || c.operator === "lte") {
    const n = typeof raw === "number" ? raw : Number(raw);
    const bound = typeof c.value === "number" ? c.value : Number(c.value);
    if (!Number.isFinite(n) || !Number.isFinite(bound)) return false;
    return c.operator === "gte" ? n >= bound : n <= bound;
  }

  const actual = foldText(String(raw));
  const wanted = foldText(String(c.value ?? ""));
  if (c.operator === "contains") return actual.includes(wanted);
  const same = actual === wanted;
  return c.operator === "is_not" ? !same : same;
}

/** ANDed. An empty list matches — "no conditions" means "whenever it fires". */
export function conditionsMatch(facts: WorkflowFacts, conditions: Condition[]): boolean {
  return conditions.every((c) => evaluateCondition(facts, c));
}

// ---- actions -----------------------------------------------------------------

export const ACTION_TYPES = [
  "create_task",
  "draft_email",
  "add_signal",
  "remove_signal",
  "move_not_now",
  "notify_user",
  // Board automations (playbook-v5 P20/5) — these act on the task the trigger
  // carried, so they are only legal on a task trigger. `validateActions`
  // enforces that rather than leaving a rule that can never do anything.
  "set_priority",
  "set_due_date",
  "assign_task",
  "add_tag",
  "remove_tag",
  "move_to_section",
  "create_follow_up",
  "notify_team",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface ActionDef {
  id: ActionType;
  label: string;
  /** Shown under the action in the builder. */
  note: string;
}

export const ACTION_DEFS: Record<ActionType, ActionDef> = {
  create_task: {
    id: "create_task",
    label: "Create a task",
    note: "Due a number of days from when the rule fires.",
  },
  draft_email: {
    id: "draft_email",
    label: "Prepare an email DRAFT",
    // The copy says it in the builder so nobody has to read the code.
    note: "Writes a draft onto the lead. It is never sent — a person opens it, reads it and sends it.",
  },
  add_signal: { id: "add_signal", label: "Add a signal tag", note: "" },
  remove_signal: { id: "remove_signal", label: "Remove a signal tag", note: "" },
  move_not_now: {
    id: "move_not_now",
    label: "Move to Not now",
    note: "With the usual wake-up date, so it resurfaces rather than disappearing.",
  },
  notify_user: {
    id: "notify_user",
    label: "Notify someone",
    note: "An in-app notification, subject to their own channel preferences.",
  },
  set_priority: {
    id: "set_priority",
    label: "Set the priority",
    note: "On the task that fired the rule.",
  },
  set_due_date: {
    id: "set_due_date",
    label: "Set the due date",
    note: "A number of days from when the rule fires, at 17:00.",
  },
  assign_task: {
    id: "assign_task",
    label: "Assign it to someone",
    note: "One accountable owner. Reassignment records who handed it over.",
  },
  add_tag: { id: "add_tag", label: "Add a tag", note: "" },
  remove_tag: { id: "remove_tag", label: "Remove a tag", note: "" },
  move_to_section: {
    id: "move_to_section",
    label: "Move it to a section",
    note: "To a column on the same board. A move to another board is not this.",
  },
  create_follow_up: {
    id: "create_follow_up",
    label: "Create a follow-up from a template task",
    note: "Copies a task off a template board onto this one, with its own due offset.",
  },
  notify_team: {
    id: "notify_team",
    label: "Notify a team",
    note: "Everyone currently on the team, subject to their own channel preferences.",
  },
};

/** The actions that need a task to act on. */
export const TASK_ACTIONS = [
  "set_priority",
  "set_due_date",
  "assign_task",
  "add_tag",
  "remove_tag",
  "move_to_section",
  "create_follow_up",
] as const;

export function isTaskAction(type: string): boolean {
  return (TASK_ACTIONS as readonly string[]).includes(type);
}

export interface Action {
  type: ActionType;
  /** create_task */
  title?: string;
  taskType?: string;
  dueInDays?: number;
  /** draft_email */
  templateId?: string;
  subject?: string;
  body?: string;
  /** add_signal / remove_signal */
  signal?: string;
  /** notify_user */
  userId?: string;
  message?: string;
  /** notify_team */
  teamId?: string;
  /** set_priority */
  priority?: string;
  /** assign_task — the accountable owner, or "" to unassign. */
  assigneeId?: string;
  /** add_tag / remove_tag */
  tag?: string;
  /** move_to_section */
  sectionId?: string;
  /** create_follow_up — a task on a template board. */
  templateTaskId?: string;
}

// ---- limits ------------------------------------------------------------------

export const MAX_RULES = 20;
export const MAX_CONDITIONS = 10;
export const MAX_ACTIONS = 5;

/**
 * Cycle protection (playbook-v2 P7/5).
 *
 * Two rules, both required:
 *   1. a rule's own action may not re-trigger that same rule, at any depth;
 *   2. no more than three chained rule executions per originating event.
 *
 * The second is the one that actually saves you: two rules that trigger each
 * other satisfy the first rule perfectly and would still run for ever.
 */
export const MAX_CHAIN_DEPTH = 3;

export interface ChainContext {
  depth: number;
  /** Rule ids already run for this originating event. */
  firedRuleIds: string[];
}

export const ROOT_CHAIN: ChainContext = { depth: 0, firedRuleIds: [] };

export type ChainVerdict =
  | { allowed: true }
  | { allowed: false; reason: "self_trigger" | "depth" };

export function canRun(rule: { id: string }, chain: ChainContext): ChainVerdict {
  if (chain.firedRuleIds.includes(rule.id)) return { allowed: false, reason: "self_trigger" };
  if (chain.depth >= MAX_CHAIN_DEPTH) return { allowed: false, reason: "depth" };
  return { allowed: true };
}

export function descend(rule: { id: string }, chain: ChainContext): ChainContext {
  return { depth: chain.depth + 1, firedRuleIds: [...chain.firedRuleIds, rule.id] };
}

// ---- validation ---------------------------------------------------------------

export const conditionSchema = z.object({
  field: z.string().min(1).max(60),
  operator: z.enum(CONDITION_OPERATORS),
  value: z.union([z.string().max(200), z.number(), z.null()]).optional(),
});

export const actionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  title: z.string().trim().max(200).optional(),
  taskType: z.enum(["todo", "call", "email", "follow_up"]).optional(),
  dueInDays: z.number().int().min(0).max(365).optional(),
  templateId: z.string().max(60).optional(),
  subject: z.string().trim().max(200).optional(),
  body: z.string().max(8000).optional(),
  signal: z.string().trim().max(60).optional(),
  userId: z.string().max(60).optional(),
  message: z.string().trim().max(300).optional(),
  teamId: z.string().max(60).optional(),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
  /** "" means unassign, which is a deliberate outcome and not a missing value. */
  assigneeId: z.string().max(60).optional(),
  tag: z.string().trim().max(40).optional(),
  sectionId: z.string().max(60).optional(),
  templateTaskId: z.string().max(60).optional(),
});

export const ruleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  trigger: z.enum(TRIGGERS),
  triggerConfig: z.record(z.union([z.string().max(60), z.number()])).default({}),
  conditions: z.array(conditionSchema).max(MAX_CONDITIONS).default([]),
  actions: z.array(actionSchema).min(1).max(MAX_ACTIONS),
  enabled: z.boolean().default(true),
  /**
   * Which board this rule watches, or null for the whole workspace
   * (playbook-v5 P20/5). A board rule is the common case — "on the delivery
   * board, anything landing in Blocked goes urgent" — and a workspace-wide
   * rule is the one to write deliberately.
   */
  boardId: z.string().max(60).nullable().default(null),
});

export type RuleInput = z.infer<typeof ruleSchema>;

/**
 * Problems the schema cannot express — an action missing what it needs, or
 * pointed at something the trigger cannot give it.
 *
 * The trigger is optional so existing callers keep working; when it is passed,
 * a task action on a lead trigger is refused. That refusal matters: without it
 * a rule saves cleanly, fires cleanly, and does nothing for ever, which is the
 * hardest kind of automation bug to notice.
 */
export function validateActions(actions: Action[], trigger?: string): string[] {
  const problems: string[] = [];
  actions.forEach((a, i) => {
    const where = `Action ${i + 1}`;
    if (trigger && isTaskAction(a.type) && !isTaskTrigger(trigger)) {
      problems.push(
        `${where}: “${ACTION_DEFS[a.type]?.label ?? a.type}” acts on a task, so it needs a task trigger.`,
      );
    }
    if (a.type === "set_priority" && !a.priority) {
      problems.push(`${where}: choose a priority.`);
    }
    if (a.type === "set_due_date" && a.dueInDays === undefined) {
      problems.push(`${where}: say how many days from now.`);
    }
    if (a.type === "assign_task" && a.assigneeId === undefined) {
      problems.push(`${where}: choose who owns it, or choose nobody deliberately.`);
    }
    if ((a.type === "add_tag" || a.type === "remove_tag") && !a.tag?.trim()) {
      problems.push(`${where}: name the tag.`);
    }
    if (a.type === "move_to_section" && !a.sectionId) {
      problems.push(`${where}: choose the section to move it to.`);
    }
    if (a.type === "create_follow_up" && !a.templateTaskId) {
      problems.push(`${where}: choose the template task to copy.`);
    }
    if (a.type === "notify_team" && !a.teamId) {
      problems.push(`${where}: choose the team to notify.`);
    }
    if (a.type === "create_task" && !a.title?.trim()) {
      problems.push(`${where}: a task needs a title.`);
    }
    if (a.type === "draft_email" && !a.subject?.trim() && !a.templateId) {
      problems.push(`${where}: a draft needs a subject or a template.`);
    }
    if ((a.type === "add_signal" || a.type === "remove_signal") && !a.signal?.trim()) {
      problems.push(`${where}: name the signal tag.`);
    }
    if (a.type === "notify_user" && !a.userId) {
      problems.push(`${where}: choose who to notify.`);
    }
  });
  return problems;
}

/** Does the trigger this rule uses supply the field a condition asks about? */
export function describeRule(rule: {
  name: string;
  trigger: Trigger;
  conditions: Condition[];
  actions: Action[];
}): string {
  const when = TRIGGER_DEFS[rule.trigger]?.label ?? rule.trigger;
  const ifs =
    rule.conditions.length === 0
      ? ""
      : ` if ${rule.conditions
          .map((c) => `${c.field} ${OPERATOR_LABELS[c.operator]} ${c.value ?? ""}`.trim())
          .join(" and ")}`;
  const thens = rule.actions.map((a) => ACTION_DEFS[a.type]?.label ?? a.type).join(", ");
  return `When ${when.toLowerCase()}${ifs} → ${thens}`;
}
