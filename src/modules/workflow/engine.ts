/**
 * Running workflow rules (playbook-v2 P7/5).
 *
 * Workspace-id in rather than session-derived, like every other engine here.
 * The trigger points call `fireWorkflow` and never wait on it for correctness:
 * an automation failing must not fail the stage move that caused it.
 *
 * CLAUDE.md hard rule #2 lives in `runDraftEmail`: the email action writes a
 * Message with status DRAFT and nothing else. There is no send path from here,
 * and the human-edit guardrail (#6) still applies to it downstream, because it
 * is an ordinary draft on an ordinary lead.
 */

import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { readValues } from "@/modules/fields/types";
import { wakeUpDate } from "@/modules/pipeline/schedule";
import { safeDeliver } from "@/modules/notifications/notify";
import {
  ROOT_CHAIN,
  canRun,
  conditionsMatch,
  descend,
  type Action,
  type ChainContext,
  type Condition,
  type Trigger,
  type WorkflowFacts,
} from "./types";

export interface WorkflowEvent {
  trigger: Trigger;
  /** lead | deal | task — what the actions act on. */
  entityType: "lead" | "deal" | "task";
  entityId: string;
  /** The lead the actions attach to. A deal event carries its lead's id here. */
  leadId: string | null;
  /**
   * The task the board actions act on (playbook-v5 P20/5).
   *
   * Separate from `entityId` because a task event about a task ON a lead
   * carries both, and an overdue sweep entry has always carried the lead in
   * `entityId` — changing that would rewrite the meaning of every existing
   * run-log row.
   */
  taskId?: string | null;
  facts: WorkflowFacts;
  chain?: ChainContext;
}

interface LoadedRule {
  id: string;
  name: string;
  version: number;
  trigger: string;
  triggerConfig: Record<string, unknown>;
  conditions: Condition[];
  actions: Action[];
  /** Null means the whole workspace (playbook-v5 P20/5). */
  boardId: string | null;
}

type Db = ReturnType<typeof getWorkspaceClient>;

/**
 * Does the trigger's own configuration match?
 *
 * Separate from the conditions because it is not a condition — "when a lead
 * reaches Contacted" is part of WHICH event this rule listens for, and a rule
 * whose stage does not match should not appear in the log as a considered
 * no-match every time any lead moves anywhere.
 */
function triggerMatches(rule: LoadedRule, event: WorkflowEvent): boolean {
  const config = rule.triggerConfig ?? {};

  /**
   * A board rule watches one board (playbook-v5 P20/5). Checked before the
   * trigger's own config, because "wrong board" is not a near miss worth a
   * no-match entry in the log — the rule was never listening.
   */
  if (rule.boardId && rule.boardId !== (event.facts.board ?? null)) return false;
  switch (rule.trigger as Trigger) {
    case "lead_stage_changed":
      return !config.stage || String(config.stage) === String(event.facts.stage ?? "");
    case "deal_stage_changed":
      return !config.stage || String(config.stage) === String(event.facts.dealStage ?? "");
    case "lead_created":
      return !config.source || String(config.source) === String(event.facts.source ?? "");
    case "task_overdue": {
      const needed = Number(config.days ?? 0);
      const actual = Number(event.facts.overdueDays ?? 0);
      return Number.isFinite(needed) ? actual >= needed : true;
    }
    case "task_moved":
      // No section configured means "any move on this board", which is a
      // legitimate rule and not an unfinished one.
      return !config.section || String(config.section) === String(event.facts.section ?? "");
    default:
      return true;
  }
}

export interface ActionResult {
  type: string;
  ok: boolean;
  detail: string;
}

/**
 * Evaluate every enabled rule for this event.
 *
 * Every evaluation is LOGGED, including the no-matches: "why did my rule not
 * fire?" is the question an execution log exists to answer, and a log that
 * records only successes cannot answer it.
 */
