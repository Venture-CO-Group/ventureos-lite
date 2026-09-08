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

  /**
   * ---- add tasks --------------------------------------------------------
   *
   * Every step below waits on an ASSERTION rather than on a clock. The first
   * version of this test slept 900ms after each write and went flaky the
   * moment the dev server had a slow moment — which is the worst kind of test
   * failure, because it accuses the feature of a defect the feature does not
   * have.
   */
  await columns.nth(0).getByTestId("add-task").click();
  const input = columns.nth(0).getByTestId("new-task-input");
  await input.fill("Write the launch email");
  await input.press("Enter");
  await expect(columns.nth(0).getByTestId("task-card")).toHaveCount(1);
  // The input stays open — adding tasks is something people do in runs.
  await input.fill("Book the photographer");
  await input.press("Enter");
  await expect(columns.nth(0).getByTestId("task-card")).toHaveCount(2);
  await expect(page.getByTestId("board-progress")).toContainText("0/2");

  // ---- a custom column ---------------------------------------------------
  await page.getByTestId("add-section").click();
  await page.getByTestId("new-section-input").fill("Blocked");
  await page.getByTestId("new-section-input").press("Enter");
  await expect(page.getByTestId("board-column")).toHaveCount(4);

  // ---- detail: assignee, priority, due, description ----------------------
  await page.getByTestId("task-card").first().getByRole("button").nth(1).click();
  await expect(page.getByTestId("detail-title")).toBeVisible();

  await page.getByTestId("detail-priority").selectOption("urgent");
  // The reload after a save re-renders the select from the server's answer, so
  // seeing the new value IS the confirmation that the write landed.
  await expect(page.getByTestId("detail-priority")).toHaveValue("urgent");
  await page.getByTestId("detail-due").fill("2026-09-01");
  await expect(page.getByTestId("detail-due")).toHaveValue("2026-09-01");
  await page.getByTestId("detail-note").fill("Three paragraphs, no more.");
  await page.getByTestId("detail-note").blur();
  await expect(page.getByTestId("detail-note")).toHaveValue("Three paragraphs, no more.");

  // ---- subtasks ----------------------------------------------------------
  await page.getByTestId("subtask-input").fill("Draft it");
  await page.getByTestId("subtask-input").press("Enter");
  await expect(page.getByTestId("subtask-row")).toHaveCount(1);
  await page.getByTestId("subtask-input").fill("Get it checked");
  await page.getByTestId("subtask-input").press("Enter");
  await expect(page.getByTestId("subtask-row")).toHaveCount(2);

  // Completing one subtask must NOT complete the parent — the decision to
  // close a task belongs to the person who can see the last step was real.
  await page.getByTestId("subtask-row").first().locator("input").check();
  await expect(page.getByText("Subtasks · 1/2")).toBeVisible();

  // ---- a comment ---------------------------------------------------------
  await page.getByTestId("comment-input").fill("Photographer is booked for the 12th.");
  await page.getByTestId("comment-submit").click();
  /**
   * A longer budget than the 5s default, on purpose.
   *
   * Posting a comment is the heaviest write on this screen: it resolves the
   * workspace's members to find @mentions, upserts a follower row per person
   * named, delivers a notification to everybody following the task, and only
   * then reloads. Under a full-suite dev server that can pass five seconds,
   * and a timeout there would accuse the feature of losing comments it had
   * in fact saved.
   */
  await expect(page.getByTestId("comment-row")).toHaveCount(1, { timeout: 20_000 });

  await page.getByRole("button", { name: "Done" }).last().click();
  await expect(page.getByTestId("detail-title")).toHaveCount(0);

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
  // Completed tasks leave the board unless you ask for them.
  await expect(page.getByTestId("task-card")).toHaveCount(1);
  await page.getByTestId("filter-done").check();
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
  // The card arriving in the other column is the signal the move committed;
  // only then is it worth asking the database what it recorded.
  await expect(to.getByTestId("task-card")).toHaveCount(1);
  await expect(from.getByTestId("task-card")).toHaveCount(0);

  const after = await prisma.task.findUnique({ where: { id: task.id } });
  expect(after?.sectionId).toBe(sections[1]!.id);
});
