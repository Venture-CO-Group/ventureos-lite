"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";
import { workspaceMembers } from "@/modules/leads/table";
import { listPipelines } from "@/modules/deals/store";
import {
  MAX_RULES,
  isTaskTrigger,
  ruleSchema,
  validateActions,
  type Action,
  type Condition,
  type Trigger,
} from "./types";

/**
 * The rule builder's server side (playbook-v2 P7/5).
 *
 * OWNER-GATED, as the playbook requires. A rule is standing permission for the
 * system to act on its own; who may grant that is not a per-user preference.
 */

export interface RuleView {
  id: string;
  name: string;
  trigger: Trigger;
  triggerConfig: Record<string, string | number>;
  conditions: Condition[];
  actions: Action[];
  enabled: boolean;
  version: number;
  /** Which board this rule watches, or null for the whole workspace. */
  boardId: string | null;
  /** Last few runs, newest first. */
  recent: RunView[];
}

export interface RunView {
  id: string;
  status: string;
  detail: string;
  at: string;
  ruleVersion: number;
  /** How deep in a chain of rule-triggered-rule this run sat. */
  depth: number;
  /** Per-action outcomes, so "2 of 3 ran" can say which one did not. */
  results: Array<{ type: string; ok: boolean; detail: string }>;
}

export interface WorkflowView {
  rules: RuleView[];
  isOwner: boolean;
  /** Options the builder needs: stages, sources, members, templates. */
  members: Array<{ id: string; name: string }>;
  dealStages: Array<{ key: string; label: string }>;
  emailTemplates: Array<{ id: string; name: string }>;
  /** Board automations (playbook-v5 P20/5): what a task rule can point at. */
  boards: Array<{ id: string; name: string; sections: Array<{ id: string; name: string }> }>;
  teams: Array<{ id: string; name: string }>;
  /** Tasks on template boards, for the follow-up action. */
  templateTasks: Array<{ id: string; label: string }>;
  atLimit: boolean;
}