export async function fireWorkflow(
  workspaceId: string,
  event: WorkflowEvent,
): Promise<number> {
  const chain = event.chain ?? ROOT_CHAIN;
  const db = getWorkspaceClient(workspaceId);

  const rules = (await db.workflowRule.findMany({
    where: { trigger: event.trigger, enabled: true },
    orderBy: { createdAt: "asc" },
  })) as unknown as Array<LoadedRule & { enabled: boolean }>;

  let fired = 0;
  for (const rule of rules) {
    if (!triggerMatches(rule, event)) continue;

    const verdict = canRun(rule, chain);
    if (!verdict.allowed) {
      await log(db, workspaceId, rule, event, chain, "skipped", [], {
        detail:
          verdict.reason === "self_trigger"
            ? "Skipped: this rule already ran for this event, so it cannot re-trigger itself."
            : `Skipped: ${chain.depth} rules have already run for this event (the chain limit).`,
      });
      continue;
    }

    if (!conditionsMatch(event.facts, rule.conditions ?? [])) {
      await log(db, workspaceId, rule, event, chain, "no_match", [], {
        detail: "Conditions did not match.",
      });
      continue;
    }

    /**
     * The chain THIS rule's actions run under.
     *
     * Computed before the actions rather than after, because a task action can
     * cause another trigger to fire (setting a priority is a priority change),
     * and that follow-on fire has to be told this rule already ran or the
     * self-trigger guard cannot see the loop it exists to catch.
     */
    const next = descend(rule, chain);

    const results: ActionResult[] = [];
    for (const action of rule.actions ?? []) {
      try {
        results.push(await runAction(db, workspaceId, event, action, next));
      } catch (e) {
        results.push({ type: action.type, ok: false, detail: (e as Error).message });
      }
    }

    const failures = results.filter((r) => !r.ok);
    await log(
      db,
      workspaceId,
      rule,
      event,
      chain,
      failures.length === results.length && results.length > 0 ? "failed" : "matched",
      results,
      {
        detail:
          failures.length === 0
            ? results.map((r) => r.detail).join("; ")
            : `${results.length - failures.length} of ${results.length} actions ran; ${failures
                .map((f) => f.detail)
                .join("; ")}`,
      },
    );
    fired += 1;

    // Anything this event goes on to cause is one level deeper. The depth
    // counts RULES, which is what the limit is about.
    event.chain = next;
  }

  return fired;
}

async function log(
  db: Db,
  workspaceId: string,
  rule: LoadedRule,
  event: WorkflowEvent,
  chain: ChainContext,
  status: string,
  results: ActionResult[],
  opts: { detail: string },
): Promise<void> {
  await db.workflowRun
    .create({
      data: {
        workspaceId,
        ruleId: rule.id,
        ruleVersion: rule.version,
        trigger: event.trigger,
        entityType: event.entityType,
        entityId: event.entityId,
        status,
        detail: opts.detail,
        results: results as unknown as object[],
        depth: chain.depth,
      },
    })
    .catch(() => {
      /* the log is evidence, not a dependency — never fail a rule over it */
    });
}

// ---- the actions --------------------------------------------------------------

async function runAction(
  db: Db,
  workspaceId: string,
  event: WorkflowEvent,
  action: Action,
  chain: ChainContext,
): Promise<ActionResult> {
  switch (action.type) {
    case "create_task":
      return runCreateTask(db, workspaceId, event, action);
    case "draft_email":
      return runDraftEmail(db, workspaceId, event, action);
    case "add_signal":
    case "remove_signal":
      return runSignal(db, event, action);
    case "move_not_now":
      return runNotNow(db, event);
    case "notify_user":
      return runNotify(workspaceId, event, action);
    // ---- board automations (playbook-v5 P20/5) ----
    case "set_priority":
      return runSetPriority(db, workspaceId, event, action, chain);
    case "set_due_date":
      return runSetDueDate(db, event, action);
    case "assign_task":
      return runAssign(db, workspaceId, event, action, chain);
    case "add_tag":
    case "remove_tag":
      return runTag(db, event, action);
    case "move_to_section":
      return runMoveToSection(db, workspaceId, event, action, chain);
    case "create_follow_up":
      return runFollowUp(db, workspaceId, event, action);
    case "notify_team":
      return runNotifyTeam(workspaceId, event, action);
    default:
      return { type: action.type, ok: false, detail: "Unknown action." };
  }
}

