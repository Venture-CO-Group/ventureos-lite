import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BOARD = "E2E Launch Board";

test.afterAll(async () => {
  const boards = await prisma.taskBoard.findMany({ where: { name: { contains: "E2E " } } });
  for (const b of boards) {
    await prisma.task.deleteMany({ where: { boardId: b.id } });
    await prisma.taskSection.deleteMany({ where: { boardId: b.id } });
    await prisma.taskBoard.delete({ where: { id: b.id } });
  }
  await prisma.$disconnect();
});

/**
 * The whole board, driven the way a person drives it.
 *
 * Ordering and drag-and-drop are covered as logic in the unit tests; what only
 * a browser can prove is that the columns render, the cards land in the right
 * one, and the detail panel writes what it says it writes.
 */
test("a board can be created, filled, and worked", async ({ page }) => {
  await page.goto("/tasks");

  // ---- create ------------------------------------------------------------
  await page.getByTestId("new-board").click();
  await page.getByTestId("board-name-input").fill(BOARD);
  await page.getByTestId("board-create").click();
  await expect(page.getByTestId("board-tab").filter({ hasText: BOARD })).toBeVisible();

  // It opens with the three columns Asana opens with — a board with no columns
  // cannot receive a card, so an empty one would be a dead end on arrival.
  const columns = page.getByTestId("board-column");
  await expect(columns).toHaveCount(3);
  await expect(columns.nth(0)).toContainText("To do");
  await expect(columns.nth(2)).toContainText("Done");

  // ---- add tasks ---------------------------------------------------------
  await columns.nth(0).getByTestId("add-task").click();
  const input = columns.nth(0).getByTestId("new-task-input");
  await input.fill("Write the launch email");
  await input.press("Enter");
  await page.waitForTimeout(900);
  // The input stays open — adding tasks is something people do in runs.
  await input.fill("Book the photographer");
  await input.press("Enter");
  await page.waitForTimeout(900);

  await expect(columns.nth(0).getByTestId("task-card")).toHaveCount(2);
  await expect(page.getByTestId("board-progress")).toContainText("0/2");

  // ---- a custom column ---------------------------------------------------
  await page.getByTestId("add-section").click();
  await page.getByTestId("new-section-input").fill("Blocked");
  await page.getByTestId("new-section-input").press("Enter");
  await page.waitForTimeout(900);
  await expect(page.getByTestId("board-column")).toHaveCount(4);

  // ---- detail: assignee, priority, due, description ----------------------
  await page.getByTestId("task-card").first().getByRole("button").nth(1).click();
  await expect(page.getByTestId("detail-title")).toBeVisible();

  await page.getByTestId("detail-priority").selectOption("urgent");
  await page.waitForTimeout(700);
  await page.getByTestId("detail-due").fill("2026-09-01");
  await page.waitForTimeout(700);
  await page.getByTestId("detail-note").fill("Three paragraphs, no more.");
  await page.getByTestId("detail-note").blur();
  await page.waitForTimeout(700);

  // ---- subtasks ----------------------------------------------------------
  await page.getByTestId("subtask-input").fill("Draft it");
  await page.getByTestId("subtask-input").press("Enter");
  await page.waitForTimeout(900);
  await page.getByTestId("subtask-input").fill("Get it checked");
  await page.getByTestId("subtask-input").press("Enter");
  await page.waitForTimeout(900);
  await expect(page.getByTestId("subtask-row")).toHaveCount(2);

  // Completing one subtask must NOT complete the parent — the decision to
  // close a task belongs to the person who can see the last step was real.
  await page.getByTestId("subtask-row").first().locator("input").check();
  await page.waitForTimeout(900);

  // ---- a comment ---------------------------------------------------------
  await page.getByTestId("comment-input").fill("Photographer is booked for the 12th.");
  await page.getByTestId("comment-submit").click();
  await page.waitForTimeout(900);
  await expect(page.getByTestId("comment-row")).toHaveCount(1);

  await page.getByRole("button", { name: "Done" }).last().click();
  await page.waitForTimeout(700);

  // ---- what the card now shows ------------------------------------------
  const card = page.getByTestId("task-card").first();
  await expect(card).toContainText("Urgent");
  await expect(card.getByTestId("subtask-count")).toContainText("1/2");
  await expect(card.getByTestId("task-due")).toContainText("overdue");

  // The parent is still open, which is the point of the subtask rule.
  const board = await prisma.taskBoard.findFirst({ where: { name: BOARD } });
  const parent = await prisma.task.findFirst({
    where: { boardId: board!.id, title: "Write the launch email" },
  });
  expect(parent?.doneAt).toBeNull();

  // ---- list view ---------------------------------------------------------
  await page.getByTestId("view-list").click();
  await expect(page.getByTestId("list-row")).toHaveCount(2);
  // The list sorts by urgency rather than keeping the board's arrangement.
  await expect(page.getByTestId("list-row").first()).toContainText("Write the launch email");

  // ---- complete one ------------------------------------------------------
  await page.getByTestId("view-board").click();
  await page.getByTestId("task-card").first().getByTestId("task-toggle").click();
  await page.waitForTimeout(1200);
  // Completed tasks leave the board unless you ask for them.
  await expect(page.getByTestId("task-card")).toHaveCount(1);
  await page.getByTestId("filter-done").check();
  await page.waitForTimeout(1200);
  await expect(page.getByTestId("task-card")).toHaveCount(2);
  await expect(page.getByTestId("board-progress")).toContainText("1/2");
});

const MOVE_BOARD = "E2E Move Board";

test("a task moved between columns stays there", async ({ page }) => {
  /**
   * Builds its own board rather than reusing the one the test above makes.
   *
   * Sharing state across tests in a file looks tidy until the first test goes
   * flaky: this one then fails on a null board and reports a drag-and-drop
   * defect that does not exist. A test that only passes when another test
   * passed first is not testing what its name says.
   */
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  const board = await prisma.taskBoard.create({
    data: {
      workspaceId: ws!.id,
      name: MOVE_BOARD,
      sections: {
        create: [
          { workspaceId: ws!.id, name: "To do", position: 1024 },
          { workspaceId: ws!.id, name: "In progress", position: 2048 },
        ],
      },
    },
  });
  const sections = await prisma.taskSection.findMany({
    where: { boardId: board.id },
    orderBy: { position: "asc" },
  });
  const task = await prisma.task.create({
    data: {
      workspaceId: ws!.id,
      boardId: board.id,
      sectionId: sections[0]!.id,
      title: "Book the photographer",
      position: 1024,
    },
  });

  await page.goto(`/tasks?board=${board.id}`);
  const from = page.getByTestId("board-column").nth(0);
  const to = page.getByTestId("board-column").nth(1);
  await expect(from.getByTestId("task-card")).toHaveCount(1);

  // Playwright's dragTo drives the real HTML5 drag events the board listens for.
  await from.getByTestId("task-card").first().dragTo(to);
  await page.waitForTimeout(1500);

  const after = await prisma.task.findUnique({ where: { id: task.id } });
  expect(after?.sectionId).toBe(sections[1]!.id);
  await expect(to.getByTestId("task-card")).toHaveCount(1);
});
