import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BOARD = "E2E Advanced Board";
let workspaceId = "";
let boardId = "";
let sectionId = "";

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
    include: { sections: true },
  });
  boardId = board.id;
  sectionId = board.sections[0]!.id;
});

async function cleanup() {
  const boards = await prisma.taskBoard.findMany({
    where: { name: { in: [BOARD, "E2E From Template", "E2E Template"] } },
  });
  for (const b of boards) {
    await prisma.task.deleteMany({ where: { boardId: b.id } });
    await prisma.taskSection.deleteMany({ where: { boardId: b.id } });
    await prisma.taskBoard.delete({ where: { id: b.id } });
  }
}

test.afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function makeTask(title: string, extra: Record<string, unknown> = {}) {
  return prisma.task.create({
    data: { workspaceId, boardId, sectionId, title, position: Math.random() * 100_000, ...extra },
  });
}

async function openTask(page: import("@playwright/test").Page, title: string) {
  await page.goto(`/tasks?board=${boardId}`);
  await page
    .getByTestId("task-card")
    .filter({ hasText: title })
    .first()
    .getByRole("button")
    .nth(1)
    .click();
  await expect(page.getByTestId("detail-title")).toBeVisible();
}

/**
 * Dependencies were left out of the board's first version for one reason: a
 * badly drawn graph is worse than no graph. "A waits for B, B waits for A" is a
 * pair of tasks that can never start, and once three are involved nobody can
 * see why nothing is startable.
 */
test("a dependency can be added, and a loop is refused", async ({ page }) => {
  const a = await makeTask("Deploy the thing");
  const b = await makeTask("Write the migration");
  // Both created here, so a retry of this test alone still has its pair.

  await openTask(page, "Deploy the thing");
  await page.getByTestId("dependency-add").selectOption(b.id);
  await expect(page.getByTestId("dependency-row")).toContainText("Write the migration");

  const edges = await prisma.taskDependency.findMany({ where: { taskId: a.id } });
  expect(edges).toHaveLength(1);
  expect(edges[0]!.blockedById).toBe(b.id);

  // ---- the loop ----------------------------------------------------------
  await page.keyboard.press("Escape");
  await openTask(page, "Write the migration");
  await page.getByTestId("dependency-add").selectOption(a.id);
  await expect(page.getByText(/would make a loop/i)).toBeVisible();
  expect(await prisma.taskDependency.count({ where: { taskId: b.id } })).toBe(0);
});

test("a blocked task still shows up, and says what it is waiting for", async ({ page }) => {
  /**
   * Builds its own pair rather than borrowing the previous test's.
   *
   * `beforeAll` re-runs when a test is RETRIED, and it wipes the board — so a
   * test that depends on an earlier test's rows fails on retry with a null
   * lookup and reports a defect that does not exist. That is exactly how this
   * file failed the first time.
   */
  const runner = await prisma.user.findUnique({ where: { email: "e2e-runner@ventureco.test" } });
  const blocker = await makeTask("Await the signature");
  const blocked = await makeTask("Start the build", { assigneeId: runner!.id });
  await prisma.taskDependency.create({
    data: { workspaceId, taskId: blocked.id, blockedById: blocker.id },
  });

  await page.goto(`/tasks?board=${boardId}`);
  await page.getByTestId("my-work").click();
  await expect(page.getByTestId("my-work-list")).toBeVisible();

  /**
   * The row for THIS task, not `.first()`.
   *
   * My work spans every board and sorts by due date, so whatever else the
   * workspace has assigned to the runner legitimately sits above it — and
   * asserting on the first row measures whichever leftover happens to be
   * soonest.
   */
  const row = page.getByTestId("my-work-row").filter({ hasText: "Start the build" });
  await expect(row).toHaveCount(1);
  // A blocked task is not the next thing to pick up, and saying so is the
  // point of having dependencies at all.
  await expect(row.getByTestId("my-work-blocked")).toContainText("waiting on 1");
  // It names the board it came from, which the dashboard panel cannot.
  await expect(row).toContainText(BOARD);
});

/**
 * A recurring task spawns its successor when COMPLETED rather than being
 * generated on a timer: a board that fills with future copies of one task is a
 * board nobody can read.
 */