// ---- board automations (playbook-v5 P20/5) -------------------------------------

/**
 * The task a board action acts on, or the reason there is not one.
 *
 * Every one of these actions needs a task, and `validateActions` refuses the
 * combination that could not have one — this is the runtime half of the same
 * check, because a rule saved before that validation existed must fail with a
 * sentence rather than a stack trace.
 */
async function actOnTask(
  db: Db,
  event: WorkflowEvent,
  action: Action,
): Promise<
  | { ok: true; task: { id: string; boardId: string | null; sectionId: string | null; tags: unknown; priority: string; assigneeId: string | null; entityType: string | null; entityId: string | null; title: string } }
  | { ok: false; result: ActionResult }
> {
  if (!event.taskId) {
    return {
      ok: false,
      result: { type: action.type, ok: false, detail: "This trigger carries no task to act on." },
    };
  }
  const task = await db.task.findUnique({
    where: { id: event.taskId },
    select: {
      id: true,
      title: true,
      boardId: true,
      sectionId: true,
      tags: true,
      priority: true,
      assigneeId: true,
      entityType: true,
      entityId: true,
    },
  });
  if (!task) {
    return {
      ok: false,
      result: { type: action.type, ok: false, detail: "That task no longer exists." },
    };
  }
  return { ok: true, task };
}

async function runSetPriority(
  db: Db,
  workspaceId: string,
  event: WorkflowEvent,
  action: Action,
  chain: ChainContext,
): Promise<ActionResult> {
  const found = await actOnTask(db, event, action);
  if (!found.ok) return found.result;
  const priority = action.priority ?? "none";
  if (found.task.priority === priority) {
    // Not a failure, and deliberately not a follow-on event either: a rule
    // that re-sets a value to what it already was must not wake the engine.
    return { type: action.type, ok: true, detail: `Priority was already ${priority}` };
  }

  await db.task.update({ where: { id: found.task.id }, data: { priority } });
  await refire(workspaceId, "task_priority_changed", found.task.id, chain);
  return { type: action.type, ok: true, detail: `Set priority to ${priority}` };
}

async function runSetDueDate(
  db: Db,
  event: WorkflowEvent,
  action: Action,
): Promise<ActionResult> {
  const found = await actOnTask(db, event, action);
  if (!found.ok) return found.result;
  const due = new Date();
  due.setDate(due.getDate() + (action.dueInDays ?? 0));
  due.setHours(17, 0, 0, 0);
  await db.task.update({ where: { id: found.task.id }, data: { dueAt: due } });
  return {
    type: action.type,
    ok: true,
    detail: `Due ${due.toISOString().slice(0, 10)} (${action.dueInDays ?? 0}d from the rule firing)`,
  };
}

async function runAssign(
  db: Db,
  workspaceId: string,
  event: WorkflowEvent,
  action: Action,
  chain: ChainContext,
): Promise<ActionResult> {
  const found = await actOnTask(db, event, action);
  if (!found.ok) return found.result;
  const assigneeId = action.assigneeId ? action.assigneeId : null;

  if (assigneeId) {
    const member = await prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId: assigneeId, workspaceId } },
      select: { userId: true },
    });
    if (!member) {
      return { type: action.type, ok: false, detail: "That person is not in this workspace." };
    }
  }
  if (found.task.assigneeId === assigneeId) {
    return { type: action.type, ok: true, detail: "It was already theirs" };
  }

  /**
   * Through the same function a person's reassignment goes through
   * (playbook-v5 P20/6), so a rule's handover appears in the trail — with a
   * null actor, which is how the trail says "the system did this".
   */
  const { applyAssignment } = await import("@/modules/tasks/collaborators");
  await applyAssignment(workspaceId, found.task.id, {
    before: found.task.assigneeId,
    after: assigneeId,
    actorUserId: null,
  });
  await refire(workspaceId, "task_assignee_changed", found.task.id, chain);
  return {
    type: action.type,
    ok: true,
    detail: assigneeId ? "Reassigned" : "Left unassigned deliberately",
  };
}

