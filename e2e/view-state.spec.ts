import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RUN = String(Date.now());
const BOARD = `E2E View Board ${RUN}`;
let workspaceId = "";
let boardId = "";
let taskTitle = "";

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  const board = await prisma.taskBoard.create({
    data: {
      workspaceId,
      name: BOARD,
      sections: { create: [{ workspaceId, name: "To do", position: 1024 }] },
    },
    include: { sections: true },
  });
  boardId = board.id;
  taskTitle = `View task ${RUN}`;
  await prisma.task.create({
    data: {
      workspaceId,
      boardId,
      sectionId: board.sections[0]!.id,
      title: taskTitle,
      position: 1024,
    },
  });
});

test.afterAll(async () => {
  await prisma.task.deleteMany({ where: { boardId } });
  await prisma.taskSection.deleteMany({ where: { boardId } });
  await prisma.taskBoard.deleteMany({ where: { id: boardId } });
  await prisma.$disconnect();
});

/**
 * A view is a place (playbook-v5 P16/5).
 *
 * All of this used to be component state, which meant three things were
 * impossible: sending somebody the view you were looking at, getting it back
 * after a reload, and — the one that actually bites — pressing Back to close
 * a card. Back left the page.
 */
test("the view mode and the filters reach the URL, and survive a reload", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}`);
  await expect(page.getByTestId("task-card").filter({ hasText: taskTitle })).toBeVisible({
    timeout: 20_000,
  });

  await page.getByTestId("view-list").click();
  await expect(page).toHaveURL(/[?&]v=list/, { timeout: 15_000 });

  await page.reload();
  // Restored from the URL rather than reset to the default board view.
  await expect(page).toHaveURL(/[?&]v=list/);
  await expect(page.getByTestId("view-list")).toHaveAttribute("aria-pressed", "true");
});

/**
 * The rule that keeps links readable: a view sitting at its defaults has a
 * clean URL. Without it, every link carries every key and two identical views
 * produce two different addresses.
 */
test("going back to a default drops the parameter instead of writing it", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}`);
  await expect(page.getByTestId("view-list")).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("view-list").click();
  await expect(page).toHaveURL(/[?&]v=list/, { timeout: 15_000 });

  await page.getByTestId("view-board").click();
  await expect(page).not.toHaveURL(/[?&]v=/, { timeout: 15_000 });
  // And the board it was on is still there — a view update must not drop
  // parameters it does not own.
  await expect(page).toHaveURL(new RegExp(`board=${boardId}`));
});

/**
 * Opening a card pushes a history entry, so Back closes it. This is the
 * behaviour a detail overlay held in component state can never have.
 */
test("Back closes an open card rather than leaving the board", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}`);
  const card = page.getByTestId("task-card").filter({ hasText: taskTitle });
  await expect(card).toBeVisible({ timeout: 20_000 });

  await card.getByTestId("inline-cell").first().click();
  await expect(page).toHaveURL(/[?&]task=/, { timeout: 15_000 });
  await expect(page.getByTestId("detail-title")).toBeVisible();

  await page.goBack();
  await expect(page).not.toHaveURL(/[?&]task=/, { timeout: 15_000 });
  await expect(page.getByTestId("detail-title")).toHaveCount(0);
  // Still on the board, not somewhere else entirely.
  await expect(card).toBeVisible();
});

/**
 * A filter REPLACES rather than pushing: four toggles must not mean four
 * presses of Back to leave the page.
 */
test("a filter does not pile up history entries", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}`);
  await expect(page.getByTestId("filter-mine")).toBeVisible({ timeout: 20_000 });

  for (let i = 0; i < 4; i++) {
    await page.getByTestId("filter-mine").click();
    await page.waitForTimeout(250);
  }

  // One Back leaves the board's query state entirely rather than stepping
  // through four toggles.
  await page.goBack();
  await expect(page).not.toHaveURL(/[?&]mine=/, { timeout: 15_000 });
});
