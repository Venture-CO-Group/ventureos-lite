import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { fireWorkflow, leadFacts } from "../../src/modules/workflow/engine";
import {
  onLeadStageChanged,
  processWorkflowOverdueSweep,
} from "../../src/modules/workflow/triggers";
import { ROOT_CHAIN, type Action, type Condition } from "../../src/modules/workflow/types";

/**
 * Workflow-lite against the real database (playbook-v2 P7/5).
 *
 * The matcher and the cycle rules are unit-tested. What matters here is what
 * an action actually WRITES — and above all that the email action writes a
 * DRAFT and nothing else (CLAUDE.md hard rule #2).
 */
const NAMES = ["Workflow Alpha", "Workflow Bravo"];
const USER = "wf-user-1";
let wsA = "";
let wsB = "";
let companyA = "";

const TABLES = [
  "workflowRun",
  "workflowRule",
  "teamMember",
  "team",
  "taskSection",
  "taskBoard",
  "notification",
  "auditLog",
  "message",
  "task",
  "activity",
  "template",
  "lead",
  "company",
] as const;

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of TABLES) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
  await prismaUnsafe.membership.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
});

afterAll(clean);

beforeEach(async () => {
  for (const t of TABLES) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  }
  companyA = (
    await prismaUnsafe.company.create({
      data: { workspaceId: wsA, name: "Danubia Kft", industry: "HoReCa" },
    })
  ).id;
});

const db = () => getWorkspaceClient(wsA);

async function lead(over: Record<string, unknown> = {}) {
  return prismaUnsafe.lead.create({
    data: {
      workspaceId: wsA,
      companyId: companyA,
      contactName: "Kovács Anna",
      email: "anna@danubia.hu",
      icpScore: 4,
      signals: ["hiring"],
      ...over,
    },
  });
}

async function rule(over: {
  name?: string;
  trigger?: string;
  triggerConfig?: Record<string, unknown>;
  conditions?: Condition[];
  actions: Action[];
  enabled?: boolean;
  workspaceId?: string;
  /** Which board a task rule watches (playbook-v5 P20/5). */
  boardId?: string | null;
}) {
  return prismaUnsafe.workflowRule.create({
    data: {
      workspaceId: over.workspaceId ?? wsA,
      name: over.name ?? `Rule ${Math.random().toString(36).slice(2, 8)}`,
      trigger: over.trigger ?? "lead_stage_changed",
      triggerConfig: (over.triggerConfig ?? {}) as object,
      conditions: over.conditions as unknown as object[],
      actions: over.actions as unknown as object[],
      enabled: over.enabled ?? true,
      boardId: over.boardId ?? null,
    },
  });
}

async function fire(leadId: string, trigger = "lead_stage_changed") {
  const facts = await leadFacts(wsA, leadId);
  return fireWorkflow(wsA, {
    trigger: trigger as never,
    entityType: "lead",
    entityId: leadId,
    leadId,
    facts: facts!,
    chain: ROOT_CHAIN,
  });
}

describe("the email action drafts and stops (CLAUDE.md hard rule #2)", () => {
  it("writes a DRAFT message and nothing that could send it", async () => {
    const l = await lead({ stage: "REPLIED" });
    await rule({
      trigger: "lead_stage_changed",
      triggerConfig: { stage: "REPLIED" },
      actions: [{ type: "draft_email", subject: "Following up", body: "Hi there," }],
    });

    expect(await fire(l.id)).toBe(1);

    const messages = await db().message.findMany({ where: { leadId: l.id } });
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe("DRAFT");
    expect(messages[0].sentAt).toBeNull();
    expect(messages[0].direction).toBe("OUTBOUND");
    // Not Claude's work, so not an AI draft: the flag means something specific
    // (rule #6) and must not be borrowed.
    expect(messages[0].aiDrafted).toBe(false);
    expect(messages[0].body).toContain("Following up");

    // And nothing was queued or logged as sent.
    expect(await db().emailLog.count()).toBe(0);
  });

  it("draws the body from an email template when one is chosen", async () => {
    const template = await db().template.create({
      data: {
        workspaceId: wsA,
        type: "EMAIL",
        lang: "HU",
        name: "Follow-up",
        body: "Kedves {{client.name}},",
        status: "ACTIVE",
      },
    });
    const l = await lead({ stage: "REPLIED" });
    await rule({
      triggerConfig: { stage: "REPLIED" },
      actions: [{ type: "draft_email", templateId: template.id }],
    });

    await fire(l.id);
    const message = await db().message.findFirstOrThrow({ where: { leadId: l.id } });
    expect(message.body).toContain("Kedves");
    expect(message.status).toBe("DRAFT");
  });

  it("fails the action, not the rule, when the template is gone", async () => {
    const l = await lead({ stage: "REPLIED" });
    await rule({
      triggerConfig: { stage: "REPLIED" },
      actions: [{ type: "draft_email", templateId: "no-such-template" }],
    });

    await fire(l.id);
    expect(await db().message.count()).toBe(0);
    const run = await db().workflowRun.findFirstOrThrow();
    expect(run.status).toBe("failed");
    expect(run.detail).toMatch(/no longer exists/);
  });
});