async function runTag(db: Db, event: WorkflowEvent, action: Action): Promise<ActionResult> {
  const found = await actOnTask(db, event, action);
  if (!found.ok) return found.result;
  const tag = (action.tag ?? "").trim();
  if (!tag) return { type: action.type, ok: false, detail: "No tag named." };

  const current = Array.isArray(found.task.tags) ? (found.task.tags as string[]) : [];
  const next =
    action.type === "add_tag"
      ? current.includes(tag)
        ? current
        : [...current, tag]
      : current.filter((t) => t !== tag);
  if (next.length === current.length && action.type === "add_tag") {
    return { type: action.type, ok: true, detail: `Tag “${tag}” was already there` };
  }
  await db.task.update({ where: { id: found.task.id }, data: { tags: next } });
  return {
    type: action.type,
    ok: true,
    detail: `${action.type === "add_tag" ? "Added" : "Removed"} tag “${tag}”`,
  };
}

async function runMoveToSection(
  db: Db,
  workspaceId: string,
  event: WorkflowEvent,
  action: Action,
  chain: ChainContext,
): Promise<ActionResult> {
  const found = await actOnTask(db, event, action);
  if (!found.ok) return found.result;
  if (!action.sectionId) {
    return { type: action.type, ok: false, detail: "No section chosen." };
  }

  const section = await db.taskSection.findUnique({
    where: { id: action.sectionId },
    select: { id: true, name: true, boardId: true },
  });
  if (!section) {
    return { type: action.type, ok: false, detail: "That section no longer exists." };
  }
  /**
   * Same board only. Moving a task to a column on another board would take it
   * off the board somebody is looking at, and "the automation moved it and I
   * cannot find it" is the worst thing an automation can do.
   */
  if (found.task.boardId && section.boardId !== found.task.boardId) {
    return {
      type: action.type,
      ok: false,
      detail: "That section is on another board — a rule may not move a task off its board.",
    };
  }
  if (found.task.sectionId === section.id) {
    return { type: action.type, ok: true, detail: `Already in ${section.name}` };
  }

  await db.task.update({
    where: { id: found.task.id },
    data: { sectionId: section.id, boardId: found.task.boardId ?? section.boardId },
  });
  await refire(workspaceId, "task_moved", found.task.id, chain);
  return { type: action.type, ok: true, detail: `Moved to ${section.name}` };
}

/**
 * A follow-up copied off a template board.
 *
 * A template here is what a template has always been in this product: a board
 * nobody works in, holding tasks with titles, notes, priorities and RELATIVE
 * due offsets. Copying one of those tasks is the whole action — there is no
 * second template model to keep in step.
 */
async function runFollowUp(
  db: Db,
  workspaceId: string,
  event: WorkflowEvent,
  action: Action,
): Promise<ActionResult> {
  const found = await actOnTask(db, event, action);
  if (!found.ok) return found.result;
  if (!action.templateTaskId) {
    return { type: action.type, ok: false, detail: "No template task chosen." };
  }

  const template = await db.task.findUnique({
    where: { id: action.templateTaskId },
    select: {
      title: true,
      note: true,
      type: true,
      priority: true,
      dueOffsetDays: true,
      board: { select: { isTemplate: true } },
    },
  });
  if (!template) {
    return { type: action.type, ok: false, detail: "That template task no longer exists." };
  }
  if (!template.board?.isTemplate) {
    return {
      type: action.type,
      ok: false,
      detail: "That task is not on a template board — pick one that is.",
    };
  }

  const offset = template.dueOffsetDays ?? action.dueInDays ?? 1;
  const due = new Date();
  due.setDate(due.getDate() + offset);
  due.setHours(17, 0, 0, 0);

  await db.task.create({
    data: {
      workspaceId,
      title: template.title,
      note: template.note,
      type: template.type,
      priority: template.priority,
      dueAt: due,
      // Beside the task that caused it, on the same board and in the same
      // column, so it is somewhere a person will actually see it.
      boardId: found.task.boardId,
      sectionId: found.task.sectionId,
      entityType: found.task.entityType,
      entityId: found.task.entityId,
      source: "workflow",
    },
  });
  return { type: action.type, ok: true, detail: `Created follow-up “${template.title}”` };
}

