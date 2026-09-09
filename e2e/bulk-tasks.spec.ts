import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RUN = String(Date.now());
const BOARD = `E2E Bulk Board ${RUN}`;
let workspaceId = "";
let boardId = "";
let firstSection = "";
let otherBoardId = "";

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
  firstSection = board.sections.find((s) => s.name === "Doing")!.id;

  // Six open tasks, and one already complete so "already complete" is exercised.
  for (let i = 1; i <= 6; i++) {
    await prisma.task.create({
      data: {
        workspaceId,
        boardId,
        sectionId: firstSection,
        title: `Bulk task ${i} ${RUN}`,
        position: i * 1024,
      },
    });
  }
  await prisma.task.create({
    data: {
      workspaceId,
      boardId,
      sectionId: firstSection,
      title: `Bulk done ${RUN}`,
      position: 7 * 1024,
      doneAt: new Date(),
    },
  });

  // A second board, so the board switcher has something to switch to. The
  // cross-board section rule is proved in test/integration/bulk-tasks.test.ts,
  // where the module can be imported directly.
  const other = await prisma.taskBoard.create({
    data: {
      workspaceId,
      name: `E2E Bulk Other ${RUN}`,
      sections: { create: [{ workspaceId, name: "Elsewhere", position: 1024 }] },
    },
    include: { sections: true },
  });
  otherBoardId = other.id;
  await prisma.task.create({
    data: {
      workspaceId,
      boardId: otherBoardId,
      sectionId: other.sections[0]!.id,
      title: `Bulk elsewhere ${RUN}`,
      position: 1024,
    },
  });
});

test.afterAll(async () => {
  for (const id of [boardId, otherBoardId]) {
    await prisma.task.deleteMany({ where: { boardId: id } });
    await prisma.taskSection.deleteMany({ where: { boardId: id } });
    await prisma.taskBoard.deleteMany({ where: { id } });
  }
  await prisma.undoEntry.deleteMany({ where: { workspaceId } });
  await prisma.$disconnect();
});

async function selectCards(page: import("@playwright/test").Page, howMany: number) {
  const boxes = page.getByTestId("task-select");
  for (let i = 0; i < howMany; i++) await boxes.nth(i).check();
}

/**
 * Bulk actions on the task board (playbook-v5 P17/1).
 *
 * The board had none: every action was one card at a time. What is worth
 * proving is not that the buttons exist but that the RULES still hold per row
 * and that the skips are reported — a bulk action that reports only a count is
 * lying by omission.
 */
test("a bulk priority change applies to what was selected, and offers an undo", async ({
  page,
}) => {
  await page.goto(`/tasks?board=${boardId}`);
  await expect(page.getByTestId("task-card").first()).toBeVisible({ timeout: 20_000 });

  await selectCards(page, 3);
  await expect(page.getByTestId("bulk-count")).toContainText("3 selected");

  await page.getByTestId("bulk-priority").click();
  await page.getByTestId("bulk-priority-value").selectOption("urgent");
  await page.getByTestId("bulk-confirm").click();

  await expect
    .poll(
      async () =>
        prisma.task.count({ where: { boardId, priority: "urgent" } }),
      { timeout: 20_000 },
    )
    .toBe(3);

  // Undoable through the P16 layer, because a priority change has an inverse.
  const toast = page.getByTestId("toast");
  await expect(toast).toBeVisible();
  await toast.getByTestId("undo-button").click();
  await expect
    .poll(async () => prisma.task.count({ where: { boardId, priority: "urgent" } }), {
      timeout: 20_000,
    })
    .toBe(0);
});

/**
 * THE ONE THAT MATTERS: a per-row rule still applies per row, and the rows it
 * refused are named with the reason.
 *
 * "Complete" on a selection containing an already-complete task must report it
 * rather than counting it — the difference between "4 completed" and
 * "3 completed, 1 skipped — already complete" is the difference between a
 * report and a guess.
 */
test("a bulk complete reports the rows it skipped, with the reason", async ({ page }) => {
  // `done=1` so the already-complete task is on screen — it is the row whose
  // skip reason this test is about.
  await page.goto(`/tasks?board=${boardId}&done=1`);
  const doneCard = page.getByTestId("task-card").filter({ hasText: `Bulk done ${RUN}` });
  await expect(doneCard).toBeVisible({ timeout: 20_000 });

  /**
   * TWO specific cards, not "every checkbox on screen".
   *
   * Selecting everything made this test depend on how many cards the previous
   * test had left open, which is how it went flaky. One already-complete row
   * and one open row is the whole point: the result has to be
   * "1 completed, 1 skipped — already complete", not "2 completed".
   */
  const openCard = page.getByTestId("task-card").filter({ hasText: `Bulk task 1 ${RUN}` });
  await expect(openCard).toBeVisible();
  await doneCard.getByTestId("task-select").check();
  await openCard.getByTestId("task-select").check();
  await expect(page.getByTestId("bulk-count")).toContainText("2 selected");

  await page.getByTestId("bulk-complete").click();
  await page.getByTestId("bulk-confirm").click();

  const summary = page.getByTestId("bulk-summary");
  await expect(summary).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("bulk-skipped")).toContainText(/already complete/i);
});

/**
 * Deletion needs a typed confirmation, not just a dialog — it takes subtasks,
 * comments, attachments and dependency links with it, and cannot be undone.
 */
test("bulk delete will not fire until the word is typed", async ({ page }) => {
  /**
   * Its own row, deliberately: the completion test above ticks everything on
   * the board, so a test that reused those cards would find an empty board and
   * fail for a reason that has nothing to do with confirmations.
   */
  await prisma.task.create({
    data: {
      workspaceId,
      boardId,
      sectionId: firstSection,
      title: `Bulk deletable ${RUN}`,
      position: 99 * 1024,
    },
  });
  await page.goto(`/tasks?board=${boardId}`);
  await expect(page.getByTestId("task-card").first()).toBeVisible({ timeout: 20_000 });

  await selectCards(page, 1);
  await page.getByTestId("bulk-delete").click();
  await expect(page.getByTestId("bulk-confirm")).toBeDisabled();

  await page.getByTestId("bulk-confirm-word").fill("DELETE");
  await expect(page.getByTestId("bulk-confirm")).toBeEnabled();
});