export async function getWorkflows(): Promise<WorkflowView> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  let owner = false;
  try {
    await requireGrant("settings.manage");
    owner = true;
  } catch {
    owner = false;
  }

  const [rules, members, pipelines, templates, boards, teams, templateTasks] = await Promise.all([
    db.workflowRule.findMany({
      orderBy: { createdAt: "asc" },
      include: { runs: { orderBy: { at: "desc" }, take: 5 } },
    }),
    workspaceMembers(workspaceId),
    listPipelines(db),
    db.template.findMany({
      where: { type: "EMAIL", status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    // Real boards only: a rule on a template board would watch a board nobody
    // works in.
    db.taskBoard.findMany({
      where: { isTemplate: false, archivedAt: null },
      orderBy: { position: "asc" },
      select: {
        id: true,
        name: true,
        sections: { orderBy: { position: "asc" }, select: { id: true, name: true } },
      },
    }),
    db.team.findMany({
      where: { archivedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.task.findMany({
      where: { board: { isTemplate: true }, parentId: null },
      orderBy: { title: "asc" },
      take: 100,
      select: { id: true, title: true, board: { select: { name: true } } },
    }),
  ]);

  // De-duplicated by KEY, not by id: the same stage exists on both pipelines,
  // and a rule that says "when a deal reaches Won" should mean either board.
  const stageMap = new Map<string, string>();
  for (const p of pipelines) {
    for (const s of p.stages) if (!stageMap.has(s.key)) stageMap.set(s.key, s.name);
  }

  return {
    isOwner: owner,
    members,
    dealStages: [...stageMap].map(([key, label]) => ({ key, label })),
    emailTemplates: templates,
    boards,
    teams,
    templateTasks: templateTasks.map((t) => ({
      id: t.id,
      label: `${t.board?.name ?? "template"} · ${t.title}`,
    })),
    atLimit: rules.length >= MAX_RULES,
    rules: rules.map((r) => ({
      id: r.id,
      name: r.name,
      trigger: r.trigger as Trigger,
      triggerConfig: (r.triggerConfig ?? {}) as Record<string, string | number>,
      conditions: (r.conditions ?? []) as unknown as Condition[],
      actions: (r.actions ?? []) as unknown as Action[],
      enabled: r.enabled,
      version: r.version,
      boardId: r.boardId,
      recent: r.runs.map((run) => ({
        id: run.id,
        status: run.status,
        detail: run.detail,
        at: run.at.toISOString(),
        ruleVersion: run.ruleVersion,
        depth: run.depth,
        results: Array.isArray(run.results)
          ? (run.results as unknown as Array<{ type: string; ok: boolean; detail: string }>)
          : [],
      })),
    })),
  };
}

export type RuleResult = { ok: true; id: string } | { ok: false; error: string };

async function ownerOnly(): Promise<string | null> {
  try {
    await requireGrant("settings.manage");
    return null;
  } catch {
    return "You need the settings.manage capability to change automation rules.";
  }
}

export async function saveRule(raw: unknown): Promise<RuleResult> {
  const parsed = ruleSchema.extend({ id: z.string().min(1).optional() }).safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "That rule is not valid." };
  }
  const denied = await ownerOnly();
  if (denied) return { ok: false, error: denied };

  /**
   * The trigger goes in, so a task action on a lead trigger is refused here
   * rather than saving a rule that fires cleanly and does nothing for ever.
   */
  const problems = validateActions(parsed.data.actions as Action[], parsed.data.trigger);
  if (problems.length > 0) return { ok: false, error: problems[0] };
  if (parsed.data.boardId && !isTaskTrigger(parsed.data.trigger)) {
    return {
      ok: false,
      error: "Only a task trigger can watch one board — leave the board empty for this trigger.",
    };
  }

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const clash = await db.workflowRule.findFirst({
    where: { name: parsed.data.name },
    select: { id: true },
  });
  if (clash && clash.id !== parsed.data.id) {
    return { ok: false, error: "A rule with that name already exists." };
  }

  if (!parsed.data.id) {
    const count = await db.workflowRule.count();
    /**
     * The cap FAILS LOUDLY (playbook-v5 P20/5) rather than degrading: the
     * twenty-first rule is refused with a sentence, and no existing rule
     * quietly stops running to make room for it.
     */
    if (count >= MAX_RULES) {
      return {
        ok: false,
        error: `A workspace may have at most ${MAX_RULES} rules. Delete or disable one first — nothing is dropped to make room.`,
      };
    }
  }

  const data = {
    name: parsed.data.name,
    trigger: parsed.data.trigger,
    triggerConfig: parsed.data.triggerConfig as object,
    conditions: parsed.data.conditions as unknown as object[],
    actions: parsed.data.actions as unknown as object[],
    enabled: parsed.data.enabled,
    boardId: parsed.data.boardId,
  };

  const rule = parsed.data.id
    ? await db.workflowRule.update({
        where: { id: parsed.data.id },
        // Every edit is a new VERSION, stamped onto subsequent runs — so a log
        // entry from last week cannot be read as an explanation of a rule
        // somebody rewrote yesterday.
        data: { ...data, version: { increment: 1 } },
      })
    : await db.workflowRule.create({ data: { workspaceId, ...data, createdBy: userId } });

  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: parsed.data.id ? "workflow.update" : "workflow.create",
      entityType: "WorkflowRule",
      entityId: rule.id,
      meta: {
        name: rule.name,
        trigger: rule.trigger,
        version: rule.version,
        boardId: rule.boardId,
      },
    },
  });

  revalidatePath("/settings");
  return { ok: true, id: rule.id };
}

/** The kill switch. Kept rather than deleted, so its run log survives. */
export async function setRuleEnabled(
  id: string,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const denied = await ownerOnly();
  if (denied) return { ok: false, error: denied };

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const { count } = await db.workflowRule.updateMany({ where: { id }, data: { enabled } });
  if (count === 0) return { ok: false, error: "That rule no longer exists." };

  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: enabled ? "workflow.enable" : "workflow.disable",
      entityType: "WorkflowRule",
      entityId: id,
    },
  });
  revalidatePath("/settings");
  return { ok: true };
}

export async function deleteRule(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const denied = await ownerOnly();
  if (denied) return { ok: false, error: denied };

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rule = await db.workflowRule.findUnique({ where: { id }, select: { name: true } });
  if (!rule) return { ok: false, error: "That rule no longer exists." };

  await db.workflowRule.delete({ where: { id } });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "workflow.delete",
      entityType: "WorkflowRule",
      entityId: id,
      meta: { name: rule.name },
    },
  });
  revalidatePath("/settings");
  return { ok: true };
}