async function runNotifyTeam(
  workspaceId: string,
  event: WorkflowEvent,
  action: Action,
): Promise<ActionResult> {
  if (!action.teamId) return { type: action.type, ok: false, detail: "No team chosen." };
  const db = getWorkspaceClient(workspaceId);
  const team = await db.team.findUnique({
    where: { id: action.teamId },
    select: { name: true, archivedAt: true, members: { select: { userId: true } } },
  });
  if (!team) return { type: action.type, ok: false, detail: "That team no longer exists." };
  if (team.archivedAt) {
    return { type: action.type, ok: false, detail: `Team “${team.name}” is archived.` };
  }
  if (team.members.length === 0) {
    return { type: action.type, ok: false, detail: `Team “${team.name}” has nobody on it.` };
  }

  await safeDeliver({
    workspaceId,
    userIds: team.members.map((m) => m.userId),
    type: "task_due",
    title: action.message ?? `A rule fired for ${team.name}`,
    body: action.message ?? null,
    href: event.taskId ? `/tasks?task=${event.taskId}` : "/",
    entityType: event.entityType,
    entityId: event.entityId,
    discriminator: `workflow:${event.entityId}:${new Date().toISOString().slice(0, 13)}`,
  });
  return { type: action.type, ok: true, detail: `Notified ${team.members.length} on ${team.name}` };
}

/**
 * A follow-on trigger caused by a rule's own action (playbook-v5 P20/5).
 *
 * This is the honest way to have cycle protection that means something: a rule
 * whose action is itself a trigger DOES wake the engine again, carrying the
 * chain, and the guard in `canRun` refuses the second visit and writes the
 * refusal to the log. If actions quietly fired nothing, loops would be
 * impossible and so would the evidence that they are prevented.
 *
 * Imported lazily to break the cycle between this file and the trigger points.
 */
async function refire(
  workspaceId: string,
  trigger: Trigger,
  taskId: string,
  chain: ChainContext,
): Promise<void> {
  try {
    const { fireTaskTrigger } = await import("./triggers");
    await fireTaskTrigger(workspaceId, trigger, taskId, chain);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[workflow] follow-on trigger failed", e);
  }
}

async function runCreateTask(
  db: Db,
  workspaceId: string,
  event: WorkflowEvent,
  action: Action,
): Promise<ActionResult> {
  const due = new Date();
  due.setDate(due.getDate() + (action.dueInDays ?? 1));
  due.setHours(17, 0, 0, 0);

  await db.task.create({
    data: {
      workspaceId,
      title: action.title ?? "Follow up",
      type: action.taskType ?? "todo",
      dueAt: due,
      entityType: event.entityType,
      entityId: event.entityId,
      // Stamped so the Today Queue can say WHY this task exists — a task that
      // appeared on its own with no explanation is a task people ignore.
      source: "workflow",
    },
  });
  return { type: action.type, ok: true, detail: `Created task “${action.title ?? "Follow up"}”` };
}

/**
 * CLAUDE.md hard rule #2. This writes a DRAFT and stops.
 *
 * Status DRAFT, `aiDrafted` false (a template is not Claude), and no send path
 * of any kind. A person opens the lead, reads it, edits it and sends it — and
 * the human-edit guardrail applies to it downstream exactly as it does to
 * anything else on that lead.
 */
