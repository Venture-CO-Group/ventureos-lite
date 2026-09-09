import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import {
  addTaskLink,
  entityTaskPanel,
  linksForTask,
  openTaskCounts,
  removeTaskLink,
  taskIdsForEntity,
  RECENT_DONE_LIMIT,
} from "../../src/modules/tasks/entity-tasks";

/**
 * A task that belongs to more than one entity (playbook-v5 P20/4).
 *
 * The guarantee the playbook asks for by name is at the top: a task linked to
 * two entities appears in BOTH panels, and the single-entity fast path — the
 * `tasks.entity_type` columns twenty callers already write — still works
 * untouched. Everything else here is the ways that can go subtly wrong: a task
 * counted twice because it reaches one entity through both routes, a project's
 * milestones listed a second time under their own checklist, a link row left
 * behind when its task is deleted.
 */
const WS = "Links WS";
let workspaceId = "";
let boardId = "";
let companyId = "";
let dealId = "";
let leadId = "";
const userId = "links-user";

beforeAll(async () => {
  const ws =
    (await prismaUnsafe.workspace.findFirst({ where: { name: WS } })) ??
    (await prismaUnsafe.workspace.create({ data: { name: WS } }));
  workspaceId = ws.id;
  await cleanup();

  const board = await prismaUnsafe.taskBoard.create({
    data: { workspaceId, name: "Links board" },
  });
  boardId = board.id;

  const company = await prismaUnsafe.company.create({
    data: { workspaceId, name: "Acme Kft" },
  });
  companyId = company.id;
  const lead = await prismaUnsafe.lead.create({
    data: { workspaceId, companyId, contactName: "Kis Béla" },
  });
  leadId = lead.id;

  const pipeline = await prismaUnsafe.pipeline.create({
    data: {
      workspaceId,
      name: "Links pipeline",
      key: "links-pipeline",
      stages: {
        create: [{ workspaceId, name: "New", key: "new", position: 0, probability: 10 }],
      },
    },
    include: { stages: true },
  });
  const deal = await prismaUnsafe.deal.create({
    data: {
      workspaceId,
      title: "Acme website",
      value: 1_000_000,
      companyId,
      leadId,
      pipelineId: pipeline.id,
      stageId: pipeline.stages[0]!.id,
    },
  });
  dealId = deal.id;
});

async function cleanup() {
  await prismaUnsafe.taskLink.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.milestone.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.project.deleteMany({ where: { workspaceId } });
}

beforeEach(async () => {
  await prismaUnsafe.taskLink.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.milestone.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.project.deleteMany({ where: { workspaceId } });
});

afterAll(async () => {
  await cleanup();
  await prismaUnsafe.deal.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.dealStage.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.pipeline.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.company.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskBoard.deleteMany({ where: { workspaceId } });
});

function task(data: Record<string, unknown> = {}) {
  return prismaUnsafe.task.create({
    data: { workspaceId, boardId, title: "A task", ...data },
  });
}

describe("the verification the playbook names", () => {
  it("a task linked to two entities appears in both panels, and the fast path still works", async () => {
    // Mainly about the deal, in the columns — the fast path, untouched.
    const t = await task({ title: "Kickoff call", entityType: "deal", entityId: dealId });
    expect(await addTaskLink(workspaceId, t.id, "company", companyId, userId)).toEqual({
      ok: true,
    });

    const onDeal = await entityTaskPanel(workspaceId, "deal", dealId);
    const onCompany = await entityTaskPanel(workspaceId, "company", companyId);

    expect(onDeal.open.map((r) => r.id)).toEqual([t.id]);
    expect(onCompany.open.map((r) => r.id)).toEqual([t.id]);

    // And each panel says HOW the task got there, because a task mainly about
    // the deal showing under the company should read as exactly that.
    expect(onDeal.open[0].primary, "the fast path stopped being primary").toBe(true);
    expect(onCompany.open[0].primary, "a linked task claimed to be primary").toBe(false);

    // The columns are what they always were: nothing was migrated away.
    const row = await prismaUnsafe.task.findUnique({ where: { id: t.id } });
    expect(row).toMatchObject({ entityType: "deal", entityId: dealId });
  });
});

describe("the union", () => {
  it("counts a task reachable both ways once, not twice", async () => {
    const t = await task({ entityType: "company", entityId: companyId });
    // Somebody links it to the company it is already about. Refused — but
    // force the row in anyway, because a hand-written row or an older release
    // could have made one and the reader must survive it.
    await prismaUnsafe.taskLink.create({
      data: { workspaceId, taskId: t.id, entityType: "company", entityId: companyId },
    });

    const { ids } = await taskIdsForEntity(workspaceId, "company", companyId);
    expect(ids).toEqual([t.id]);

    const panel = await entityTaskPanel(workspaceId, "company", companyId);
    expect(panel.open).toHaveLength(1);
    expect(panel.openCount).toBe(1);

    const counts = await openTaskCounts(workspaceId, "company", [companyId]);
    expect(counts.get(companyId), "the same task was counted twice").toBe(1);
  });

  it("counts only the open ones on the badge", async () => {
    await task({ entityType: "company", entityId: companyId });
    const done = await task({
      entityType: "deal",
      entityId: dealId,
      doneAt: new Date(),
    });
    await addTaskLink(workspaceId, done.id, "company", companyId, userId);

    const counts = await openTaskCounts(workspaceId, "company", [companyId]);
    expect(counts.get(companyId), "a completed linked task inflated the badge").toBe(1);
  });

  it("returns nothing for an entity nobody has worked on", async () => {
    const panel = await entityTaskPanel(workspaceId, "lead", leadId);
    expect(panel).toEqual({ open: [], recentlyDone: [], openCount: 0, doneCount: 0 });
    expect((await openTaskCounts(workspaceId, "lead", [leadId])).get(leadId)).toBeUndefined();
    expect((await openTaskCounts(workspaceId, "lead", [])).size).toBe(0);
  });
});

