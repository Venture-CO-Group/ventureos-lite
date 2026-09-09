import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RUN = String(Date.now());
const BOARD = `E2E Timeline Board ${RUN}`;
let workspaceId = "";
let boardId = "";
let sectionId = "";
let barId = "";
let milestoneId = "";
let dependentId = "";

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(12, 0, 0, 0);
  return d;
};

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
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

  // A real bar: both dates.
  barId = (
    await prisma.task.create({
      data: {
        workspaceId,
        boardId,
        sectionId,
        title: `Timeline bar ${RUN}`,
        startAt: day(1),
        dueAt: day(5),
        position: 1024,
      },
    })
  ).id;

  /** Due date only — this must render as a diamond, never as an invented bar. */
  milestoneId = (
    await prisma.task.create({
      data: {
        workspaceId,
        boardId,
        sectionId,
        title: `Timeline milestone ${RUN}`,
        dueAt: day(7),
        position: 2048,
      },
    })
  ).id;

  // A dependent that starts before the bar ends, so a move breaks it.
  dependentId = (
    await prisma.task.create({
      data: {
        workspaceId,
        boardId,
        sectionId,
        title: `Timeline dependent ${RUN}`,
        startAt: day(4),
        dueAt: day(9),
        position: 3072,
      },
    })
  ).id;
  await prisma.taskDependency.create({
    data: { workspaceId, taskId: dependentId, blockedById: barId },
  });
});

test.afterAll(async () => {
  await prisma.taskDependency.deleteMany({ where: { workspaceId } });
  await prisma.task.deleteMany({ where: { boardId } });
  await prisma.taskSection.deleteMany({ where: { boardId } });
  await prisma.taskBoard.deleteMany({ where: { id: boardId } });
  await prisma.undoEntry.deleteMany({ where: { workspaceId } });
  await prisma.$disconnect();
});

/**
 * The timeline (playbook-v5 P19/1).
 *
 * The arithmetic is proved in test/unit/task-timeline.test.ts, where 29 tests
 * cover bar geometry, snapping, resize floors, DST and virtualization. What
 * only a browser shows is that the two KINDS render differently and that a
 * drag reaches the database.
 */
test("a task with only a due date is a diamond, and never gains a start date", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&v=timeline`);
  await expect(page.getByTestId("task-timeline")).toBeVisible({ timeout: 20_000 });

  await expect(page.locator(`[data-testid="timeline-bar"][data-task-id="${barId}"]`)).toHaveCount(1);
  await expect(
    page.locator(`[data-testid="timeline-milestone"][data-task-id="${milestoneId}"]`),
  ).toHaveCount(1);

  // The important half: rendering it did not write a start date.
  const milestone = await prisma.task.findUnique({ where: { id: milestoneId } });
  expect(milestone!.startAt).toBeNull();
});

test("the today marker and the zoom levels are there", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&v=timeline`);
  await expect(page.getByTestId("task-timeline")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("timeline-today")).toBeVisible();

  await page.getByTestId("timeline-zoom-day").click();
  await expect(page.getByTestId("timeline-zoom-day")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("timeline-zoom-month").click();
  await expect(page.getByTestId("timeline-zoom-month")).toHaveAttribute("aria-pressed", "true");
});

/**
 * NEVER CASCADE SILENTLY. Moving a blocker must report the dependents it broke
 * and offer a shift, not rewrite their dates.
 */
test("moving a blocker offers to shift its dependents rather than doing it", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&v=timeline`);
  await expect(page.getByTestId("task-timeline")).toBeVisible({ timeout: 20_000 });

  const dependentBefore = await prisma.task.findUnique({ where: { id: dependentId } });

  // Drag the bar four days later, through the real pointer handlers.
  const bar = page.locator(`[data-testid="timeline-bar"][data-task-id="${barId}"]`);
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 4 * 18, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();

  await expect
    .poll(async () => (await prisma.task.findUnique({ where: { id: barId } }))!.dueAt!.getDate(), {
      timeout: 20_000,
    })
    .not.toBe(dependentBefore!.dueAt!.getDate());

  // It ASKED. The dependent has not moved.
  const offer = page.getByTestId("timeline-broken");
  await expect(offer).toBeVisible({ timeout: 20_000 });
  await expect(offer).toContainText(`Timeline dependent ${RUN}`);
  const dependentStill = await prisma.task.findUnique({ where: { id: dependentId } });
  expect(dependentStill!.startAt!.getTime()).toBe(dependentBefore!.startAt!.getTime());

  // Confirming moves the chain, in one undoable step.
  await page.getByTestId("timeline-shift-dependents").click();
  await expect
    .poll(
      async () => (await prisma.task.findUnique({ where: { id: dependentId } }))!.startAt!.getTime(),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(dependentBefore!.startAt!.getTime());
});

/**
 * VIRTUALIZATION, as a claim that can fail.
 *
 * The playbook asks that a board with hundreds of tasks stays smooth. That is
 * only true if the chart renders a window rather than every bar, so this seeds
 * 500 and counts what is actually in the DOM. (The cycle refusal naming the
 * chain is proved in test/integration/timeline.test.ts, where the action can
 * be called against the database — an earlier version of this test imported
 * the pure function into the browser and asserted on it, which proved nothing
 * about the action.)
 */
test("500 tasks render a window, not five hundred bars", async ({ page }) => {
  const many = Array.from({ length: 500 }, (_, i) => ({
    workspaceId,
    boardId,
    sectionId,
    title: `Bulk timeline ${i} ${RUN}`,
    startAt: day(i % 60),
    dueAt: day((i % 60) + 2),
    position: 10_000 + i,
  }));
  await prisma.task.createMany({ data: many });

  try {
    await page.goto(`/tasks?board=${boardId}&v=timeline`);
    await expect(page.getByTestId("task-timeline")).toBeVisible({ timeout: 30_000 });

    const bars = await page.getByTestId("timeline-bar").count();
    expect(bars).toBeGreaterThan(0);
    // A window with overscan, not the whole board.
    expect(bars).toBeLessThan(60);
  } finally {
    await prisma.task.deleteMany({ where: { title: { contains: `Bulk timeline` } } });
  }
});

/** Below ~900px it is a read-only list, which is what a phone wants. */
test("a narrow screen gets the list instead of a cramped chart", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/tasks?board=${boardId}&v=timeline`);
  await expect(page.getByTestId("timeline-narrow")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("task-timeline")).toHaveCount(0);
  await expect(page.getByTestId("timeline-narrow")).toContainText(`Timeline bar ${RUN}`);
});