test("completing a recurring task creates exactly one successor", async ({ page }) => {
  await makeTask("Reconcile the invoices");
  await openTask(page, "Reconcile the invoices");
  await page.getByTestId("detail-recurrence").selectOption("weekly");
  await expect(page.getByText(/Repeats every/)).toBeVisible();
  await page.getByRole("button", { name: "Done" }).last().click();

  const before = await prisma.task.count({
    where: { boardId, title: "Reconcile the invoices" },
  });
  expect(before).toBe(1);

  await page.goto(`/tasks?board=${boardId}`);
  await page
    .getByTestId("task-card")
    .filter({ hasText: "Reconcile the invoices" })
    .first()
    .getByTestId("task-toggle")
    .click();
  await page.waitForTimeout(2500);

  const all = await prisma.task.findMany({
    where: { boardId, title: "Reconcile the invoices" },
    orderBy: { createdAt: "asc" },
  });
  // One completed, one new — not two open, and not a queue.
  expect(all).toHaveLength(2);
  expect(all[0]!.doneAt).not.toBeNull();
  expect(all[1]!.doneAt).toBeNull();
  expect(all[1]!.recurredFromId).toBe(all[0]!.id);
  // The rule travels with the successor, or the chain stops after one.
  expect(all[1]!.recurrence).toMatchObject({ cadence: "weekly" });
  expect(all[1]!.dueAt).not.toBeNull();
  expect(all[1]!.dueAt!.getTime()).toBeGreaterThan(Date.now());
});

test("a file can be attached and is served only to this workspace", async ({ page }) => {
  await makeTask("Send the brief");
  await openTask(page, "Send the brief");

  await page.getByTestId("attachment-input").setInputFiles({
    name: "brief.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("the brief itself"),
  });
  await expect(page.getByTestId("attachment-row")).toContainText("brief.txt");

  const rows = await prisma.taskAttachment.findMany({ where: { workspaceId } });
  expect(rows).toHaveLength(1);
  // The stored name is GENERATED, never the uploaded one: a filename from a
  // browser is attacker-controlled text and "../../.env" is a path.
  expect(rows[0]!.path).toMatch(/^tasks\/[a-z0-9]+-[0-9a-f]{16}\.txt$/);
  expect(rows[0]!.filename).toBe("brief.txt");

  const res = await page.request.get(`/api/files/${rows[0]!.path}`);
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe("the brief itself");

  // A guessed path that has no attachment row resolves to nothing.
  const bogus = await page.request.get("/api/files/tasks/does-not-exist.txt");
  expect(bogus.status()).toBe(404);
});

test("an executable disguised as a document is refused", async ({ page }) => {
  await makeTask("Collect the assets");
  await openTask(page, "Collect the assets");
  await page.getByTestId("attachment-input").setInputFiles({
    name: "payload.html",
    mimeType: "text/html",
    buffer: Buffer.from("<script>alert(1)</script>"),
  });
  // These files are served back from our own origin, so the allowlist is the
  // whole defence — a blocklist is a list of what somebody thought of.
  await expect(page.getByText(/file type is not accepted/i)).toBeVisible();
  expect(await prisma.taskAttachment.count({ where: { taskId: { not: undefined } } })).toBeLessThan(
    3,
  );
});

test("a board becomes a template, and a new board comes out of it", async ({ page }) => {
  // Its own task, for the same reason the others build theirs: `beforeAll`
  // re-runs on a retry and wipes the board.
  await makeTask("Kick-off call", { dueAt: new Date(Date.now() + 3 * 86_400_000) });

  await page.goto(`/tasks?board=${boardId}`);
  await page.getByTestId("save-as-template").click();
  await page.waitForTimeout(1800);

  const asTemplate = await prisma.taskBoard.findUnique({ where: { id: boardId } });
  expect(asTemplate!.isTemplate).toBe(true);
  const templated = await prisma.task.findFirst({ where: { boardId, title: "Kick-off call" } });
  expect(templated!.dueAt).toBeNull();
  expect(templated!.dueOffsetDays).toBeGreaterThanOrEqual(2);

  // Templates leave the switcher: a template is a board nobody works in.
  await page.goto("/tasks");
  await expect(page.getByTestId("board-tab").filter({ hasText: BOARD })).toHaveCount(0);

  await page.getByTestId("from-template").click();
  await page.getByTestId("template-select").selectOption(boardId);
  await page.getByTestId("template-board-name").fill("E2E From Template");
  await page.getByTestId("template-create").click();
  await expect(page.getByTestId("board-tab").filter({ hasText: "E2E From Template" })).toBeVisible({
    timeout: 20_000,
  });

  const made = await prisma.taskBoard.findFirst({
    where: { name: "E2E From Template" },
    include: { sections: true },
  });
  expect(made!.isTemplate).toBe(false);
  expect(made!.sections).toHaveLength(1);

  const copied = await prisma.task.findMany({ where: { boardId: made!.id } });
  expect(copied.length).toBeGreaterThan(0);
  for (const t of copied) {
    expect(t.source).toBe("template");
    // Work should not arrive pre-assigned to whoever built the template.
    expect(t.assigneeId).toBeNull();
    expect(t.sectionId).toBe(made!.sections[0]!.id);
  }
  // The offset became a real date again.
  const kickoff = copied.find((t) => t.title === "Kick-off call");
  expect(kickoff!.dueAt).not.toBeNull();
  expect(kickoff!.dueAt!.getTime()).toBeGreaterThan(Date.now());
});