async function runDraftEmail(
  db: Db,
  workspaceId: string,
  event: WorkflowEvent,
  action: Action,
): Promise<ActionResult> {
  if (!event.leadId) {
    return { type: action.type, ok: false, detail: "No lead to draft against." };
  }

  let body = action.body ?? "";
  let subject = action.subject ?? "";
  if (action.templateId) {
    const template = await db.template.findUnique({
      where: { id: action.templateId },
      select: { body: true, name: true, type: true },
    });
    if (!template || template.type !== "EMAIL") {
      return { type: action.type, ok: false, detail: "That email template no longer exists." };
    }
    body = template.body;
    subject = subject || template.name;
  }
  if (!body.trim()) {
    return { type: action.type, ok: false, detail: "Nothing to draft — no template and no body." };
  }

  await db.message.create({
    data: {
      workspaceId,
      leadId: event.leadId,
      direction: "OUTBOUND",
      channel: "EMAIL",
      kind: "workflow_draft",
      body: subject ? `${subject}\n\n${body}` : body,
      // Not Claude's work, so not an AI draft — the flag means something
      // specific (rule #6) and must not be borrowed for "generated somehow".
      aiDrafted: false,
      status: "DRAFT",
    },
  });
  return {
    type: action.type,
    ok: true,
    detail: "Prepared an email draft — a person must review and send it",
  };
}

async function runSignal(db: Db, event: WorkflowEvent, action: Action): Promise<ActionResult> {
  if (!event.leadId) return { type: action.type, ok: false, detail: "No lead." };
  const tag = (action.signal ?? "").trim();
  if (!tag) return { type: action.type, ok: false, detail: "No signal named." };

  const lead = await db.lead.findUnique({
    where: { id: event.leadId },
    select: { signals: true },
  });
  if (!lead) return { type: action.type, ok: false, detail: "Lead not found." };

  const current = Array.isArray(lead.signals) ? (lead.signals as string[]) : [];
  const next =
    action.type === "add_signal"
      ? current.includes(tag)
        ? current
        : [...current, tag]
      : current.filter((s) => s !== tag);

  if (next.length === current.length && action.type === "add_signal") {
    return { type: action.type, ok: true, detail: `Signal “${tag}” was already there` };
  }
  await db.lead.update({ where: { id: event.leadId }, data: { signals: next } });
  return {
    type: action.type,
    ok: true,
    detail: `${action.type === "add_signal" ? "Added" : "Removed"} signal “${tag}”`,
  };
}

async function runNotNow(db: Db, event: WorkflowEvent): Promise<ActionResult> {
  if (!event.leadId) return { type: "move_not_now", ok: false, detail: "No lead." };
  const now = new Date();
  await db.lead.update({
    where: { id: event.leadId },
    data: {
      stage: "NOT_NOW",
      stageEnteredAt: now,
      // The usual wake-up, so it resurfaces rather than disappearing.
      wakeUpAt: wakeUpDate(now),
    },
  });
  return { type: "move_not_now", ok: true, detail: "Moved to Not now with a wake-up date" };
}

async function runNotify(
  workspaceId: string,
  event: WorkflowEvent,
  action: Action,
): Promise<ActionResult> {
  if (!action.userId) return { type: action.type, ok: false, detail: "Nobody to notify." };
  const member = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId: action.userId, workspaceId } },
    select: { userId: true },
  });
  if (!member) {
    return { type: action.type, ok: false, detail: "That person is not in this workspace." };
  }

  await safeDeliver({
    workspaceId,
    userIds: [action.userId],
    // Reuses an existing type rather than inventing a workflow-only one: a
    // preference matrix that grows a row every time somebody writes a rule is
    // a preference matrix nobody configures.
    type: "task_due",
    title: action.message ?? "A workflow rule fired",
    body: action.message ?? null,
    href: event.leadId ? `/leads?lead=${event.leadId}` : "/",
    entityType: event.entityType,
    entityId: event.entityId,
    // One per entity per person per hour: a rule that fires on every stage
    // move must not become a bell that rings for each of them.
    discriminator: `workflow:${event.entityId}:${new Date().toISOString().slice(0, 13)}`,
  });
  return { type: action.type, ok: true, detail: "Notified" };
}

// ---- fact builders -------------------------------------------------------------

