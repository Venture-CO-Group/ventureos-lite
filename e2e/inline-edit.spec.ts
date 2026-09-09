import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RUN = String(Date.now());
const BOARD = `E2E Inline Board ${RUN}`;
let workspaceId = "";
let boardId = "";
let sectionId = "";
let taskId = "";

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
  sectionId = board.sections[0]!.id;
  const task = await prisma.task.create({
    data: {
      workspaceId,
      boardId,
      sectionId,
      title: `Inline task ${RUN}`,
      priority: "medium",
      // A due date so the chip renders and can be edited.
      dueAt: new Date("2026-10-15T12:00:00.000Z"),
      startAt: new Date("2026-10-10T12:00:00.000Z"),
    },
  });
  taskId = task.id;
});

test.afterAll(async () => {
  await prisma.task.deleteMany({ where: { boardId } });
  await prisma.taskSection.deleteMany({ where: { boardId } });
  await prisma.taskBoard.deleteMany({ where: { id: boardId } });
  await prisma.$disconnect();
});

/**
 * The inline primitive, on a kanban card (playbook-v5 P16/1).
 *
 * The card is the surface that makes the point: a single click OPENS the task,
 * so inline editing had to take a gesture that was free. The title edits on
 * double-click; the priority and date chips, which navigate nowhere, edit on a
 * single click.
 */
test("a card's priority commits in place, and the server's value is what shows", async ({
  page,
}) => {
  await page.goto(`/tasks?board=${boardId}`);
  const card = page.getByTestId("task-card").filter({ hasText: `Inline task ${RUN}` });
  await expect(card).toBeVisible({ timeout: 20_000 });

  await card.getByTestId("card-priority").getByTestId("inline-cell").click();
  await card.getByTestId("card-priority").getByRole("combobox").selectOption("urgent");

  await expect
    .poll(async () => (await prisma.task.findUnique({ where: { id: taskId } }))!.priority, {
      timeout: 15_000,
    })
    .toBe("urgent");
});

/**
 * THE ONE THE PLAYBOOK ASKS FOR: a rejected edit reverts and explains itself.
 *
 * The task starts 10 October and is due the 15th. Moving the due date to the
 * 5th would put it before its own start — refused by the server, because that
 * is the error that makes a timeline draw a bar backwards. The optimistic
 * update must come back, and the reason has to reach the person: in the cell,
 * and in a toast, because "A task cannot be due before it starts" does not fit
 * in a date chip.
 */
test("a rejected edit puts the old value back and says why", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}`);
  const card = page.getByTestId("task-card").filter({ hasText: `Inline task ${RUN}` });
  await expect(card).toBeVisible({ timeout: 20_000 });

  const due = card.getByTestId("task-due");
  await due.getByTestId("inline-cell").click();
  const input = due.locator('input[type="date"]');
  await input.fill("2026-10-05");
  await input.press("Enter");

  // The reason, in the toast — long enough that a chip could not hold it.
  const toast = page.getByTestId("toast");
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(toast).toContainText(/cannot be due before it starts/i);
  await expect(toast).toHaveAttribute("data-variant", "error");

  // And in place: the cell is marked as refused and carries the reason.
  await expect(due.getByTestId("inline-cell")).toHaveAttribute("data-error", "true");
  await expect(due.getByTestId("inline-cell")).toHaveAttribute(
    "title",
    /cannot be due before it starts/i,
  );

  // The database never moved.
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  expect(task!.dueAt!.toISOString().slice(0, 10)).toBe("2026-10-15");
});
