import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SITE = "http://www.csulokbar.hu/";

test.afterAll(async () => {
  const boards = await prisma.taskBoard.findMany({
    where: { name: { contains: "audit plan" } },
  });
  for (const b of boards) {
    await prisma.task.deleteMany({ where: { boardId: b.id } });
    await prisma.taskSection.deleteMany({ where: { boardId: b.id } });
    await prisma.taskBoard.delete({ where: { id: b.id } });
  }
  await prisma.auditResult.deleteMany({ where: { url: SITE } });
  await prisma.$disconnect();
});

/**
 * The priority matrix decided what to do first, and nothing carried that
 * decision into work — the plan was re-typed by hand into whatever the
 * operator happened to use.
 */
test("an audit's findings become a board, ordered the way the matrix argued for", async ({
  page,
}) => {
  // A real audit of a real slow site: probe, PageSpeed and two screenshots.
  // The suite's 45s default is a budget for a page interaction, not for that.
  test.setTimeout(300_000);
  await prisma.auditResult.deleteMany({ where: { url: SITE } });

  await page.goto("/audit");
  await page.getByPlaceholder("Website URL").fill(SITE);
  await page.getByRole("button", { name: "Run audit" }).click();
  await expect(page.getByText("cached 30 days").first()).toBeVisible({ timeout: 180_000 });

  await page.getByTestId("make-audit-plan").click();
  const open = page.getByTestId("open-audit-plan");
  await expect(open).toBeVisible({ timeout: 30_000 });
  const label = await open.textContent();
  const taskCount = Number(/(\d+) tasks/.exec(label ?? "")?.[1] ?? 0);
  expect(taskCount).toBeGreaterThan(0);

  const board = await prisma.taskBoard.findFirst({
    where: { name: { contains: "audit plan" } },
    include: { sections: { orderBy: { position: "asc" } } },
  });
  expect(board).not.toBeNull();
  expect(board!.name).toContain("csulokbar.hu");

  // Only quadrants with findings become columns: four headings with two empty
  // is a board that looks unfinished on arrival.
  expect(board!.sections.length).toBeGreaterThan(0);
  expect(board!.sections.length).toBeLessThanOrEqual(4);
  const names = board!.sections.map((s) => s.name);
  for (const n of names) {
    expect(["Quick wins", "Worth planning", "Fill-ins", "Later"]).toContain(n);
  }

  const tasks = await prisma.task.findMany({ where: { boardId: board!.id } });
  expect(tasks.length).toBe(taskCount);
  // Every task is traceable back to the audit that produced it.
  for (const t of tasks) {
    expect(t.source).toBe("audit_plan");
    expect(t.note).toContain("From the audit of");
    expect(t.sectionId).not.toBeNull();
  }
  // Quick wins are high impact AND cheap, which is the most urgent thing on
  // any list — the two axes collapse into one priority field.
  const quick = board!.sections.find((s) => s.name === "Quick wins");
  if (quick) {
    const inQuick = tasks.filter((t) => t.sectionId === quick.id);
    expect(inQuick.every((t) => t.priority === "urgent")).toBe(true);
  }

  // ---- and it opens as a real board ------------------------------------
  await open.click();
  await expect(page.getByTestId("board-column").first()).toBeVisible();
  await expect(page.getByTestId("task-card").first()).toBeVisible();
});

test("a clean audit is refused rather than producing an empty board", async ({ page }) => {
  await prisma.auditResult.deleteMany({ where: { url: "https://clean.example" } });
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  // Every check passing: nothing to plan, and an empty board is not a plan.
  const audit = await prisma.auditResult.create({
    data: {
      workspaceId: ws!.id,
      url: "https://clean.example",
      status: "done",
      score: 0,
      verdict: "SKIP",
      flags: [],
      checks: [
        { key: "https", label: "HTTPS valid", pass: true },
        { key: "viewport", label: "Mobile viewport", pass: true },
      ] as never,
      screenshots: {},
      schemaVersion: 4,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  // `run=1` starts it without a second click; the 30-day cache means it
  // resolves to the row created above rather than probing a domain that does
  // not exist.
  await page.goto(`/audit?url=${encodeURIComponent("https://clean.example")}&run=1`);
  await expect(page.getByText("cached 30 days").first()).toBeVisible({ timeout: 40_000 });
  await page.getByTestId("make-audit-plan").click();
  await expect(page.getByText(/nothing to plan/i)).toBeVisible();

  expect(await prisma.taskBoard.count({ where: { name: { contains: "clean.example" } } })).toBe(0);
  await prisma.auditResult.delete({ where: { id: audit.id } });
});
