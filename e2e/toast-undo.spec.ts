import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BOARD = "E2E Toast Board";
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
  for (const b of await prisma.taskBoard.findMany({ where: { name: BOARD } })) {
    await prisma.task.deleteMany({ where: { boardId: b.id } });
    await prisma.taskSection.deleteMany({ where: { boardId: b.id } });
    await prisma.taskBoard.delete({ where: { id: b.id } });
  }
  await prisma.undoEntry.deleteMany({ where: { workspaceId, kind: "board_archive" } });
}

test.afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

/**
 * The toast layer, through a real action (playbook-v5 P16/3).
 *
 * Archiving a board is the case that most needs an undo: the board leaves the
 * switcher, so the person who did it by accident cannot find it to put it
 * back. It is also a genuine inverse — one nullable column — which is why
 * `contract.ts` declares it undoable while task deletion is declared permanent.
 *
 * What is worth proving in a browser rather than a unit test is that the
 * SERVER put the row back: the reducer's rules are tested directly in
 * test/unit/toast-queue.test.ts, where they do not cost six real seconds.
 */
test("archiving offers an undo, and the undo restores the board on the server", async ({
  page,
}) => {
  await page.goto(`/tasks?board=${boardId}`);
  await page.getByTestId("edit-board").click();
  await page.getByTestId("edit-board-archive").click();

  const toast = page.getByTestId("toast").filter({ hasText: `Archived ${BOARD}` });
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(toast).toHaveAttribute("data-variant", "undoable");

  // It really did archive — the undo is reversing something, not decorating.
  await expect
    .poll(async () => (await prisma.taskBoard.findUnique({ where: { id: boardId } }))!.archivedAt)
    .not.toBeNull();

  // The countdown is running rather than frozen at its start.
  await expect(page.getByTestId("undo-countdown")).toBeVisible();

  await toast.getByTestId("undo-button").click();

  await expect
    .poll(
      async () => (await prisma.taskBoard.findUnique({ where: { id: boardId } }))!.archivedAt,
      { timeout: 15_000 },
    )
    .toBeNull();

  // And the board is back where it can be found.
  await page.goto("/tasks");
  await expect(page.getByTestId("board-tab").filter({ hasText: BOARD })).toHaveCount(1);
});

/**
 * The refusal path. An undo whose row has moved underneath it must decline and
 * SAY SO — the whole reason the inverse is stored with the state it expected.
 *
 * Hovering the stack first, deliberately: it pauses every countdown, which is
 * both what makes this test deterministic (the six-second window cannot expire
 * while the DB is being changed) and a behaviour worth proving — taking the
 * Undo button out from under a pointer that is resting on it is the single
 * most annoying thing this control could do.
 */
test("an undo whose row changed underneath it is declined, in the toast", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}`);
  await page.getByTestId("edit-board").click();
  await page.getByTestId("edit-board-archive").click();

  const stack = page.getByTestId("toast-stack");
  await expect(stack).toBeVisible({ timeout: 15_000 });
  await stack.hover();
  await expect(stack).toHaveAttribute("data-paused", "true");

  const toast = page.getByTestId("toast");
  await expect(toast).toHaveAttribute("data-variant", "undoable");

  // Somebody else moves it before the undo is clicked. The undo would now be
  // writing over a newer decision rather than reversing its own.
  await expect
    .poll(async () => (await prisma.taskBoard.findUnique({ where: { id: boardId } }))!.archivedAt)
    .not.toBeNull();
  await prisma.taskBoard.update({
    where: { id: boardId },
    data: { archivedAt: new Date(Date.now() - 60_000) },
  });

  await toast.getByTestId("undo-button").click();

  // The refusal REPLACES the label, so the toast is found by its testid rather
  // than by the text it used to carry.
  await expect(toast).toHaveAttribute("data-variant", "error", { timeout: 15_000 });
  await expect(toast).toContainText(/changed since/i);
  // The Undo button is gone: there is nothing left to click.
  await expect(toast.getByTestId("undo-button")).toHaveCount(0);

  // And it declined rather than half-applying: the newer value still stands.
  const after = await prisma.taskBoard.findUnique({ where: { id: boardId } });
  expect(after!.archivedAt).not.toBeNull();

  await prisma.taskBoard.update({ where: { id: boardId }, data: { archivedAt: null } });
});
