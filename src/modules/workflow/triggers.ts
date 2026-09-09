/**
 * Where workflow rules are fired from (playbook-v2 P7/5).
 *
 * One function per trigger, each of them BEST-EFFORT and each of them the last
 * thing its caller does. An automation is a convenience layered on top of an
 * action; it must never be the reason the action fails, and a rule that throws
 * must not roll back a stage move somebody made deliberately.
 *
 * A short-circuit read comes first: `hasRulesFor` is one indexed count, and it
 * keeps the common case — a workspace with no rules at all — down to a query
 * rather than a fact-gathering pass nobody will use.
 */

import { getWorkspaceClient } from "@/lib/db";
import { dealFacts, fireWorkflow, leadFacts, taskFacts } from "./engine";
import { isTaskTrigger, type ChainContext, type Trigger } from "./types";

async function hasRulesFor(workspaceId: string, trigger: Trigger): Promise<boolean> {
  const db = getWorkspaceClient(workspaceId);
  return (await db.workflowRule.count({ where: { trigger, enabled: true } })) > 0;
}

function swallow(where: string) {
  return (e: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`[workflow] ${where} failed`, e);
    return 0;
  };
}

export async function onLeadStageChanged(
  workspaceId: string,
  leadId: string,
): Promise<number> {
  try {
    if (!(await hasRulesFor(workspaceId, "lead_stage_changed"))) return 0;
    const facts = await leadFacts(workspaceId, leadId);
    if (!facts) return 0;
    return fireWorkflow(workspaceId, {
      trigger: "lead_stage_changed",
      entityType: "lead",
      entityId: leadId,
      leadId,
      facts,
    });
  } catch (e) {
    return swallow("lead_stage_changed")(e);
  }
}

export async function onLeadCreated(workspaceId: string, leadId: string): Promise<number> {
  try {
    if (!(await hasRulesFor(workspaceId, "lead_created"))) return 0;
    const facts = await leadFacts(workspaceId, leadId);
    if (!facts) return 0;
    return fireWorkflow(workspaceId, {
      trigger: "lead_created",
      entityType: "lead",
      entityId: leadId,
      leadId,
      facts,
    });
  } catch (e) {
    return swallow("lead_created")(e);
  }
}

export async function onDealStageChanged(
  workspaceId: string,
  dealId: string,
): Promise<number> {
  try {
    if (!(await hasRulesFor(workspaceId, "deal_stage_changed"))) return 0;
    const loaded = await dealFacts(workspaceId, dealId);
    if (!loaded) return 0;
    return fireWorkflow(workspaceId, {
      trigger: "deal_stage_changed",
      entityType: "deal",
      entityId: dealId,
      leadId: loaded.leadId,
      facts: loaded.facts,
    });
  } catch (e) {
    return swallow("deal_stage_changed")(e);
  }
}

export async function onQuoteAccepted(
  workspaceId: string,
  leadId: string | null,
): Promise<number> {
  try {
    if (!leadId) return 0;
    if (!(await hasRulesFor(workspaceId, "quote_accepted"))) return 0;
    const facts = await leadFacts(workspaceId, leadId);
    if (!facts) return 0;
    return fireWorkflow(workspaceId, {
      trigger: "quote_accepted",
      entityType: "lead",
      entityId: leadId,
      leadId,
      facts,
    });
  } catch (e) {
    return swallow("quote_accepted")(e);
  }
}

export async function onMeetingOutcome(
  workspaceId: string,
  leadId: string | null,
  outcome: string | null,
): Promise<number> {
  try {
    if (!leadId) return 0;
    if (!(await hasRulesFor(workspaceId, "meeting_outcome_logged"))) return 0;
    const facts = await leadFacts(workspaceId, leadId);
    if (!facts) return 0;
    return fireWorkflow(workspaceId, {
      trigger: "meeting_outcome_logged",
      entityType: "lead",
      entityId: leadId,
      leadId,
      facts: { ...facts, meetingOutcome: outcome },
    });
  } catch (e) {
    return swallow("meeting_outcome_logged")(e);
  }
}

/**
 * The daily overdue sweep.
 *
 * Checked once a day rather than the moment the clock passes, and the trigger
 * copy says so: a rule that fires the second a task turns overdue would fire at
 * 17:00:01, which is nobody's idea of "overdue by two days".
 */
/**
 * Fire a task trigger (playbook-v5 P20/5).
 *
 * One function for all five, because they differ only in the trigger name and
 * the facts come from the same read. Best-effort like the rest: a rule that
 * throws must not roll back the drag somebody just made.
 *
 * `chain` is passed when the fire was CAUSED by another rule's action, which is
 * how the self-trigger guard sees a loop.
 */
export async function fireTaskTrigger(
  workspaceId: string,
  trigger: Trigger,
  taskId: string,
  chain?: ChainContext,
): Promise<number> {
  try {
    if (!isTaskTrigger(trigger)) return 0;
    if (!(await hasRulesFor(workspaceId, trigger))) return 0;
    const loaded = await taskFacts(workspaceId, taskId);
    if (!loaded) return 0;
    return fireWorkflow(workspaceId, {
      trigger,
      entityType: "task",
      entityId: taskId,
      taskId,
      leadId: loaded.leadId,
      facts: loaded.facts,
      chain,
    });
  } catch (e) {
    return swallow(trigger)(e);
  }
}

export const onTaskCreated = (workspaceId: string, taskId: string) =>
  fireTaskTrigger(workspaceId, "task_created", taskId);

export const onTaskMoved = (workspaceId: string, taskId: string) =>
  fireTaskTrigger(workspaceId, "task_moved", taskId);

export const onTaskCompleted = (workspaceId: string, taskId: string) =>
  fireTaskTrigger(workspaceId, "task_completed", taskId);

export const onTaskPriorityChanged = (workspaceId: string, taskId: string) =>
  fireTaskTrigger(workspaceId, "task_priority_changed", taskId);

export const onTaskAssigneeChanged = (workspaceId: string, taskId: string) =>
  fireTaskTrigger(workspaceId, "task_assignee_changed", taskId);

export async function processWorkflowOverdueSweep(
  nowMs: number = Date.now(),
): Promise<number> {
  const { prismaUnsafe } = await import("@/lib/db");
  const workspaces = await prismaUnsafe.workspace.findMany({ select: { id: true } });
  let fired = 0;

  for (const ws of workspaces) {
    try {
      if (!(await hasRulesFor(ws.id, "task_overdue"))) continue;
      const db = getWorkspaceClient(ws.id);
      const overdue = await db.task.findMany({
        where: { doneAt: null, dueAt: { not: null, lt: new Date(nowMs) } },
        select: { id: true, dueAt: true },
        take: 500,
      });

      for (const task of overdue) {
        const overdueDays = Math.floor((nowMs - task.dueAt!.getTime()) / 86_400_000);
        /**
         * The sweep now carries the TASK as well (playbook-v5 P20/5), so a
         * board action can act on it. `entityId` keeps its old meaning — the
         * lead where there is one — because every run-log row already written
         * means that, and rewriting the meaning of a log is worse than a
         * slightly odd field.
         */
        const loaded = await taskFacts(ws.id, task.id, { overdueDays });
        if (!loaded) continue;
        fired += await fireWorkflow(ws.id, {
          trigger: "task_overdue",
          entityType: loaded.leadId ? "lead" : "task",
          entityId: loaded.leadId ?? task.id,
          taskId: task.id,
          leadId: loaded.leadId,
          facts: loaded.facts,
        });
      }
    } catch (e) {
      swallow("task_overdue sweep")(e);
    }
  }
  return fired;
}
