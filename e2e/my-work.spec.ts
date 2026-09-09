import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RUN = String(Date.now());
const BOARD = `E2E MyWork Board ${RUN}`;
let workspaceId = "";
let boardId = "";
let sectionId = "";
let runnerId = "";
let looseId = "";
let laterId = "";

/** Local end-of-day N days from today, matching how due dates are written. */
function inDays(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(23, 59, 0, 0);
  return d;
}

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

  // One on a board, due today.
  await prisma.task.create({
    data: {
      workspaceId,
      boardId,
      sectionId,
      title: `MyWork today ${RUN}`,
      assigneeId: runnerId,
      dueAt: inDays(0),
      position: 1024,
    },
  });

  /**
   * A LOOSE task — no board at all, raised by the system. These existed long
   * before boards did and are exactly what a board-shaped screen cannot show,
   * which is the reason My Work exists.
   */
  looseId = (
    await prisma.task.create({
      data: {
        workspaceId,
        title: `MyWork loose ${RUN}`,
        assigneeId: runnerId,
        dueAt: inDays(0),
        source: "signal",
      },
    })
  ).id;

  // One a fortnight out, so "Later" has something in it to drag.
  laterId = (
    await prisma.task.create({
      data: {
        workspaceId,
        boardId,
        sectionId,
        title: `MyWork later ${RUN}`,
        assigneeId: runnerId,
        dueAt: inDays(14),
        position: 2048,
      },
    })
  ).id;
});

test.afterAll(async () => {
  await prisma.task.deleteMany({ where: { title: { contains: `MyWork` } } });
  await prisma.taskSection.deleteMany({ where: { boardId } });
  await prisma.taskBoard.deleteMany({ where: { id: boardId } });
  await prisma.undoEntry.deleteMany({ where: { workspaceId } });
  await prisma.$disconnect();
});

/**
 * My Work (playbook-v5 P18/1).
 *
 * The bucketing rules are proved in test/unit/work-buckets.test.ts, including
 * that they cannot disagree with the dashboard's. What only a browser shows is
 * that the loose task is THERE — a board-shaped screen cannot show it — and
 * that dragging between buckets really rewrites the due date.
 */
test("a task with no board appears, and is marked as ours rather than theirs", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&v=mine`);
  await expect(page.getByTestId("my-work")).toBeVisible({ timeout: 20_000 });

  const loose = page.getByTestId("my-work-row").filter({ hasText: `MyWork loose ${RUN}` });
  await expect(loose).toHaveCount(1);
  // Marked as loose, so it is obvious it belongs to no board…
  await expect(loose.getByTestId("my-work-loose")).toBeVisible();
  // …and as raised automatically, so a person's own work is distinguishable.
  await expect(loose.getByTestId("my-work-source")).toBeVisible();

  // And the board task names its board.
  const onBoard = page.getByTestId("my-work-row").filter({ hasText: `MyWork today ${RUN}` });
  await expect(onBoard.getByTestId("my-work-board")).toContainText(BOARD);
});

/**
 * THE ONE THE PLAYBOOK ASKS FOR: dragging from Later to Today sets today's
 * date, and the change is undoable.
 */
test("dragging into Today sets today's date, undoably", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&v=mine`);
  await expect(page.getByTestId("my-work")).toBeVisible({ timeout: 20_000 });

  const row = page.getByTestId("my-work-row").filter({ hasText: `MyWork later ${RUN}` });
  await expect(row).toHaveCount(1);
  // By its data attribute, not by heading text: "Today" also appears inside
  // the bucket's own rule sentence, and matching text picked the wrong section.
  const todayGroup = page.locator('[data-bucket="today"]');
  await expect(todayGroup).toHaveCount(1);

  /**
   * The drag is dispatched rather than mimed with the mouse.
   *
   * `dragTo` scrolls the TARGET into view before pressing, and Today sits
   * above Later — so the source moved out from under the captured press point
   * and the drop carried a different row's id. A probe caught it moving an
   * unrelated leftover task, which is a test that would have "passed" for the
   * wrong reason just as easily.
   *
   * One shared DataTransfer across dragstart → dragover → drop is exactly what
   * a browser does, so this still exercises the real handlers — including the
   * id travelling in dataTransfer, which is the thing that made the drop
   * survive a mid-drag re-render.
   */
  await page.evaluate(
    ({ taskId }) => {
      const source = document.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
      const target = document.querySelector<HTMLElement>('[data-bucket="today"]');
      if (!source || !target) throw new Error("drag endpoints not found");
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer }));
      source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
    },
    { taskId: laterId },
  );

  await expect
    .poll(
      async () => {
        const t = await prisma.task.findUnique({ where: { id: laterId } });
        return t!.dueAt ? t!.dueAt.toDateString() : null;
      },
      { timeout: 20_000 },
    )
    .toBe(new Date().toDateString());

  // Undoable — a drag is the easiest thing in the product to do by accident.
  const toast = page.getByTestId("toast");
  await expect(toast).toBeVisible();
  await toast.getByTestId("undo-button").click();
  await expect
    .poll(
      async () => {
        const t = await prisma.task.findUnique({ where: { id: laterId } });
        return t!.dueAt ? t!.dueAt.toDateString() : null;
      },
      { timeout: 20_000 },
    )
    .not.toBe(new Date().toDateString());
});

/** Overdue is not a destination: nobody means "make this late". */
test("the Overdue bucket says it cannot be dropped into", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&v=mine`);
  await expect(page.getByTestId("my-work")).toBeVisible({ timeout: 20_000 });

  const overdue = page.locator('[data-bucket="overdue"]');
  await expect(overdue.getByTestId("bucket-rule")).toContainText(/cannot move work into it/i);
});

/** The grouping toggle regroups without losing anything. */
test("grouping by board keeps every row, and names the loose one", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&v=mine`);
  await expect(page.getByTestId("my-work")).toBeVisible({ timeout: 20_000 });

  const before = await page.getByTestId("my-work-row").count();
  await page.getByTestId("my-work-group-board").click();
  await expect(page.getByTestId("my-work-group-board")).toHaveAttribute("aria-pressed", "true");
  expect(await page.getByTestId("my-work-row").count()).toBe(before);

  await expect(
    page.getByTestId("my-work-group").filter({ hasText: "Loose — no board" }),
  ).toHaveCount(1);
});

/**
 * And completing a loose task from here behaves exactly as completing it from
 * the lead would: one write, undoable, and it leaves the list.
 */
test("completing a loose task from My Work works like anywhere else", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&v=mine`);
  await expect(page.getByTestId("my-work")).toBeVisible({ timeout: 20_000 });

  const loose = page.getByTestId("my-work-row").filter({ hasText: `MyWork loose ${RUN}` });
  await loose.getByTestId("my-work-complete").click();

  await expect
    .poll(async () => (await prisma.task.findUnique({ where: { id: looseId } }))!.doneAt, {
      timeout: 20_000,
    })
    .not.toBeNull();
  await expect(loose).toHaveCount(0, { timeout: 20_000 });
});
