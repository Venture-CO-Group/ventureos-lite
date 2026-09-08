import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BOARD = "E2E Dash Board";
const TEMPLATE = "E2E Dash Template";
let workspaceId = "";
let boardId = "";
let templateId = "";
let runnerId = "";

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  const runner = await prisma.user.findUniqueOrThrow({
    where: { email: "e2e-runner@ventureco.test" },
  });
  runnerId = runner.id;
  await cleanup();

  const board = await prisma.taskBoard.create({
    data: {
      workspaceId,
      name: BOARD,
      sections: { create: [{ workspaceId, name: "To do", position: 1024 }] },
    },
  });
  boardId = board.id;
  const tpl = await prisma.taskBoard.create({
    data: { workspaceId, name: TEMPLATE, isTemplate: true },
  });
  templateId = tpl.id;
});

async function cleanup() {
  const boards = await prisma.taskBoard.findMany({
    where: { name: { in: [BOARD, TEMPLATE] } },
  });
  for (const b of boards) {
    await prisma.taskDependency.deleteMany({ where: { task: { boardId: b.id } } });
    await prisma.task.deleteMany({ where: { boardId: b.id } });
    await prisma.taskSection.deleteMany({ where: { boardId: b.id } });
    await prisma.taskBoard.delete({ where: { id: b.id } });
  }
}

test.afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

/**
 * The dashboard's list and the task board are the same work (P8/4).
 *
 * They were built separately, read the same table, and never mentioned each
 * other — so the dashboard showed tasks with no route to their board, said
 * nothing about what was blocked, and put every TEMPLATE board's tasks on
 * everybody's screen.
 */
test("a template's tasks stay off the dashboard", async ({ page }) => {
  const tpl = await prisma.task.create({
    data: { workspaceId, boardId: templateId, title: "Template kick-off call", position: 1 },
  });
  const real = await prisma.task.create({
    data: {
      workspaceId,
      boardId,
      title: "Real dashboard task",
      position: 2,
      assigneeId: runnerId,
      dueAt: new Date(Date.now() + 3_600_000),
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("tasks-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("tasks-panel")).toContainText("Real dashboard task");
  /**
   * The leak. A template's tasks are unassigned by design, so the
   * `assigneeId: null` branch put them on every single person's dashboard.
   */
  await expect(page.getByTestId("tasks-panel")).not.toContainText("Template kick-off call");

  await prisma.task.deleteMany({ where: { id: { in: [tpl.id, real.id] } } });
});

test("a dashboard task links to its card on the board, and the card opens", async ({ page }) => {
  const task = await prisma.task.create({
    data: {
      workspaceId,
      boardId,
      title: "Openable from the dashboard",
      position: 3,
      assigneeId: runnerId,
      dueAt: new Date(Date.now() + 3_600_000),
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("tasks-panel")).toBeVisible({ timeout: 30_000 });
  // The board is named on the row, which it never was.
  const link = page.getByTestId(`task-board-link-${task.id}`);
  await expect(link).toContainText(BOARD);
  await link.click();

  /**
   * `?task=` was already the link the notification system produced, and the
   * page ignored it — so every "somebody put a task on you" notification
   * landed on a board and left the person to find the card.
   */
  await expect(page).toHaveURL(new RegExp(`board=${boardId}&task=${task.id}`), {
    timeout: 30_000,
  });
  await expect(page.getByTestId("detail-title")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("detail-title")).toHaveValue("Openable from the dashboard");

  await prisma.task.delete({ where: { id: task.id } });
});

test("the dashboard says when a task is waiting on something", async ({ page }) => {
  const blocker = await prisma.task.create({
    data: { workspaceId, boardId, title: "Await the signature", position: 4 },
  });
  const blocked = await prisma.task.create({
    data: {
      workspaceId,
      boardId,
      title: "Blocked on the dashboard",
      position: 5,
      assigneeId: runnerId,
      dueAt: new Date(Date.now() + 3_600_000),
    },
  });
  await prisma.taskDependency.create({
    data: { workspaceId, taskId: blocked.id, blockedById: blocker.id },
  });

  await page.goto("/");
  await expect(page.getByTestId("tasks-panel")).toBeVisible({ timeout: 30_000 });
  // The board knew this and the dashboard did not, so a blocked task sat at
  // the top of the morning list looking like the next thing to pick up.
  await expect(page.getByTestId(`task-blocked-${blocked.id}`)).toContainText("waiting on 1");

  // Finishing the blocker clears it.
  await prisma.task.update({ where: { id: blocker.id }, data: { doneAt: new Date() } });
  await page.reload();
  await expect(page.getByTestId(`task-blocked-${blocked.id}`)).toHaveCount(0);

  await prisma.taskDependency.deleteMany({ where: { taskId: blocked.id } });
  await prisma.task.deleteMany({ where: { id: { in: [blocker.id, blocked.id] } } });
});

test("the dashboard offers a way through to the boards", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("tasks-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("tasks-panel-boards").click();
  await expect(page).toHaveURL(/\/tasks$/, { timeout: 30_000 });
});

test("the dashboard does not overflow, and the greeting spans it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("tasks-panel")).toBeVisible({ timeout: 30_000 });
  /**
   * The layout bug: the greeting, the task panel and the insight column were
   * three children of a two-column grid, so the third wrapped into row two and
   * left a hole beside it.
   */
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(narrow).toBeLessThanOrEqual(0);
});
