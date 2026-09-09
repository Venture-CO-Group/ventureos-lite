import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RUN = String(Date.now());
const BOARD = `E2E Calendar Board ${RUN}`;
let workspaceId = "";
let boardId = "";
let sectionId = "";
let leadId = "";
let taskId = "";
let unscheduledId = "";

/** Local noon, N days from today. */
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(12, 0, 0, 0);
  return d;
};
/** Local YYYY-MM-DD, matching the component's day keys. */
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

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

  const company = await prisma.company.create({
    data: { workspaceId, name: `Cal Co ${RUN}` },
  });
  leadId = (
    await prisma.lead.create({
      data: { workspaceId, contactName: `Cal Lead ${RUN}`, companyId: company.id },
    })
  ).id;

  taskId = (
    await prisma.task.create({
      data: {
        workspaceId,
        boardId,
        sectionId,
        title: `Cal task ${RUN}`,
        dueAt: day(1),
        position: 1024,
      },
    })
  ).id;

  unscheduledId = (
    await prisma.task.create({
      data: {
        workspaceId,
        boardId,
        sectionId,
        title: `Cal undated ${RUN}`,
        position: 2048,
      },
    })
  ).id;

  // The two overlays: a meeting and an outstanding callback.
  await prisma.meeting.create({
    data: { workspaceId, leadId, scheduledAt: day(2), type: "discovery" },
  });
  await prisma.call.create({
    data: { workspaceId, leadId, outcome: "NO_ANSWER", callbackAt: day(2) },
  });
});

test.afterAll(async () => {
  await prisma.call.deleteMany({ where: { leadId } });
  await prisma.meeting.deleteMany({ where: { leadId } });
  await prisma.task.deleteMany({ where: { boardId } });
  await prisma.taskSection.deleteMany({ where: { boardId } });
  await prisma.taskBoard.deleteMany({ where: { id: boardId } });
  await prisma.lead.deleteMany({ where: { id: leadId } });
  await prisma.company.deleteMany({ where: { name: `Cal Co ${RUN}` } });
  await prisma.undoEntry.deleteMany({ where: { workspaceId } });
  await prisma.$disconnect();
});

/** One shared DataTransfer through the real handlers — see e2e/my-work.spec.ts. */
async function dragItemToDay(
  page: import("@playwright/test").Page,
  itemId: string,
  dayIso: string,
) {
  await page.evaluate(
    ({ itemId, dayIso }) => {
      const source = document.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`);
      const target = document.querySelector<HTMLElement>(`[data-day="${dayIso}"]`);
      if (!source || !target) throw new Error("drag endpoints not found");
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer }));
      source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
    },
    { itemId, dayIso },
  );
}

/**
 * The calendar (playbook-v5 P19/2).
 *
 * Its geometry is proved in test/unit/task-calendar.test.ts — 19 tests over
 * month grids, Monday-first weeks and local-day placement. What only a browser
 * shows is that the overlays are separately switchable and that a drag reaches
 * the database.
 */
test("tasks, meetings and callbacks all appear, and each overlay can be switched off", async ({
  page,
}) => {
  await page.goto(`/tasks?board=${boardId}&v=calendar`);
  await expect(page.getByTestId("task-calendar")).toBeVisible({ timeout: 20_000 });

  await expect(page.getByTestId("calendar-item-task").first()).toBeVisible();
  await expect(page.getByTestId("calendar-item-meeting").first()).toBeVisible();
  await expect(page.getByTestId("calendar-item-callback").first()).toBeVisible();

  // Each one off on its own — the reason they are separate lists.
  await page.getByTestId("calendar-overlay-meetings").uncheck();
  await expect(page.getByTestId("calendar-item-meeting")).toHaveCount(0);
  await expect(page.getByTestId("calendar-item-callback").first()).toBeVisible();

  await page.getByTestId("calendar-overlay-callbacks").uncheck();
  await expect(page.getByTestId("calendar-item-callback")).toHaveCount(0);
  // Tasks are not an overlay — they are the calendar.
  await expect(page.getByTestId("calendar-item-task").first()).toBeVisible();
});

test("dragging a task onto a day reschedules it, undoably", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&v=calendar`);
  await expect(page.getByTestId("task-calendar")).toBeVisible({ timeout: 20_000 });

  // The grid renders before its items arrive, so the source has to be waited
  // for — dispatching the drag earlier failed with "endpoints not found".
  await expect(page.locator(`[data-item-id="${taskId}"]`)).toBeVisible({ timeout: 20_000 });
  const before = await prisma.task.findUnique({ where: { id: taskId } });

  /**
   * The target comes from a RENDERED cell rather than from `day(4)`.
   *
   * Four days out is not necessarily on screen — near the end of a month it
   * lands in a row the grid may or may not include — so the test was asserting
   * against a day it could not always drop on. Reading the attribute means the
   * target is always a cell that exists.
   */
  const cells = page.getByTestId("calendar-day");
  const targetIso = (await cells.nth(await cells.count() - 2).getAttribute("data-day"))!;
  expect(targetIso).not.toBe(iso(before!.dueAt!));
  await dragItemToDay(page, taskId, targetIso);

  await expect
    .poll(
      async () => {
        const t = await prisma.task.findUnique({ where: { id: taskId } });
        return t!.dueAt ? iso(t!.dueAt) : null;
      },
      { timeout: 20_000 },
    )
    .toBe(targetIso);

  const toast = page.getByTestId("toast");
  await expect(toast).toBeVisible();
  await toast.getByTestId("undo-button").click();
  await expect
    .poll(
      async () => {
        const t = await prisma.task.findUnique({ where: { id: taskId } });
        return t!.dueAt ? iso(t!.dueAt) : null;
      },
      { timeout: 20_000 },
    )
    .toBe(iso(before!.dueAt!));
});

/**
 * The side rail is the answer to "what have I not scheduled" — work with no
 * date has nowhere else to appear on a calendar.
 */
test("week view offers the undated work, and dropping it gives it a date", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&v=calendar`);
  await expect(page.getByTestId("task-calendar")).toBeVisible({ timeout: 20_000 });

  // The rail is week-view only: a month grid has no room for it.
  await expect(page.getByTestId("calendar-unscheduled")).toHaveCount(0);
  await page.getByTestId("calendar-mode-week").click();

  const rail = page.getByTestId("calendar-unscheduled");
  await expect(rail).toBeVisible({ timeout: 20_000 });
  await expect(rail).toContainText(`Cal undated ${RUN}`);
  await expect(page.locator(`[data-item-id="${unscheduledId}"]`)).toBeVisible();

  // Drop it on a day inside the visible week.
  const dayCell = page.getByTestId("calendar-day").first();
  const dayIso = (await dayCell.getAttribute("data-day"))!;
  await dragItemToDay(page, unscheduledId, dayIso);

  await expect
    .poll(async () => (await prisma.task.findUnique({ where: { id: unscheduledId } }))!.dueAt, {
      timeout: 20_000,
    })
    .not.toBeNull();
});

test("the month and week titles move with the arrows", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&v=calendar`);
  await expect(page.getByTestId("task-calendar")).toBeVisible({ timeout: 20_000 });

  const title = page.getByTestId("calendar-title");
  const first = await title.textContent();
  await page.getByTestId("calendar-next").click();
  await expect(title).not.toHaveText(first!);
  await page.getByTestId("calendar-today").click();
  await expect(title).toHaveText(first!);
});
