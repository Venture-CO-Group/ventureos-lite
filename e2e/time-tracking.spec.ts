import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RUN = String(Date.now());
const BOARD = `E2E Time Board ${RUN}`;
let workspaceId = "";
let boardId = "";
let sectionId = "";
let parentId = "";
let runnerId = "";

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

  parentId = (
    await prisma.task.create({
      data: { workspaceId, boardId, sectionId, title: `Time parent ${RUN}`, position: 1024 },
    })
  ).id;
  // Two subtasks with estimates, so the roll-up has something to sum.
  for (const minutes of [120, 90]) {
    await prisma.task.create({
      data: {
        workspaceId,
        boardId,
        sectionId,
        title: `Time sub ${minutes} ${RUN}`,
        parentId,
        estimateMinutes: minutes,
      },
    });
  }
});

test.afterAll(async () => {
  await prisma.timeEntry.deleteMany({ where: { workspaceId } });
  await prisma.task.deleteMany({ where: { boardId } });
  await prisma.taskSection.deleteMany({ where: { boardId } });
  await prisma.taskBoard.deleteMany({ where: { id: boardId } });
  await prisma.$disconnect();
});

async function openParent(page: import("@playwright/test").Page) {
  await page.goto(`/tasks?board=${boardId}&task=${parentId}`);
  await expect(page.getByTestId("task-time")).toBeVisible({ timeout: 20_000 });
}

/**
 * Estimates and time (playbook-v5 P20/1).
 *
 * The arithmetic and the database guarantees are covered in
 * test/unit/time-logic.test.ts and test/integration/time-tracking.test.ts.
 * What only a browser shows is that a timer SURVIVES A RELOAD — the thing that
 * makes it a database row rather than component state — and that both
 * estimates are on screen at once.
 */
test("a running timer survives a reload", async ({ page }) => {
  await openParent(page);

  await page.getByTestId("timer-start").click();
  await expect(page.getByTestId("timer-stop")).toBeVisible({ timeout: 15_000 });

  await expect
    .poll(
      async () =>
        prisma.timeEntry.count({ where: { taskId: parentId, userId: runnerId, endedAt: null } }),
      { timeout: 15_000 },
    )
    .toBe(1);

  // The whole point: it is a row, not state.
  await page.reload();
  await expect(page.getByTestId("timer-stop")).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("timer-stop").click();
  await expect(page.getByTestId("timer-start")).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () =>
        prisma.timeEntry.count({ where: { taskId: parentId, endedAt: null } }),
      { timeout: 15_000 },
    )
    .toBe(0);
});

/**
 * Both estimates on screen, with the one in use marked — the playbook asks for
 * exactly this, because four hours whose subtasks add to three and a half is a
 * disagreement worth seeing.
 */
test("a parent shows its own estimate and its subtasks' sum, and says which is in use", async ({
  page,
}) => {
  await openParent(page);

  // With nothing typed, the roll-up is in use: 2h + 1.5h.
  const readout = page.getByTestId("estimate-readout");
  await expect(readout).toContainText("3.5h", { timeout: 15_000 });
  await expect(readout).toContainText(/from its subtasks/i);

  // Typing one takes over, and the sum is still reported beside it.
  await page.getByTestId("task-estimate").fill("4");
  await page.getByTestId("task-estimate").blur();
  await expect(readout).toContainText(/typed here/i, { timeout: 15_000 });
  await expect(readout).toContainText("4h");
  await expect(readout).toContainText("3.5h");

  await expect
    .poll(
      async () => (await prisma.task.findUnique({ where: { id: parentId } }))!.estimateMinutes,
      { timeout: 15_000 },
    )
    .toBe(240);
});

test("time can be logged by hand and removed again", async ({ page }) => {
  // From a clean slate: the timer test above leaves a closed entry on this
  // task, and asserting "then there were none" needs to start from none.
  await prisma.timeEntry.deleteMany({ where: { taskId: parentId } });
  await openParent(page);

  await page.getByTestId("manual-hours").fill("1h30");
  await page.getByTestId("manual-note").fill("Reading the brief");
  await page.getByTestId("manual-log").click();

  await expect(page.getByTestId("time-entries")).toContainText("1.5h", { timeout: 15_000 });
  await expect(page.getByTestId("task-actual")).toContainText("1.5h");

  // Removable by the person who logged it.
  const remove = page.getByTestId("time-entry-remove").first();
  await expect(remove).toBeVisible({ timeout: 15_000 });
  await remove.click();
  await expect
    .poll(async () => prisma.timeEntry.count({ where: { taskId: parentId } }), { timeout: 15_000 })
    .toBe(0);
});

/** A nonsense estimate is refused rather than stored as zero. */
test("an estimate that is not a duration is refused", async ({ page }) => {
  await openParent(page);
  await page.getByTestId("task-estimate").fill("soon");
  await page.getByTestId("task-estimate").blur();
  await expect(page.getByTestId("toast")).toContainText(/1.5, 90m, or 1h30/i, { timeout: 15_000 });
});

/**
 * And the board report leads with its COVERAGE, because a variance computed
 * from three of forty estimates is a number somebody might price from.
 */
test("the board report says how much of the board is estimated", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}`);
  await expect(page.getByTestId("time-report")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("board-coverage")).toContainText(/of \d+ task/);
  await expect(page.getByTestId("my-week-total")).toBeVisible();
});