describe("the other actions", () => {
  it("creates a task, stamped so the queue can say why it exists", async () => {
    const l = await lead({ stage: "QUALIFIED" });
    await rule({
      triggerConfig: { stage: "QUALIFIED" },
      actions: [{ type: "create_task", title: "Send the quote", dueInDays: 2 }],
    });

    await fire(l.id);
    const task = await db().task.findFirstOrThrow();
    expect(task.title).toBe("Send the quote");
    expect(task.source).toBe("workflow");
    expect(task.entityId).toBe(l.id);
  });

  it("adds and removes a signal without duplicating one that is there", async () => {
    const l = await lead({ stage: "CONTACTED", signals: ["hiring"] });
    await rule({
      name: "add",
      triggerConfig: { stage: "CONTACTED" },
      actions: [
        { type: "add_signal", signal: "hiring" },
        { type: "add_signal", signal: "warm" },
        { type: "remove_signal", signal: "hiring" },
      ],
    });

    await fire(l.id);
    const after = await db().lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(after.signals).toEqual(["warm"]);
  });

  it("moves a lead to Not now WITH a wake-up date", async () => {
    const l = await lead({ stage: "CONTACTED" });
    await rule({
      triggerConfig: { stage: "CONTACTED" },
      actions: [{ type: "move_not_now" }],
    });

    await fire(l.id);
    const after = await db().lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(after.stage).toBe("NOT_NOW");
    // Parked, not lost.
    expect(after.wakeUpAt).not.toBeNull();
  });

  it("refuses to notify someone outside the workspace", async () => {
    const l = await lead({ stage: "CONTACTED" });
    await rule({
      triggerConfig: { stage: "CONTACTED" },
      actions: [{ type: "notify_user", userId: "a-stranger", message: "look" }],
    });

    await fire(l.id);
    const run = await db().workflowRun.findFirstOrThrow();
    expect(run.status).toBe("failed");
    expect(run.detail).toMatch(/not in this workspace/);
    expect(await db().notification.count()).toBe(0);
  });
});

describe("matching and the log", () => {
  it("fires only for the configured stage", async () => {
    const l = await lead({ stage: "CONTACTED" });
    await rule({
      triggerConfig: { stage: "REPLIED" },
      actions: [{ type: "add_signal", signal: "x" }],
    });

    expect(await fire(l.id)).toBe(0);
    // A trigger that does not apply is not logged as a considered no-match —
    // otherwise every stage move writes a row for every rule in the workspace.
    expect(await db().workflowRun.count()).toBe(0);
  });

  it("logs a no-match, because 'why did my rule not fire' is the question", async () => {
    const l = await lead({ stage: "CONTACTED", icpScore: 1 });
    await rule({
      triggerConfig: { stage: "CONTACTED" },
      conditions: [{ field: "icpScore", operator: "gte", value: 4 }],
      actions: [{ type: "add_signal", signal: "x" }],
    });

    expect(await fire(l.id)).toBe(0);
    const run = await db().workflowRun.findFirstOrThrow();
    expect(run.status).toBe("no_match");
    expect(run.detail).toMatch(/Conditions did not match/);
  });

  it("stamps the rule VERSION on the run, so an old log is not misread", async () => {
    const l = await lead({ stage: "CONTACTED" });
    const r = await rule({
      triggerConfig: { stage: "CONTACTED" },
      actions: [{ type: "add_signal", signal: "one" }],
    });
    await fire(l.id);

    await prismaUnsafe.workflowRule.update({
      where: { id: r.id },
      data: { actions: [{ type: "add_signal", signal: "two" }], version: { increment: 1 } },
    });
    await fire(l.id);

    const runs = await db().workflowRun.findMany({ orderBy: { at: "asc" } });
    expect(runs.map((x) => x.ruleVersion)).toEqual([1, 2]);
  });

  it("never runs a disabled rule — the kill switch", async () => {
    const l = await lead({ stage: "CONTACTED" });
    await rule({
      enabled: false,
      triggerConfig: { stage: "CONTACTED" },
      actions: [{ type: "add_signal", signal: "x" }],
    });

    expect(await fire(l.id)).toBe(0);
    expect(await db().workflowRun.count()).toBe(0);
  });

  it("never runs another workspace's rules", async () => {
    const l = await lead({ stage: "CONTACTED" });
    await rule({
      workspaceId: wsB,
      triggerConfig: { stage: "CONTACTED" },
      actions: [{ type: "add_signal", signal: "leak" }],
    });

    expect(await fire(l.id)).toBe(0);
    const after = await db().lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(after.signals).toEqual(["hiring"]);
  });
});

