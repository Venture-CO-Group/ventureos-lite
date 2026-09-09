import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RUN = String(Date.now());
let workspaceId = "";
let boardId = "";
let companyId = "";
let leadId = "";
let dealId = "";
let pipelineId = "";
let spanningTaskId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;

  companyId = (
    await prisma.company.create({ data: { workspaceId, name: `E2E Links Co ${RUN}` } })
  ).id;
  leadId = (
    await prisma.lead.create({
      data: { workspaceId, companyId, contactName: `E2E Links Contact ${RUN}` },
    })
  ).id;

  const pipeline = await prisma.pipeline.create({
    data: {
      workspaceId,
      name: `E2E Links Pipeline ${RUN}`,
      key: `e2e-links-${RUN}`,
      stages: {
        create: [{ workspaceId, name: "New", key: `new-${RUN}`, position: 0, probability: 10 }],
      },
    },
    include: { stages: true },
  });
  pipelineId = pipeline.id;
  dealId = (
    await prisma.deal.create({
      data: {
        workspaceId,
        title: `E2E Links Deal ${RUN}`,
        value: 750_000,
        companyId,
        leadId,
        pipelineId,
        stageId: pipeline.stages[0]!.id,
      },
    })
  ).id;

  boardId = (await prisma.taskBoard.create({ data: { workspaceId, name: `E2E Links Board ${RUN}` } }))
    .id;

  /**
   * The case the playbook asks for: mainly about the deal, in the task's own
   * columns, and ALSO linked to the company it belongs to.
   */
  spanningTaskId = (
    await prisma.task.create({
      data: {
        workspaceId,
        boardId,
        title: `Spanning task ${RUN}`,
        entityType: "deal",
        entityId: dealId,
      },
    })
  ).id;
  await prisma.taskLink.create({
    data: { workspaceId, taskId: spanningTaskId, entityType: "company", entityId: companyId },
  });
});

test.afterAll(async () => {
  await prisma.taskLink.deleteMany({ where: { workspaceId, entityId: { in: [companyId, leadId, dealId] } } });
  await prisma.task.deleteMany({ where: { boardId } });
  await prisma.task.deleteMany({ where: { workspaceId, entityId: { in: [leadId, companyId, dealId] } } });
  await prisma.taskBoard.deleteMany({ where: { id: boardId } });
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.dealStage.deleteMany({ where: { pipelineId } });
  await prisma.pipeline.deleteMany({ where: { id: pipelineId } });
  await prisma.lead.deleteMany({ where: { id: leadId } });
  await prisma.company.deleteMany({ where: { id: companyId } });
  await prisma.$disconnect();
});

/**
 * The reverse direction (playbook-v5 P20/4).
 *
 * Tasks always knew which lead they were about; the lead did not know what was
 * open on it. These drive the panel that closes that gap, the drawer the
 * company and the deal never had, and the one link that spans both.
 */
test("a lead's panel takes a new task, pre-linked, and ticks it", async ({ page }) => {
  await page.goto(`/leads?lead=${leadId}`);
  const panel = page.getByTestId("entity-tasks");
  await expect(panel).toBeVisible({ timeout: 20_000 });

  const title = `Call them back ${RUN}`;
  await page.getByTestId("entity-task-input").fill(title);
  await page.getByTestId("entity-task-input").press("Enter");
  await expect(panel.getByTestId("entity-task-row").filter({ hasText: title })).toBeVisible({
    timeout: 20_000,
  });

  // It was created pre-linked to this lead, with no entity picker in the way.
  const created = await prisma.task.findFirst({ where: { workspaceId, title } });
  expect(created).toMatchObject({ entityType: "lead", entityId: leadId });
  // And loose, because guessing a board for it would be a guess.
  expect(created!.boardId).toBeNull();

  // The header badge counts it.
  await expect(page.getByTestId("entity-header-task-badge")).toContainText("1");

  await panel
    .getByTestId("entity-task-row")
    .filter({ hasText: title })
    .getByTestId("entity-task-toggle")
    .check();

  await expect
    .poll(
      async () => (await prisma.task.findUnique({ where: { id: created!.id } }))!.doneAt !== null,
      { timeout: 20_000 },
    )
    .toBe(true);
});

test("the company had no surface before, and now opens from the address bar", async ({ page }) => {
  await page.goto(`/leads?company=${companyId}`);
  const drawer = page.getByTestId("entity-drawer");
  await expect(drawer).toBeVisible({ timeout: 20_000 });
  await expect(drawer.getByTestId("entity-drawer-title")).toContainText("e2e links co");

  // The spanning task is here through the LINK table, and says so.
  const row = drawer.getByTestId("entity-task-row").filter({ hasText: "Spanning task" });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("entity-task-linked")).toBeVisible();
});

test("the same task is on the deal too, as its own", async ({ page }) => {
  await page.goto(`/deals?deal=${dealId}`);
  const drawer = page.getByTestId("entity-drawer");
  await expect(drawer).toBeVisible({ timeout: 20_000 });

  const row = drawer.getByTestId("entity-task-row").filter({ hasText: "Spanning task" });
  await expect(row).toBeVisible();
  // On the deal it is the task's own entity, so no "linked" marker.
  await expect(row.getByTestId("entity-task-linked")).toHaveCount(0);
});

test("following a task out of an entity offers the way back", async ({ page }) => {
  await page.goto(`/deals?deal=${dealId}`);
  const drawer = page.getByTestId("entity-drawer");
  await expect(drawer).toBeVisible({ timeout: 20_000 });

  await drawer
    .getByTestId("entity-task-row")
    .filter({ hasText: "Spanning task" })
    .getByTestId("entity-task-open")
    .click();

  await expect(page.getByTestId("detail-title")).toBeVisible({ timeout: 20_000 });
  const back = page.getByTestId("task-detail-back");
  await expect(back).toBeVisible();

  // And it lands back on the deal, with the deal open.
  await back.click();
  await expect(page.getByTestId("entity-drawer")).toBeVisible({ timeout: 20_000 });
  expect(page.url()).toContain(`deal=${dealId}`);
});

test("a second entity can be added and removed from the task itself", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&task=${spanningTaskId}`);
  const links = page.getByTestId("task-links");
  await expect(links).toBeVisible({ timeout: 20_000 });
  await expect(links.getByTestId("task-link")).toHaveCount(1);

  await links.getByTestId("task-link-add").click();
  await links.getByTestId("task-link-kind").selectOption("lead");
  await links.getByTestId("task-link-search").fill(`E2E Links Contact ${RUN}`);
  await links.getByTestId("task-link-hit").first().click();

  await expect(links.getByTestId("task-link")).toHaveCount(2);
  expect(
    await prisma.taskLink.count({
      where: { taskId: spanningTaskId, entityType: "lead", entityId: leadId },
    }),
  ).toBe(1);

  // Removing one leaves the other, and never touches the task's own entity.
  await links.getByTestId("task-link").filter({ hasText: "lead:" }).getByTestId("task-link-remove").click();
  await expect(links.getByTestId("task-link")).toHaveCount(1);
  const task = await prisma.task.findUnique({ where: { id: spanningTaskId } });
  expect(task).toMatchObject({ entityType: "deal", entityId: dealId });
});
