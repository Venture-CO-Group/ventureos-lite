import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RUN = String(Date.now());
const BOARD = `E2E Workload Board ${RUN}`;
let workspaceId = "";
let boardId = "";
let sectionId = "";
let runnerId = "";
let estimatedId = "";
let unassignedId = "";

const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(12, 0, 0, 0);
  return d;
};
const inTwoDays = () => {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  d.setHours(12, 0, 0, 0);
  return d;
};

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  runnerId = (await prisma.user.findFirst({ where: { email: "e2e-runner@ventureco.test" } }))!.id;

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

  /** A day where EVERYTHING is estimated — reportable in hours. */
  estimatedId = (
    await prisma.task.create({
      data: {
        workspaceId,
        boardId,
        sectionId,
        title: `WL estimated ${RUN}`,
        assigneeId: runnerId,
        dueAt: tomorrow(),
        estimateMinutes: 180,
        position: 1024,
      },
    })
  ).id;

  /** A day with an unestimated task — must fall back to a COUNT. */
  await prisma.task.create({
      data: {
        workspaceId,
        boardId,
        sectionId,
        title: `WL unestimated ${RUN}`,
        assigneeId: runnerId,
        dueAt: inTwoDays(),
      position: 2048,
    },
  });

  /** Work nobody owns — the row that must not be hidden. */
  unassignedId = (
    await prisma.task.create({
      data: {
        workspaceId,
        boardId,
        sectionId,
        title: `WL unowned ${RUN}`,
        dueAt: tomorrow(),
        position: 3072,
      },
    })
  ).id;
});

test.afterAll(async () => {
  await prisma.task.deleteMany({ where: { boardId } });
  await prisma.taskSection.deleteMany({ where: { boardId } });
  await prisma.taskBoard.deleteMany({ where: { id: boardId } });
  await prisma.undoEntry.deleteMany({ where: { workspaceId } });
  await prisma.$disconnect();
});

/**
 * Workload (playbook-v5 P19/3).
 *
 * The load arithmetic is proved in test/unit/time-logic.test.ts. What only a
 * browser shows is the rule the playbook is emphatic about: a count-based
 * figure must never be presented as if it were hours.
 */
test("a fully estimated day reads in hours; a day with anything unestimated reads as a count", async ({
  page,
}) => {
  await page.goto(`/tasks?board=${boardId}&v=workload`);
  await expect(page.getByTestId("task-workload")).toBeVisible({ timeout: 20_000 });

  const mine = page.locator(`[data-member="${runnerId}"]`);
  await expect(mine).toHaveCount(1);

  // Tomorrow: one task, estimated — hours.
  const estimatedCell = mine.locator('[data-testid="workload-cell"][data-mode="estimates"]').first();
  await expect(estimatedCell).toBeVisible();
  await expect(estimatedCell).toContainText("h");

  // Two days out: unestimated — a count, marked with × and never an "h".
  const countCell = mine.locator('[data-testid="workload-cell"][data-mode="count"]');
  const withWork = countCell.filter({ hasText: "×" }).first();
  await expect(withWork).toBeVisible();
  await expect(withWork).not.toContainText("h");
  // And its tooltip says so in words.
  await expect(withWork).toHaveAttribute("title", /count rather than hours/i);
});

/** The assumption is stated, not buried. */
test("the header states the assumption in use", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&v=workload`);
  await expect(page.getByTestId("workload-assumption")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("workload-assumption")).toContainText(/hours a day/i);

  // And it is configurable, from the same place.
  await page.getByTestId("workload-tasks-per-day").fill("2");
  await expect(page.getByTestId("workload-assumption")).toBeVisible();
});

/**
 * Work nobody owns is the work that gets forgotten, so it is a row — and a
 * capacity view that hid it would report the team as comfortable.
 */
test("unassigned work has its own row", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&v=workload`);
  await expect(page.getByTestId("task-workload")).toBeVisible({ timeout: 20_000 });

  const unowned = page.locator('[data-member="__unassigned__"]');
  await expect(unowned).toHaveCount(1);
  await expect(unowned).toContainText(`WL unowned ${RUN}`);
});

test("dragging a task onto another row reassigns it, undoably", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&v=workload`);
  await expect(page.getByTestId("task-workload")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`[data-task-id="${unassignedId}"]`)).toBeVisible();

  await page.evaluate(
    ({ taskId, member }) => {
      const source = document.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
      const target = document.querySelector<HTMLElement>(`[data-member="${member}"]`);
      if (!source || !target) throw new Error("drag endpoints not found");
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer }));
    },
    { taskId: unassignedId, member: runnerId },
  );

  await expect
    .poll(
      async () => (await prisma.task.findUnique({ where: { id: unassignedId } }))!.assigneeId,
      { timeout: 20_000 },
    )
    .toBe(runnerId);

  const toast = page.getByTestId("toast");
  await expect(toast).toBeVisible();
  await toast.getByTestId("undo-button").click();
  await expect
    .poll(
      async () => (await prisma.task.findUnique({ where: { id: unassignedId } }))!.assigneeId,
      { timeout: 20_000 },
    )
    .toBeNull();
});

/** Overload is highlighted against the threshold. */
test("a day over capacity is marked", async ({ page }) => {
  // Ten hours in one day is over any sensible day.
  await prisma.task.update({
    where: { id: estimatedId },
    data: { estimateMinutes: 600 },
  });
  try {
    await page.goto(`/tasks?board=${boardId}&v=workload`);
    await expect(page.getByTestId("task-workload")).toBeVisible({ timeout: 20_000 });
    const mine = page.locator(`[data-member="${runnerId}"]`);
    await expect(mine.locator('[data-overloaded="true"]').first()).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await prisma.task.update({ where: { id: estimatedId }, data: { estimateMinutes: 180 } });
  }
});