describe("cycle protection, end to end", () => {
  it("does not let a rule re-trigger itself through its own action", async () => {
    // The rule moves the lead to Not now, which is a stage change, which is
    // this rule's own trigger.
    const l = await lead({ stage: "CONTACTED" });
    await rule({
      name: "self",
      trigger: "lead_stage_changed",
      actions: [{ type: "move_not_now" }],
    });

    await onLeadStageChanged(wsA, l.id);
    // One run only — the action's own stage change does not loop back in.
    const runs = await db().workflowRun.findMany();
    expect(runs.filter((r) => r.status === "matched")).toHaveLength(1);
  });
});

describe("the overdue sweep", () => {
  it("fires for a task past the configured number of days, and not before", async () => {
    const l = await lead({ stage: "CONTACTED" });
    await rule({
      trigger: "task_overdue",
      triggerConfig: { days: 3 },
      actions: [{ type: "add_signal", signal: "chased" }],
    });

    // One day overdue: below the threshold.
    await db().task.create({
      data: {
        workspaceId: wsA,
        title: "Call back",
        entityType: "lead",
        entityId: l.id,
        dueAt: new Date(Date.now() - 86_400_000),
      },
    });
    await processWorkflowOverdueSweep();
    expect(
      (await db().lead.findUniqueOrThrow({ where: { id: l.id } })).signals,
    ).toEqual(["hiring"]);

    // Five days overdue: fires.
    await db().task.updateMany({
      where: { entityId: l.id },
      data: { dueAt: new Date(Date.now() - 5 * 86_400_000) },
    });
    await processWorkflowOverdueSweep();
    expect(
      (await db().lead.findUniqueOrThrow({ where: { id: l.id } })).signals,
    ).toEqual(["hiring", "chased"]);
  });

  it("ignores a task that is already done", async () => {
    const l = await lead({ stage: "CONTACTED" });
    await rule({
      trigger: "task_overdue",
      triggerConfig: { days: 1 },
      actions: [{ type: "add_signal", signal: "chased" }],
    });
    await db().task.create({
      data: {
        workspaceId: wsA,
        title: "Done already",
        entityType: "lead",
        entityId: l.id,
        dueAt: new Date(Date.now() - 10 * 86_400_000),
        doneAt: new Date(),
      },
    });

    await processWorkflowOverdueSweep();
    expect(await db().workflowRun.count()).toBe(0);
  });
});

/**
 * Board automations against the real database (playbook-v5 P20/5).
 *
 * The verifications the playbook asks for by name are the last two: an
 * automation that would loop is BLOCKED and LOGGED, and the email action still
 * only ever produces a draft. The rest is what each new action actually
 * writes, and the refusals that keep an automation from doing something
 * nobody could have found afterwards.
 */
