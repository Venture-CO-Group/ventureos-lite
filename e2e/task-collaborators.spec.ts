import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";


const prisma = new PrismaClient();
const RUN = String(Date.now());
/** The signed-in runner, as e2e/auth.setup.ts creates it. */
const RUNNER_EMAIL = "e2e-runner@ventureco.test";
const HELPER_ID = `e2e-helper-${RUN}`;
let workspaceId = "";
let boardId = "";
let sectionId = "";
let ownTaskId = "";
let helpingTaskId = "";
let runnerId = "";

test.describe.configure({ mode: "serial" });

/**
 * Set a checkbox, idempotently.
 *
 * `check()` clicks once and then asserts, which fails outright when the click
 * lands before React has hydrated — the box is a controlled input, so a click
 * nothing is listening for changes nothing. Clicking only when the state is
 * wrong makes the retry safe: a second attempt cannot toggle it back.
 */
async function setToggle(box: import("@playwright/test").Locator, on: boolean) {
  await expect(async () => {
    if ((await box.isChecked()) !== on) await box.click();
    expect(await box.isChecked()).toBe(on);
  }).toPass({ timeout: 45_000 });
}

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  runnerId = (await prisma.user.findFirstOrThrow({ where: { email: RUNNER_EMAIL } })).id;

  // A second member, so "handed over by somebody" and "helping with somebody
  // else's task" are real relationships rather than the runner talking to
  // itself.
  await prisma.user.upsert({
    where: { id: HELPER_ID },
    update: {},
    create: {
      id: HELPER_ID,
      name: `E2E Helper ${RUN}`,
      email: `${HELPER_ID}@example.test`,
      passwordHash: "x",
    },
  });
  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: HELPER_ID, workspaceId } },
    update: {},
    create: { userId: HELPER_ID, workspaceId, role: "BDR" },
  });

  const board = await prisma.taskBoard.create({
    data: {
      workspaceId,
      name: `E2E Collab Board ${RUN}`,
      sections: { create: [{ workspaceId, name: "Doing", position: 1024 }] },
    },
    include: { sections: true },
  });
  boardId = board.id;
  sectionId = board.sections[0]!.id;

  ownTaskId = (
    await prisma.task.create({
      data: {
        workspaceId,
        boardId,
        sectionId,
        title: `Owned task ${RUN}`,
        assigneeId: runnerId,
        position: 1024,
      },
    })
  ).id;

  // Somebody else's task, with the runner helping: this is what the My Work
  // toggle is for.
  helpingTaskId = (
    await prisma.task.create({
      data: {
        workspaceId,
        boardId,
        sectionId,
        title: `Helping task ${RUN}`,
        assigneeId: HELPER_ID,
        position: 2048,
      },
    })
  ).id;
  await prisma.taskCollaborator.create({
    data: { workspaceId, taskId: helpingTaskId, userId: runnerId, addedBy: HELPER_ID },
  });
});

test.afterAll(async () => {
  await prisma.taskEvent.deleteMany({ where: { taskId: { in: [ownTaskId, helpingTaskId] } } });
  await prisma.taskCollaborator.deleteMany({
    where: { taskId: { in: [ownTaskId, helpingTaskId] } },
  });
  await prisma.task.deleteMany({ where: { boardId } });
  await prisma.taskSection.deleteMany({ where: { boardId } });
  await prisma.taskBoard.deleteMany({ where: { id: boardId } });
  await prisma.membership.deleteMany({ where: { userId: HELPER_ID } });
  await prisma.user.deleteMany({ where: { id: HELPER_ID } });
  await prisma.$disconnect();
});

/**
 * Collaborators and delegation (playbook-v5 P20/6).
 *
 * The point of driving these through a browser is the distinction: one owner
 * on the card, the people helping in their own list, and a handover that is
 * written down where somebody can read it.
 */
test("a collaborator is added, appears in the assignee picker's own group, and is on the trail", async ({
  page,
}) => {
  await page.goto(`/tasks?board=${boardId}&task=${ownTaskId}`);
  const people = page.getByTestId("task-people");
  await expect(people).toBeVisible({ timeout: 20_000 });

  // The panel states which relationship is which — without it, two lists of
  // names read as "everybody is responsible".
  await expect(people).toContainText(/One person owns this task/i);
  await expect(people).toContainText(/followers only watch/i);

  await people.getByTestId("collaborator-add").selectOption(HELPER_ID);
  await expect(people.getByTestId("collaborator")).toHaveCount(1);
  await expect(people.getByTestId("collaborator")).toContainText(`E2E Helper ${RUN}`);

  // The assignee picker now groups them: the person already helping is
  // usually the person it goes to next.
  const picker = page.getByTestId("detail-assignee");
  await expect(picker.locator('optgroup[label="Working on it"]')).toHaveCount(1);
  await expect(picker.locator('optgroup[label="Working on it"] option')).toHaveText([
    `E2E Helper ${RUN}`,
  ]);

  // And it is on the trail.
  await people.getByTestId("task-trail-toggle").click();
  await expect(people.getByTestId("task-trail")).toContainText(
    `added E2E Helper ${RUN} as a collaborator`,
  );
});

test("handing the task over records who did it", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}&task=${ownTaskId}`);
  await expect(page.getByTestId("detail-assignee")).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("detail-assignee").selectOption(HELPER_ID);

  await expect
    .poll(async () => (await prisma.task.findUnique({ where: { id: ownTaskId } }))!.delegatedBy, {
      timeout: 20_000,
    })
    .toBe(runnerId);

  const events = await prisma.taskEvent.findMany({
    where: { taskId: ownTaskId },
    orderBy: { at: "desc" },
  });
  expect(events[0]).toMatchObject({ kind: "delegated", userId: HELPER_ID, actorUserId: runnerId });

  // The panel says so, in words, where the handover is visible.
  await page.reload();
  await expect(page.getByTestId("task-delegated-by")).toContainText("handed over by");
});

test("My Work shows what I own, and what I am helping with only when asked", async ({ page }) => {
  /**
   * Generous, because the first visit to this view in a `next dev` run
   * compiles it: the toggle is a controlled checkbox, so a click that lands
   * before hydration changes nothing, and the wait is for the bundle rather
   * than for anything the product does slowly.
   */
  test.setTimeout(120_000);
  await page.goto(`/tasks?board=${boardId}&v=mine`);
  const work = page.getByTestId("my-work");
  await expect(work).toBeVisible({ timeout: 20_000 });

  // The previous test handed the owned task away, so what is left of mine is
  // nothing on this board — but the helping task must not be here either.
  await expect(work).not.toContainText(`Helping task ${RUN}`);

  await setToggle(work.getByTestId("my-work-collaborating"), true);
  const row = work.getByTestId("my-work-row").filter({ hasText: `Helping task ${RUN}` });
  await expect(row).toBeVisible({ timeout: 20_000 });
  // And it says somebody else owns it, rather than reading as work I owe.
  await expect(row.getByTestId("my-work-collaborator")).toContainText("helping");

  // Off again, and it goes.
  await setToggle(work.getByTestId("my-work-collaborating"), false);
  await expect(
    work.getByTestId("my-work-row").filter({ hasText: `Helping task ${RUN}` }),
  ).toHaveCount(0);
});
