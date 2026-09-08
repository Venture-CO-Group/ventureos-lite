import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const VIEW = "Sched View";
let workspaceId = "";
let viewId = "";

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  const runner = await prisma.user.findUnique({ where: { email: "e2e-runner@ventureco.test" } });

  await prisma.savedView.deleteMany({ where: { workspaceId, name: VIEW } });
  const view = await prisma.savedView.create({
    data: {
      workspaceId,
      name: VIEW,
      entity: "lead",
      ownerId: runner!.id,
      shared: true,
      filters: { match: "all", conditions: [] },
      columns: ["contact", "company", "icpScore", "stage"],
      position: 900,
    },
  });
  viewId = view.id;
});

test.afterAll(async () => {
  await prisma.scheduledExport.deleteMany({ where: { workspaceId } });
  await prisma.savedView.deleteMany({
    where: { workspaceId, name: { in: [VIEW, "Someone else's private view"] } },
  });
  await prisma.user.deleteMany({ where: { email: "sched-other@ventureco.test" } });
  await prisma.$disconnect();
});

test("a saved view can be put on a schedule, paused, and removed", async ({ page }) => {
  await page.goto("/leads");
  await page.getByTestId("open-schedules").click();

  await page.getByTestId("schedule-view").selectOption(viewId);
  await page.getByTestId("schedule-format").selectOption("xlsx");
  await page.getByTestId("schedule-cadence").selectOption("weekly");
  await page.getByTestId("schedule-weekday").selectOption("1");
  await page.getByTestId("schedule-hour").selectOption("8");
  await page.getByTestId("schedule-recipients").fill("reports@example.com");
  await page.getByTestId("schedule-save").click();
  await expect(page.getByText("Schedule created.")).toBeVisible();

  const row = await prisma.scheduledExport.findFirst({ where: { workspaceId } });
  expect(row).not.toBeNull();
  expect(row!.viewId).toBe(viewId);
  expect(row!.format).toBe("xlsx");
  expect(row!.cadence).toBe("weekly");
  expect(row!.recipients).toEqual(["reports@example.com"]);
  // The next slot is computed on save rather than left null, so the sweep does
  // not have to guess and the UI can say when it will arrive.
  expect(row!.nextRunAt).not.toBeNull();
  expect(row!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  expect(row!.nextRunAt!.getDay()).toBe(1); // Monday
  expect(row!.nextRunAt!.getHours()).toBe(8);

  // The badge is visible without opening the dialog: a schedule nobody
  // remembers setting up is exactly the one that should be on screen.
  await expect(page.getByTestId("schedule-list")).toBeVisible();
  await expect(page.getByTestId("schedule-row")).toContainText("Every Monday at 08:00");

  // ---- pause -------------------------------------------------------------
  await page.getByTestId("schedule-toggle").click();
  await expect(page.getByTestId("schedule-row")).toContainText("paused");
  const paused = await prisma.scheduledExport.findUnique({ where: { id: row!.id } });
  expect(paused!.enabled).toBe(false);
  // A paused schedule has no next slot at all, so resuming cannot fire
  // immediately on a stale date.
  expect(paused!.nextRunAt).toBeNull();

  // ---- resume ------------------------------------------------------------
  await page.getByTestId("schedule-toggle").click();
  await expect(page.getByTestId("schedule-row")).not.toContainText("paused");
  const resumed = await prisma.scheduledExport.findUnique({ where: { id: row!.id } });
  expect(resumed!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());

  // ---- delete ------------------------------------------------------------
  await page.getByTestId("schedule-delete").click();
  await expect(page.getByText("Removed.")).toBeVisible();
  expect(await prisma.scheduledExport.count({ where: { workspaceId } })).toBe(0);
});

test("a personal view belonging to somebody else is not even offered", async ({ page }) => {
  const other = await prisma.user.upsert({
    where: { email: "sched-other@ventureco.test" },
    update: {},
    create: { email: "sched-other@ventureco.test", name: "Other", passwordHash: "!" },
  });
  await prisma.savedView.deleteMany({
    where: { workspaceId, name: "Someone else's private view" },
  });
  const personal = await prisma.savedView.create({
    data: {
      workspaceId,
      name: "Someone else's private view",
      entity: "lead",
      ownerId: other.id,
      shared: false,
      filters: { match: "all", conditions: [] },
      columns: [],
      position: 901,
    },
  });

  await page.goto("/leads");
  await page.getByTestId("open-schedules").click();

  /**
   * The picker offers only what the tab strip does — your own views plus the
   * shared ones — so somebody's personal filter is unreachable here.
   *
   * `saveSchedule` refuses it as well, which is defence in depth rather than
   * belt-and-braces theatre: scheduling somebody's private filter would email
   * a list they can change without knowing anybody receives it, and a server
   * action is reachable by a crafted request whatever the UI renders.
   */
  const options = await page.getByTestId("schedule-view").locator("option").all();
  const values = await Promise.all(options.map((o) => o.getAttribute("value")));
  expect(values).not.toContain(personal.id);
  expect(values).toContain(viewId);

  await prisma.savedView.deleteMany({ where: { id: personal.id } });
  await prisma.user.deleteMany({ where: { id: other.id } });
});

test("deleting the view takes its schedules with it", async ({ page }) => {
  await page.goto("/leads");
  await page.getByTestId("open-schedules").click();
  await page.getByTestId("schedule-view").selectOption(viewId);
  await page.getByTestId("schedule-save").click();
  await expect(page.getByText("Schedule created.")).toBeVisible();
  expect(await prisma.scheduledExport.count({ where: { viewId } })).toBe(1);

  // A schedule pointing at a filter nobody can see any more would send a
  // report nobody could reproduce.
  await prisma.savedView.delete({ where: { id: viewId } });
  expect(await prisma.scheduledExport.count({ where: { viewId } })).toBe(0);

  // Put it back for the other tests in this file.
  const runner = await prisma.user.findUnique({ where: { email: "e2e-runner@ventureco.test" } });
  const again = await prisma.savedView.create({
    data: {
      workspaceId,
      name: VIEW,
      entity: "lead",
      ownerId: runner!.id,
      shared: true,
      filters: { match: "all", conditions: [] },
      columns: ["contact", "company"],
      position: 900,
    },
  });
  viewId = again.id;
});