/** Everything a rule may look at, for a lead. One read, no N+1. */
export async function leadFacts(
  workspaceId: string,
  leadId: string,
): Promise<WorkflowFacts | null> {
  const db = getWorkspaceClient(workspaceId);
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: {
      stage: true,
      source: true,
      icpScore: true,
      ownerId: true,
      email: true,
      signals: true,
      customFields: true,
      company: { select: { industry: true, city: true } },
    },
  });
  if (!lead) return null;

  const facts: WorkflowFacts = {
    stage: lead.stage,
    source: lead.source,
    icpScore: lead.icpScore,
    ownerId: lead.ownerId,
    email: lead.email,
    industry: lead.company?.industry ?? null,
    city: lead.company?.city ?? null,
    signals: Array.isArray(lead.signals) ? (lead.signals as string[]) : [],
  };
  // Custom fields are addressable as `cf:<key>`, the same reference the filter
  // builder and the table columns use.
  for (const [key, value] of Object.entries(readValues(lead.customFields))) {
    facts[`cf:${key}`] = value as WorkflowFacts[string];
  }
  return facts;
}

export async function dealFacts(
  workspaceId: string,
  dealId: string,
): Promise<{ facts: WorkflowFacts; leadId: string | null } | null> {
  const db = getWorkspaceClient(workspaceId);
  const deal = await db.deal.findUnique({
    where: { id: dealId },
    select: {
      value: true,
      status: true,
      leadId: true,
      customFields: true,
      stage: { select: { name: true, key: true } },
      pipeline: { select: { name: true, key: true } },
    },
  });
  if (!deal) return null;

  const base = deal.leadId ? await leadFacts(workspaceId, deal.leadId) : null;
  const facts: WorkflowFacts = {
    ...(base ?? {}),
    dealValue: deal.value,
    dealStage: deal.stage.key,
    dealStageName: deal.stage.name,
    dealStatus: deal.status,
    pipeline: deal.pipeline.key,
  };
  for (const [key, value] of Object.entries(readValues(deal.customFields))) {
    facts[`cf:${key}`] = value as WorkflowFacts[string];
  }
  return { facts, leadId: deal.leadId };
}

/**
 * Everything a rule may look at, for a task (playbook-v5 P20/5).
 *
 * One read. The lead's own facts are folded in when the task hangs off a lead,
 * so a board rule can still say "…and only if the lead's ICP score is at least
 * four" without a second trigger type.
 */
export async function taskFacts(
  workspaceId: string,
  taskId: string,
  extra: WorkflowFacts = {},
): Promise<{ facts: WorkflowFacts; leadId: string | null } | null> {
  const db = getWorkspaceClient(workspaceId);
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      type: true,
      priority: true,
      tags: true,
      dueAt: true,
      doneAt: true,
      assigneeId: true,
      boardId: true,
      sectionId: true,
      entityType: true,
      entityId: true,
      customFields: true,
      section: { select: { name: true } },
      board: { select: { name: true } },
    },
  });
  if (!task) return null;

  const leadId = task.entityType === "lead" ? task.entityId : null;
  const base = leadId ? await leadFacts(workspaceId, leadId) : null;

  const facts: WorkflowFacts = {
    ...(base ?? {}),
    taskTitle: task.title,
    taskType: task.type,
    priority: task.priority,
    tags: Array.isArray(task.tags) ? (task.tags as string[]) : [],
    assigneeId: task.assigneeId,
    // Ids, not names: a rule written against "Blocked" would break the moment
    // somebody renamed the column, and the picker stores the id anyway.
    board: task.boardId,
    section: task.sectionId,
    boardName: task.board?.name ?? null,
    sectionName: task.section?.name ?? null,
    overdueDays:
      task.dueAt && !task.doneAt
        ? Math.floor((Date.now() - task.dueAt.getTime()) / 86_400_000)
        : 0,
    ...extra,
  };
  for (const [key, value] of Object.entries(readValues(task.customFields))) {
    facts[`cf:${key}`] = value as WorkflowFacts[string];
  }
  return { facts, leadId };
}