describe("board automations", () => {
  let boardId = "";
  let doingId = "";
  let blockedId = "";
  let otherBoardId = "";
  let otherSectionId = "";

  beforeEach(async () => {
    const board = await prismaUnsafe.taskBoard.create({
      data: {
        workspaceId: wsA,
        name: "Delivery",
        sections: {
          create: [
            { workspaceId: wsA, name: "Doing", position: 1024 },
            { workspaceId: wsA, name: "Blocked", position: 2048 },
          ],
        },
      },
      include: { sections: { orderBy: { position: "asc" } } },
    });
    boardId = board.id;
    doingId = board.sections[0]!.id;
    blockedId = board.sections[1]!.id;

    const other = await prismaUnsafe.taskBoard.create({
      data: {
        workspaceId: wsA,
        name: "Somewhere else",
        sections: { create: [{ workspaceId: wsA, name: "Inbox", position: 1024 }] },
      },
      include: { sections: true },
    });
    otherBoardId = other.id;
    otherSectionId = other.sections[0]!.id;
  });

  async function task(over: Record<string, unknown> = {}) {
    return prismaUnsafe.task.create({
      data: { workspaceId: wsA, boardId, sectionId: doingId, title: "A task", ...over },
    });
  }

  async function fireTask(taskId: string, trigger: string) {
    const { fireTaskTrigger } = await import("../../src/modules/workflow/triggers");
    return fireTaskTrigger(wsA, trigger as never, taskId);
  }

  it("sets a priority on the task that fired the rule", async () => {
    const t = await task();
    await rule({
      trigger: "task_created",
      boardId,
      actions: [{ type: "set_priority", priority: "urgent" }],
    });

    await fireTask(t.id, "task_created");
    expect((await db().task.findUniqueOrThrow({ where: { id: t.id } })).priority).toBe("urgent");
  });

  it("only listens to its own board", async () => {
    const elsewhere = await task({ boardId: otherBoardId, sectionId: otherSectionId });
    await rule({
      trigger: "task_created",
      boardId,
      actions: [{ type: "set_priority", priority: "urgent" }],
    });

    await fireTask(elsewhere.id, "task_created");
    expect((await db().task.findUniqueOrThrow({ where: { id: elsewhere.id } })).priority).toBe(
      "none",
    );
    // And it is not in the log either: the rule was never listening, which is
    // not the same as considering the event and declining it.
    expect(await db().workflowRun.count()).toBe(0);
  });

  it("a workspace-wide task rule watches every board", async () => {
    const elsewhere = await task({ boardId: otherBoardId, sectionId: otherSectionId });
    await rule({
      trigger: "task_created",
      actions: [{ type: "add_tag", tag: "seen" }],
    });

    await fireTask(elsewhere.id, "task_created");
    expect((await db().task.findUniqueOrThrow({ where: { id: elsewhere.id } })).tags).toEqual([
      "seen",
    ]);
  });

  it("fires on the section a task lands in, and not on the others", async () => {
    const t = await task({ sectionId: blockedId });
    await rule({
      trigger: "task_moved",
      boardId,
      triggerConfig: { section: blockedId },
      actions: [{ type: "set_priority", priority: "high" }],
    });

    await fireTask(t.id, "task_moved");
    expect((await db().task.findUniqueOrThrow({ where: { id: t.id } })).priority).toBe("high");

    // The same rule, a task in the other column: nothing.
    const inDoing = await task({ sectionId: doingId, title: "Elsewhere on the board" });
    await fireTask(inDoing.id, "task_moved");
    expect((await db().task.findUniqueOrThrow({ where: { id: inDoing.id } })).priority).toBe(
      "none",
    );
  });

  it("sets a due date by offset, at the end of the working day", async () => {
    const t = await task();
    await rule({
      trigger: "task_created",
      boardId,
      actions: [{ type: "set_due_date", dueInDays: 2 }],
    });

    await fireTask(t.id, "task_created");
    const due = (await db().task.findUniqueOrThrow({ where: { id: t.id } })).dueAt!;
    const expected = new Date();
    expected.setDate(expected.getDate() + 2);
    expect(due.toISOString().slice(0, 10)).toBe(
      `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, "0")}-${String(
        expected.getDate(),
      ).padStart(2, "0")}`,
    );
    expect(due.getHours()).toBe(17);
  });

  it("assigns to a member of this workspace and refuses anybody else", async () => {
    await prismaUnsafe.user.upsert({
      where: { id: USER },
      update: {},
      create: { id: USER, email: `${USER}@example.test`, name: "WF User", passwordHash: "x" },
    });
    await prismaUnsafe.membership.upsert({
      where: { userId_workspaceId: { userId: USER, workspaceId: wsA } },
      update: {},
      create: { userId: USER, workspaceId: wsA, role: "OWNER" },
    });

    const t = await task();
    await rule({
      name: "assign ok",
      trigger: "task_created",
      boardId,
      actions: [{ type: "assign_task", assigneeId: USER }],
    });
    await fireTask(t.id, "task_created");
    expect((await db().task.findUniqueOrThrow({ where: { id: t.id } })).assigneeId).toBe(USER);

    const t2 = await task({ title: "Second" });
    await prismaUnsafe.workflowRule.deleteMany({ where: { workspaceId: wsA } });
    await rule({
      name: "assign stranger",
      trigger: "task_created",
      boardId,
      actions: [{ type: "assign_task", assigneeId: "not-a-member" }],
    });
    await fireTask(t2.id, "task_created");
    expect((await db().task.findUniqueOrThrow({ where: { id: t2.id } })).assigneeId).toBeNull();
    const failed = await db().workflowRun.findFirst({ where: { status: "failed" } });
    expect(failed?.detail).toMatch(/not in this workspace/i);
  });

  it("will not move a task off its own board", async () => {
    const t = await task();
    await rule({
      trigger: "task_created",
      boardId,
      actions: [{ type: "move_to_section", sectionId: otherSectionId }],
    });

    await fireTask(t.id, "task_created");
    const after = await db().task.findUniqueOrThrow({ where: { id: t.id } });
    // "The automation moved it and I cannot find it" is the worst thing an
    // automation can do.
    expect(after.boardId).toBe(boardId);
    expect(after.sectionId).toBe(doingId);
    const run = await db().workflowRun.findFirst({ where: { status: "failed" } });
    expect(run?.detail).toMatch(/another board/i);
  });

  it("adds and removes tags without disturbing the others", async () => {
    const t = await task({ tags: ["design", "blocked"] });
    await rule({
      trigger: "task_created",
      boardId,
      actions: [
        { type: "remove_tag", tag: "blocked" },
        { type: "add_tag", tag: "ready" },
      ],
    });

    await fireTask(t.id, "task_created");
    expect((await db().task.findUniqueOrThrow({ where: { id: t.id } })).tags).toEqual([
      "design",
      "ready",
    ]);
  });

  it("copies a follow-up off a template board, with the template's own offset", async () => {
    const template = await prismaUnsafe.taskBoard.create({
      data: {
        workspaceId: wsA,
        name: "Onboarding template",
        isTemplate: true,
        tasks: {
          create: [
            {
              workspaceId: wsA,
              title: "Send the welcome pack",
              priority: "high",
              dueOffsetDays: 3,
            },
          ],
        },
      },
      include: { tasks: true },
    });

    const t = await task();
    await rule({
      trigger: "task_completed",
      boardId,
      actions: [{ type: "create_follow_up", templateTaskId: template.tasks[0]!.id }],
    });

    await fireTask(t.id, "task_completed");
    const created = await db().task.findFirst({
      where: { title: "Send the welcome pack", boardId },
    });
    expect(created, "the follow-up was not created beside the task that caused it").toBeTruthy();
    expect(created!.priority).toBe("high");
    expect(created!.sectionId).toBe(doingId);
    expect(created!.source).toBe("workflow");
    const days = Math.round((created!.dueAt!.getTime() - Date.now()) / 86_400_000);
    expect(days).toBe(3);
  });

  it("refuses a follow-up from a task that is not on a template board", async () => {
    const ordinary = await task({ title: "Not a template" });
    const t = await task({ title: "Trigger" });
    await rule({
      trigger: "task_completed",
      boardId,
      actions: [{ type: "create_follow_up", templateTaskId: ordinary.id }],
    });

    await fireTask(t.id, "task_completed");
    const run = await db().workflowRun.findFirst({ where: { status: "failed" } });
    expect(run?.detail).toMatch(/not on a template board/i);
  });

  it("refuses a task action when the trigger carries no task", async () => {
    const l = await lead({ stage: "CONTACTED" });
    // A rule saved before the validation existed, or by hand: it must fail
    // with a sentence rather than a stack trace.
    await rule({
      trigger: "lead_stage_changed",
      actions: [{ type: "set_priority", priority: "urgent" }],
    });

    await fire(l.id);
    const run = await db().workflowRun.findFirst({ where: { status: "failed" } });
    expect(run?.detail).toMatch(/carries no task/i);
  });

  it("matches a condition on the task's own tags", async () => {
    const blocked = await task({ tags: ["blocked"] });
    const clear = await task({ title: "Clear", tags: [] });
    await rule({
      trigger: "task_created",
      boardId,
      conditions: [{ field: "tags", operator: "has_tag", value: "blocked" }],
      actions: [{ type: "set_priority", priority: "urgent" }],
    });

    await fireTask(blocked.id, "task_created");
    await fireTask(clear.id, "task_created");
    expect((await db().task.findUniqueOrThrow({ where: { id: blocked.id } })).priority).toBe(
      "urgent",
    );
    expect((await db().task.findUniqueOrThrow({ where: { id: clear.id } })).priority).toBe("none");
  });

  it("an automation that would loop is blocked by cycle protection and logged", async () => {
    /**
     * The rule sets a priority, and its own trigger IS a priority change. The
     * action really does wake the engine again — that is what makes this a
     * loop rather than a hypothetical — and the guard refuses the second
     * visit and writes down why.
     */
    const t = await task({ priority: "none" });
    await rule({
      name: "loop",
      trigger: "task_priority_changed",
      boardId,
      actions: [{ type: "set_priority", priority: "urgent" }],
    });

    await fireTask(t.id, "task_priority_changed");

    const runs = await db().workflowRun.findMany({ orderBy: { at: "asc" } });
    expect(runs.filter((r) => r.status === "matched")).toHaveLength(1);
    const skipped = runs.find((r) => r.status === "skipped");
    expect(skipped, "the loop was not written to the log").toBeTruthy();
    expect(skipped!.detail).toMatch(/cannot re-trigger itself/i);
    expect(skipped!.depth).toBe(1);

    // And it settled: one write, not an ever-growing pile.
    expect((await db().task.findUniqueOrThrow({ where: { id: t.id } })).priority).toBe("urgent");
  });

  it("does not wake the engine when the action changes nothing", async () => {
    const t = await task({ priority: "urgent" });
    await rule({
      trigger: "task_priority_changed",
      boardId,
      actions: [{ type: "set_priority", priority: "urgent" }],
    });

    await fireTask(t.id, "task_priority_changed");
    // Matched once, and no follow-on fire at all — re-setting a value to what
    // it already was is not a change.
    const runs = await db().workflowRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("matched");
  });

  it("an email action on a task rule still only drafts (CLAUDE.md hard rule #2)", async () => {
    const l = await lead({ stage: "CONTACTED" });
    const t = await task({ entityType: "lead", entityId: l.id });
    await rule({
      trigger: "task_completed",
      boardId,
      actions: [{ type: "draft_email", subject: "Thanks", body: "All done." }],
    });

    await fireTask(t.id, "task_completed");
    const messages = await db().message.findMany({ where: { leadId: l.id } });
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe("DRAFT");
    expect(messages[0].aiDrafted).toBe(false);
  });

  it("notifies a team, and says so when the team is empty", async () => {
    const team = await prismaUnsafe.team.create({
      data: { workspaceId: wsA, name: "Delivery team" },
    });
    const t = await task();
    await rule({
      name: "empty team",
      trigger: "task_created",
      boardId,
      actions: [{ type: "notify_team", teamId: team.id, message: "Something happened" }],
    });

    await fireTask(t.id, "task_created");
    let run = await db().workflowRun.findFirst({ where: { status: "failed" } });
    expect(run?.detail).toMatch(/has nobody on it/i);

    await prismaUnsafe.teamMember.create({
      data: { workspaceId: wsA, teamId: team.id, userId: USER },
    });
    await prismaUnsafe.workflowRun.deleteMany({ where: { workspaceId: wsA } });
    const t2 = await task({ title: "Second" });
    await fireTask(t2.id, "task_created");
    run = await db().workflowRun.findFirst({ where: { status: "matched" } });
    expect(run?.detail).toMatch(/Notified 1 on Delivery team/);
  });

  it("carries the task through the overdue sweep so a board action can act on it", async () => {
    const t = await task({ dueAt: new Date(Date.now() - 5 * 86_400_000) });
    await rule({
      trigger: "task_overdue",
      triggerConfig: { days: 3 },
      boardId,
      actions: [{ type: "add_tag", tag: "late" }],
    });

    await processWorkflowOverdueSweep();
    expect((await db().task.findUniqueOrThrow({ where: { id: t.id } })).tags).toEqual(["late"]);
  });
});