describe("what the panel shows", () => {
  it("puts dated work before undated work", async () => {
    const later = await task({ title: "Later", entityType: "lead", entityId: leadId, dueAt: new Date(2026, 9, 1) });
    const undated = await task({ title: "Someday", entityType: "lead", entityId: leadId });
    const sooner = await task({ title: "Sooner", entityType: "lead", entityId: leadId, dueAt: new Date(2026, 8, 20) });

    const panel = await entityTaskPanel(workspaceId, "lead", leadId);
    // A task with a date is a commitment; one without is an intention.
    expect(panel.open.map((r) => r.id)).toEqual([sooner.id, later.id, undated.id]);
  });

  it("shows the last few completions and says how many it is not showing", async () => {
    for (let i = 0; i < RECENT_DONE_LIMIT + 3; i += 1) {
      await task({
        title: `Done ${i}`,
        entityType: "lead",
        entityId: leadId,
        doneAt: new Date(Date.now() - i * 60_000),
      });
    }
    const panel = await entityTaskPanel(workspaceId, "lead", leadId);
    expect(panel.recentlyDone).toHaveLength(RECENT_DONE_LIMIT);
    expect(panel.doneCount).toBe(RECENT_DONE_LIMIT + 3);
    // Newest first, so the evidence on top is the most recent.
    expect(panel.recentlyDone[0].title).toBe("Done 0");
  });

  it("leaves out a completion from long ago", async () => {
    await task({
      entityType: "lead",
      entityId: leadId,
      doneAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
    });
    const panel = await entityTaskPanel(workspaceId, "lead", leadId);
    expect(panel.recentlyDone).toHaveLength(0);
    // But the total still counts it: the number has to be honest about what
    // is not shown.
    expect(panel.doneCount).toBe(1);
  });

  it("leaves a project's milestones to the project's own checklist", async () => {
    const project = await prismaUnsafe.project.create({
      data: { workspaceId, dealId, companyId, name: "Acme delivery", startedAt: new Date() },
    });
    const milestoneTask = await task({
      title: "Kickoff",
      entityType: "project",
      entityId: project.id,
    });
    await prismaUnsafe.milestone.create({
      data: { workspaceId, projectId: project.id, taskId: milestoneTask.id, position: 0, kind: "kickoff" },
    });
    const adHoc = await task({
      title: "Chase the logo files",
      entityType: "project",
      entityId: project.id,
    });

    const panel = await entityTaskPanel(workspaceId, "project", project.id);
    expect(
      panel.open.map((r) => r.id),
      "the milestone was listed twice — once as the checklist, once in the panel",
    ).toEqual([adHoc.id]);
  });
});

describe("adding and removing links", () => {
  it("refuses the entity the task is already about", async () => {
    const t = await task({ entityType: "deal", entityId: dealId });
    const res = await addTaskLink(workspaceId, t.id, "deal", dealId, userId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already about/i);
    expect(await prismaUnsafe.taskLink.count({ where: { taskId: t.id } })).toBe(0);
  });

  it("refuses the same link twice", async () => {
    const t = await task({ entityType: "deal", entityId: dealId });
    expect(await addTaskLink(workspaceId, t.id, "company", companyId, userId)).toEqual({
      ok: true,
    });
    const again = await addTaskLink(workspaceId, t.id, "company", companyId, userId);
    expect(again.ok).toBe(false);
    expect(await prismaUnsafe.taskLink.count({ where: { taskId: t.id } })).toBe(1);
  });

  it("refuses a link on a task that does not exist", async () => {
    const res = await addTaskLink(workspaceId, "no-such-task", "company", companyId, userId);
    expect(res).toMatchObject({ ok: false });
  });

  it("removes an extra link and lists what is left", async () => {
    const t = await task({ entityType: "deal", entityId: dealId });
    await addTaskLink(workspaceId, t.id, "company", companyId, userId);
    await addTaskLink(workspaceId, t.id, "lead", leadId, userId);

    expect(await linksForTask(workspaceId, t.id)).toEqual([
      { kind: "company", id: companyId },
      { kind: "lead", id: leadId },
    ]);

    expect(await removeTaskLink(workspaceId, t.id, "company", companyId)).toEqual({ ok: true });
    expect(await linksForTask(workspaceId, t.id)).toEqual([{ kind: "lead", id: leadId }]);
  });

  it("will not unlink the task's own entity, and says why", async () => {
    const t = await task({ entityType: "deal", entityId: dealId });
    const res = await removeTaskLink(workspaceId, t.id, "deal", dealId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/on the task itself/i);
    // And the fast path is untouched by the refusal.
    const row = await prismaUnsafe.task.findUnique({ where: { id: t.id } });
    expect(row).toMatchObject({ entityType: "deal", entityId: dealId });
  });

  it("takes the links with the task when the task goes", async () => {
    const t = await task({ entityType: "deal", entityId: dealId });
    await addTaskLink(workspaceId, t.id, "company", companyId, userId);
    await prismaUnsafe.task.delete({ where: { id: t.id } });
    expect(
      await prismaUnsafe.taskLink.count({ where: { taskId: t.id } }),
      "a link row outlived its task and would haunt the company's panel",
    ).toBe(0);
  });
});
