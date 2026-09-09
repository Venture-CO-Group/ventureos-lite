import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

/**
 * The accessibility guard (playbook-v5 P16/4).
 *
 * ── WHY axe IN THE SUITE AND NOT ONLY IN A REPORT ───────────────────────────
 *
 * scripts/axe-report.mjs prints the full picture, which is what you read when
 * you want to know where things stand. This is what stops it getting worse:
 * serious and critical violations fail the build, on the six screens a BDR
 * actually opens all day.
 *
 * Minor violations are NOT failed. They are mostly best-practice notes on
 * decorative markup, and a gate that fires on those is a gate people start
 * skipping — at which point it protects nothing.
 */
const AXE = readFileSync("node_modules/axe-core/axe.min.js", "utf8");

const prisma = new PrismaClient();
const RUN = String(Date.now());
const A11Y_BOARD = `E2E A11y Board ${RUN}`;
let workspaceId = "";

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
});

test.afterAll(async () => {
  for (const b of await prisma.taskBoard.findMany({ where: { name: A11Y_BOARD } })) {
    await prisma.task.deleteMany({ where: { boardId: b.id } });
    await prisma.taskSection.deleteMany({ where: { boardId: b.id } });
    await prisma.taskBoard.delete({ where: { id: b.id } });
  }
  await prisma.$disconnect();
});

const SCREENS = [
  ["dashboard", "/"],
  ["leads", "/leads"],
  ["pipeline", "/pipeline"],
  ["tasks", "/tasks"],
  ["inbox", "/inbox"],
  ["audit", "/audit"],
] as const;

interface AxeNode {
  target: string[];
}
interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: AxeNode[];
}

async function scan(page: Page): Promise<AxeViolation[]> {
  await page.evaluate(AXE);
  const result = (await page.evaluate(async () => {
    const w = window as unknown as {
      axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: AxeViolation[] }> };
    };
    return await w.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
  })) as { violations: AxeViolation[] };
  return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

for (const [name, path] of SCREENS) {
  test(`${name} has no serious or critical accessibility violations`, async ({ page }) => {
    await page.goto(path);
    // The Suspense bodies have to land, or the scan reads a page of skeletons.
    await expect(page.getByTestId("skeleton")).toHaveCount(0, { timeout: 30_000 });

    const violations = await scan(page);
    const report = violations
      .map((v) => `[${v.impact}] ${v.id} × ${v.nodes.length} — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`)
      .join("\n");
    expect(violations.length, `${path}\n${report}`).toBe(0);
  });
}

/**
 * Focus, in a dialog that claims to be modal.
 *
 * `aria-modal="true"` tells assistive tech that nothing outside matters, so a
 * screen reader stops announcing the page behind it. The shell carried that
 * attribute while Tab walked straight out into the page and closing dropped
 * focus at the top of the document — worse than no dialog semantics, because
 * the attribute makes the promise.
 */
test("a modal takes focus, keeps Tab inside it, and gives focus back", async ({ page }) => {
  await page.goto("/leads");
  await expect(page.getByTestId("skeleton")).toHaveCount(0, { timeout: 30_000 });

  // "Add manually" rather than the board-settings dialog: this one is present
  // on a fresh workspace, where there is not yet a board to edit.
  const opener = page.getByRole("button", { name: "Add manually" });
  await opener.focus();
  await opener.press("Enter");

  const modal = page.getByTestId("modal");
  await expect(modal).toBeVisible();

  // Focus moved IN, to the first control rather than staying on the button.
  await expect
    .poll(async () => modal.evaluate((el) => el.contains(document.activeElement)))
    .toBe(true);

  /**
   * Tab all the way round. More presses than there are controls, so if the
   * trap leaked, focus would be somewhere in the page behind by the end.
   */
  for (let i = 0; i < 25; i++) await page.keyboard.press("Tab");
  expect(await modal.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  // And backwards, which is the direction a trap usually forgets.
  for (let i = 0; i < 25; i++) await page.keyboard.press("Shift+Tab");
  expect(await modal.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);

  // Focus is back on what opened it, not at the top of the document.
  await expect
    .poll(async () => opener.evaluate((el) => el === document.activeElement))
    .toBe(true);
});

/**
 * The board, without a pointer.
 *
 * Dragging was the only way to move a card, which made the board unusable by
 * keyboard. One press, one committed move, and the move is announced because
 * the card relocating is the only other feedback.
 *
 * Seeds its own board and two columns rather than relying on whatever is on
 * the default one — the first version of this test SKIPPED on a workspace with
 * no board, which proves nothing at all.
 */
test("a card can be moved across the board with the keyboard alone", async ({ page }) => {
  const board = await prisma.taskBoard.create({
    data: {
      workspaceId,
      name: A11Y_BOARD,
      sections: {
        create: [
          { workspaceId, name: "First", position: 1024 },
          { workspaceId, name: "Second", position: 2048 },
        ],
      },
    },
    include: { sections: true },
  });
  const first = board.sections.find((s) => s.name === "First")!;
  const second = board.sections.find((s) => s.name === "Second")!;
  const task = await prisma.task.create({
    data: {
      workspaceId,
      boardId: board.id,
      sectionId: first.id,
      title: `Keyboard mover ${RUN}`,
      position: 1024,
    },
  });

  await page.goto(`/tasks?board=${board.id}`);
  const card = page.getByTestId("task-card").filter({ hasText: `Keyboard mover ${RUN}` });
  await expect(card).toBeVisible({ timeout: 20_000 });

  const handle = card.getByTestId("card-move-handle");
  await handle.focus();
  await handle.press("ArrowRight");

  // Announced, in words, because a screen reader cannot see the card move.
  await expect(page.getByTestId("board-live")).toContainText("Moved to Second", {
    timeout: 15_000,
  });

  // And it is a real move, committed to the database.
  await expect
    .poll(async () => (await prisma.task.findUnique({ where: { id: task.id } }))!.sectionId, {
      timeout: 15_000,
    })
    .toBe(second.id);

  /**
   * The far edge answers rather than doing nothing, so nobody is left pressing
   * a key that appears to be broken.
   *
   * Reloaded first, deliberately: a second press issued before the board has
   * come back computes from the previous positions. The component now holds
   * presses until a move lands, and this asserts the EDGE behaviour rather
   * than the race, so it starts from a settled page.
   */
  await page.reload();
  await expect(card).toBeVisible({ timeout: 20_000 });
  const handleAgain = card.getByTestId("card-move-handle");
  await handleAgain.focus();
  await handleAgain.press("ArrowRight");
  await expect(page.getByTestId("board-live")).toContainText("Already in the last column", {
    timeout: 15_000,
  });
});
