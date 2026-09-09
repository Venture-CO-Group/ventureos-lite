import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RUN = String(Date.now());
const BOARD = `E2E Group Board ${RUN}`;
let workspaceId = "";
let boardId = "";
let doingId = "";
let laterId = "";
let taskId = "";

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  const board = await prisma.taskBoard.create({
    data: {
      workspaceId,
      name: BOARD,
      sections: {
        create: [
          { workspaceId, name: "Doing", position: 1024 },
          { workspaceId, name: "Later", position: 2048 },
        ],
      },
    },
    include: { sections: true },
  });
  boardId = board.id;
  doingId = board.sections.find((s) => s.name === "Doing")!.id;
  laterId = board.sections.find((s) => s.name === "Later")!.id;

  taskId = (
    await prisma.task.create({
      data: {
        workspaceId,
        boardId,
        sectionId: doingId,
        title: `Group task ${RUN}`,
        priority: "low",
        position: 1024,
      },
    })
  ).id;
});

test.afterAll(async () => {
  await prisma.savedView.deleteMany({ where: { workspaceId, entity: "task" } });
  await prisma.task.deleteMany({ where: { boardId } });
  await prisma.taskSection.deleteMany({ where: { boardId } });
  await prisma.taskBoard.deleteMany({ where: { id: boardId } });
  await prisma.undoEntry.deleteMany({ where: { workspaceId } });
  await prisma.$disconnect();
});

/** One shared DataTransfer through the real handlers — see e2e/my-work.spec.ts. */
async function dragCard(page: import("@playwright/test").Page, id: string, groupKey: string) {
  await page.evaluate(
    ({ taskId, groupKey }) => {
      const source = document.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
      const target = document.querySelector<HTMLElement>(`[data-group-key="${groupKey}"]`);
      if (!source || !target) throw new Error("drag endpoints not found");
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer }));
      source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
    },
    { taskId: id, groupKey },
  );
}

/**
 * Board grouping (playbook-v5 P18/2).
 *
 * ── THE RULE THIS EXISTS TO PROTECT ─────────────────────────────────────────
 *
 * A board's columns ARE its sections. Grouping by anything else rearranges
 * what you see and must change nothing about where the work lives — so a drop
 * writes the grouped attribute and `sectionId` is untouched. Getting that
 * wrong would shred a board's arrangement the first time somebody grouped by
 * priority and dragged a card, which is why it is asserted directly.
 */
test("grouping by priority and dragging sets priority without touching the column", async ({
  page,
}) => {
  await page.goto(`/tasks?board=${boardId}`);
  await expect(page.getByTestId("task-card").first()).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("group-by-priority").click();
  await expect(page).toHaveURL(/[?&]g=priority/, { timeout: 15_000 });
  await expect(page.getByTestId("grouped-board")).toBeVisible();
  // The UI says what dragging will do, rather than leaving it to be discovered.
  await expect(page.getByTestId("grouping-note")).toContainText(/sets priority/i);

  await dragCard(page, taskId, "urgent");

  await expect
    .poll(async () => (await prisma.task.findUnique({ where: { id: taskId } }))!.priority, {
      timeout: 20_000,
    })
    .toBe("urgent");

  // THE IMPORTANT HALF: the column did not move.
  const after = await prisma.task.findUnique({ where: { id: taskId } });
  expect(after!.sectionId).toBe(doingId);

  // Undoable, like any other drag.
  const toast = page.getByTestId("toast");
  await expect(toast).toBeVisible();
  await toast.getByTestId("undo-button").click();
  await expect
    .poll(async () => (await prisma.task.findUnique({ where: { id: taskId } }))!.priority, {
      timeout: 20_000,
    })
    .toBe("low");
});

/** Grouped by section — the default — dragging still means move and reorder. */
test("grouped by column, dragging still moves between columns", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}`);
  await expect(page.getByTestId("task-card").first()).toBeVisible({ timeout: 20_000 });
  // No grouped board in the default arrangement — these are the real columns.
  await expect(page.getByTestId("grouped-board")).toHaveCount(0);

  const card = page.getByTestId("task-card").filter({ hasText: `Group task ${RUN}` });
  await card.dragTo(page.getByTestId("board-column").nth(1));

  await expect
    .poll(async () => (await prisma.task.findUnique({ where: { id: taskId } }))!.sectionId, {
      timeout: 20_000,
    })
    .toBe(laterId);

  await prisma.task.update({ where: { id: taskId }, data: { sectionId: doingId } });
});

/** Nothing can be dropped into a group that has no single meaning. */
test("the untagged group refuses drops", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&g=tag`);
  await expect(page.getByTestId("grouped-board")).toBeVisible({ timeout: 20_000 });
  const untagged = page.locator('[data-group-key="__untagged__"]');
  await expect(untagged).toHaveAttribute("data-droppable", "false");
});

/**
 * And the saved views, on the leads' own table and sharing rules — extended,
 * not forked.
 */
test("a grouping can be saved as a tab, shared, and reopened", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}`);
  await expect(page.getByTestId("board-view-tabs")).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("group-by-assignee").click();
  await expect(page).toHaveURL(/[?&]g=assignee/, { timeout: 15_000 });

  const name = `By person ${RUN}`;
  await page.getByTestId("board-view-save").click();
  await page.getByTestId("board-view-name").fill(name);
  await page.getByTestId("board-view-shared-toggle").check();
  await page.getByTestId("board-view-save-confirm").click();

  const tab = page.getByTestId("board-view-tab").filter({ hasText: name });
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await expect(tab.getByTestId("board-view-shared")).toBeVisible();

  // It reached the leads' own SavedView table, under entity "task".
  const row = await prisma.savedView.findFirst({ where: { name, entity: "task" } });
  expect(row).not.toBeNull();
  expect(row!.shared).toBe(true);
  expect((row!.config as { groupBy?: string }).groupBy).toBe("assignee");

  // Going back to Everything and reopening the tab restores the grouping.
  await page.getByTestId("board-view-all").click();
  await expect(page).not.toHaveURL(/[?&]g=assignee/, { timeout: 15_000 });
  await tab.click();
  await expect(page).toHaveURL(/[?&]g=assignee/, { timeout: 15_000 });
});
