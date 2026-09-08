import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BOARD = "E2E Settings Board";
const RENAMED = "E2E Renamed Board";
let workspaceId = "";
let boardId = "";

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  await cleanup();
  const board = await prisma.taskBoard.create({
    data: {
      workspaceId,
      name: BOARD,
      sections: { create: [{ workspaceId, name: "To do", position: 1024 }] },
    },
  });
  boardId = board.id;
});

async function cleanup() {
  const boards = await prisma.taskBoard.findMany({ where: { name: { in: [BOARD, RENAMED] } } });
  for (const b of boards) {
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
 * Editing a board after it exists.
 *
 * The name was editable in place, behind a border that only appears on hover —
 * an affordance nobody finds. The description and colour could be set at
 * creation and never changed, which made them a decision you had to get right
 * first time.
 */
test("a board's name, description and colour can all be changed afterwards", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}`);
  await page.getByTestId("edit-board").click();

  await page.getByTestId("edit-board-name").fill(RENAMED);
  await page.getByTestId("edit-board-description").fill("What this board is for.");
  // `fill` on a colour input, not a hand-dispatched event: setting `.value`
  // directly bypasses React's value tracker, so onChange never fires and the
  // state keeps the old colour — which is exactly how this test first failed.
  await page.getByTestId("edit-board-color").fill("#3ddc97");
  await page.getByTestId("edit-board-save").click();

  await expect(page.getByTestId("board-name")).toHaveValue(RENAMED, { timeout: 15_000 });

  const saved = await prisma.taskBoard.findUnique({ where: { id: boardId } });
  expect(saved!.name).toBe(RENAMED);
  expect(saved!.description).toBe("What this board is for.");
  // The colour reaches a style attribute, so it goes through isSafeColor first.
  expect(saved!.color).toBe("#3ddc97");
});

test("archiving lives in the same dialog, and the board leaves the switcher", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}`);
  await page.getByTestId("edit-board").click();
  await page.getByTestId("edit-board-archive").click();
  await page.waitForTimeout(1500);

  const archived = await prisma.taskBoard.findUnique({ where: { id: boardId } });
  expect(archived!.archivedAt).not.toBeNull();

  // Archive, not delete: the tasks and the sections are still there.
  expect(await prisma.taskSection.count({ where: { boardId } })).toBe(1);

  await page.goto("/tasks");
  await expect(page.getByTestId("board-tab").filter({ hasText: RENAMED })).toHaveCount(0);

  // And it comes back.
  await prisma.taskBoard.update({ where: { id: boardId } , data: { archivedAt: null } });
});

test("a board cannot be saved with an empty name", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}`);
  await page.getByTestId("edit-board").click();
  await page.getByTestId("edit-board-name").fill("   ");
  // Refused in the button's own state rather than by a server round trip that
  // would leave a board nobody can find in the switcher.
  await expect(page.getByTestId("edit-board-save")).toBeDisabled();
});
