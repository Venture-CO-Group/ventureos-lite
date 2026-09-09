import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RUN = String(Date.now());
const BOARD = `E2E Checklist Board ${RUN}`;
let workspaceId = "";
let boardId = "";
let sectionId = "";
let taskId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  const board = await prisma.taskBoard.create({
    data: {
      workspaceId,
      name: BOARD,
      sections: { create: [{ workspaceId, name: "Doing", position: 1024 }] },
    },
    include: { sections: true },
  });
  boardId = board.id;
  sectionId = board.sections[0]!.id;
  taskId = (
    await prisma.task.create({
      data: { workspaceId, boardId, sectionId, title: `Checklist task ${RUN}`, position: 1024 },
    })
  ).id;
});

test.afterAll(async () => {
  await prisma.taskChecklistItem.deleteMany({ where: { taskId } });
  await prisma.task.deleteMany({ where: { boardId } });
  await prisma.taskSection.deleteMany({ where: { boardId } });
  await prisma.taskBoard.deleteMany({ where: { id: boardId } });
  await prisma.$disconnect();
});

/**
 * Lightweight checklists (playbook-v5 P20/3).
 *
 * Three things are worth driving through a browser: the steps go in and the
 * count reaches the card, ticking them all does NOT close the task, and one
 * click turns a step into a real subtask.
 */
test("steps go in, and the count reaches the card as 1/3", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&task=${taskId}`);
  const list = page.getByTestId("task-checklist");
  await expect(list).toBeVisible({ timeout: 20_000 });

  // The sentence that tells someone which of the two tools they want.
  await expect(list).toContainText(/subtask for work someone else may own/i);

  for (const step of ["Draft the copy", "Get it read", "Publish"]) {
    await page.getByTestId("checklist-input").fill(step);
    await page.getByTestId("checklist-input").press("Enter");
    await expect(list).toContainText(step);
  }

  await list.getByTestId("checklist-tick").first().check();
  await expect(list.getByTestId("checklist-progress")).toHaveText("1/3");

  await page.goto(`/tasks?board=${boardId}`);
  const card = page.locator(`[data-task-id="${taskId}"]`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByTestId("checklist-count")).toHaveText("▤ 1/3");
});

test("ticking every step does not complete the task", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&task=${taskId}`);
  const list = page.getByTestId("task-checklist");
  await expect(list).toBeVisible({ timeout: 20_000 });

  const ticks = list.getByTestId("checklist-tick");
  // The panel loads its steps after mounting, so wait for them rather than
  // counting an empty list and asserting "0/0".
  await expect(ticks.first()).toBeVisible({ timeout: 20_000 });
  const count = await ticks.count();
  expect(count).toBe(3);
  for (let i = 0; i < count; i += 1) await ticks.nth(i).check();
  await expect(list.getByTestId("checklist-progress")).toHaveText(`${count}/${count}`);

  // The task is untouched — the person decides the work is finished.
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  expect(
    task!.doneAt,
    "a full checklist closed the task; completion is a person's call",
  ).toBeNull();
  // And the card still offers "Complete", not "Reopen".
  await page.goto(`/tasks?board=${boardId}`);
  const card = page.locator(`[data-task-id="${taskId}"]`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByTestId("task-toggle")).toHaveAttribute("aria-label", "Complete");
});

test("a step becomes a real subtask in one click, and leaves the checklist", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&task=${taskId}`);
  const list = page.getByTestId("task-checklist");
  await expect(list).toBeVisible({ timeout: 20_000 });

  const before = await prisma.taskChecklistItem.count({ where: { taskId } });
  await list.getByTestId("checklist-promote").first().click();

  await expect
    .poll(async () => prisma.taskChecklistItem.count({ where: { taskId } }), { timeout: 20_000 })
    .toBe(before - 1);

  const subtasks = await prisma.task.findMany({ where: { parentId: taskId } });
  expect(subtasks).toHaveLength(1);
  expect(subtasks[0]!.title).toBe("Draft the copy");
  // It arrives on the same board and in the same column as its parent, so it
  // is somewhere a person can actually see it.
  expect(subtasks[0]!.boardId).toBe(boardId);
  expect(subtasks[0]!.sectionId).toBe(sectionId);
});
