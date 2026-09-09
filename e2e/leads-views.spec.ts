import { test, expect, type Page } from "@playwright/test";

/**
 * Saved views (playbook-v2 P3/2): a named filter + columns + sort, saved as a
 * tab above the leads table.
 *
 * The visibility rules are proved against the database in
 * test/integration/lead-views.test.ts. What these prove is that a tab actually
 * restores the table it was saved from.
 *
 * Serial, like workspace-isolation.spec.ts: every test in this file writes to
 * the SAME workspace's tab strip, so running them in parallel had them
 * reflowing each other's UI mid-click.
 */
test.describe.configure({ mode: "serial" });

/**
 * Every view this file creates is removed at the end, whatever happened.
 *
 * ── WHY THIS MATTERS MORE THAN IT LOOKS ─────────────────────────────────────
 *
 * `deleteView` runs through the UI, which is the point — it is what the tests
 * are proving. But a test that FAILS before reaching it leaves its view
 * behind, and the tab strip is a horizontal row that grows without bound. Runs
 * accumulated seven "Update <timestamp>" tabs over an afternoon, at which
 * point the newest tab's delete button sits past the right-hand edge and the
 * click stops landing — so the file started failing for a reason that had
 * nothing to do with saved views, and the failure produced one more tab each
 * time it ran.
 *
 * A shared surface that grows has to be swept by id, not by hoping the happy
 * path ran.
 */
const CREATED_PREFIXES = ["Researched ", "Highlight ", "Columns ", "Twice ", "Shared ", "Update ", "Temporary "];

test.afterAll(async () => {
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();
  try {
    const views = await db.savedView.findMany({ select: { id: true, name: true } });
    const mine = views.filter((v) => CREATED_PREFIXES.some((p) => v.name.startsWith(p)));
    if (mine.length > 0) {
      const ids = mine.map((v) => v.id);
      await db.scheduledExport.deleteMany({ where: { viewId: { in: ids } } });
      await db.savedView.deleteMany({ where: { id: { in: ids } } });
    }
  } finally {
    await db.$disconnect();
  }
});

async function addStageFilter(page: Page, stage: string) {
  await page.getByTestId("filter-toggle").click();
  await page.getByTestId("filter-add").click();
  const row = page.getByTestId("filter-condition").last();
  await row.getByTestId("filter-field").selectOption("stage");
  await row.getByTestId("filter-operator").selectOption("is");
  await row.getByTestId("filter-value").selectOption(stage);
  await page.getByTestId("filter-apply").click();
  // Wait for the navigation to land: the chip is rendered from the URL, so its
  // appearance is the signal that the table state has actually changed.
  await expect(page.getByTestId("filter-chip")).toBeVisible();
  await expect(page).toHaveURL(/[?&]f=/);
}

async function saveCurrentView(page: Page, name: string, shared = false) {
  await page.getByTestId("view-save").click();
  await page.getByTestId("view-name").fill(name);
  if (shared) await page.getByTestId("view-shared").check();
  await page.getByTestId("view-save-confirm").click();
  await expect(page.getByTestId("view-tab").filter({ hasText: name })).toBeVisible();
  // Saving navigates to the new view; wait for it to be the named one.
  await expect(page).toHaveURL(/[?&]view=/);
}

/**
 * Remove a view by name, so repeated runs do not collide on the unique name.
 *
 * Confirms through a reload rather than by watching the tab strip: the client
 * router can serve a cached strip that still lists the tab. The database is
 * the thing being asserted, so the check goes back to the server for it.
 */
async function deleteView(page: Page, name: string) {
  /**
   * Wait for the page to have finished streaming before clicking.
   *
   * `/leads` renders its body behind a `<Suspense>` (playbook-v5 P16/2), so a
   * navigation replaces the content when the data lands. A click issued in the
   * gap can be dispatched against a node React is in the middle of replacing,
   * and it simply never runs — which is how this helper started failing only
   * when it was called straight after clicking a tab.
   */
  await expect(page.getByTestId("skeleton")).toHaveCount(0, { timeout: 30_000 });
  const tab = page.getByTestId("view-tab").filter({ hasText: name });
  if ((await tab.count()) === 0) return;
  await page.getByLabel(`Delete view ${name}`).click();

  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("view-tab").filter({ hasText: name })).toHaveCount(0);
  }).toPass({ timeout: 15_000 });
}

test("a saved view restores the filter it was saved with", async ({ page }) => {
  const name = `Researched ${Date.now()}`;
  await page.goto("/leads");
  await addStageFilter(page, "RESEARCHED");

  const filteredCount = await page.locator("tbody tr").count();
  await saveCurrentView(page, name);

  // Navigating away and back through the tab restores the same table.
  await page.getByTestId("view-tab-all").click();
  await expect(page.getByTestId("filter-chip")).toHaveCount(0);

  await page.getByTestId("view-tab").filter({ hasText: name }).click();
  await expect(page.getByTestId("filter-chip")).toContainText("researched");
  await expect(page.locator("tbody tr")).toHaveCount(filteredCount);

  await deleteView(page, name);
});

test("the active tab is highlighted, and stops being so when the filter changes", async ({
  page,
}) => {
  const name = `Highlight ${Date.now()}`;
  await page.goto("/leads");
  await addStageFilter(page, "RESEARCHED");
  await saveCurrentView(page, name);

  const tab = page.getByTestId("view-tab").filter({ hasText: name });
  await expect(tab).toHaveAttribute("aria-current", "true");

  // Editing the filter means the tab no longer describes what is on screen.
  await page.getByTestId("filter-clear").click();
  await expect(tab).toHaveAttribute("aria-current", "false");
  await expect(page.getByTestId("view-tab-all")).toHaveAttribute("aria-current", "true");

  await deleteView(page, name);
});

test("a view remembers its columns and its sort, not just its filter", async ({ page }) => {
  const name = `Columns ${Date.now()}`;
  await page.goto("/leads");

  await page.getByTestId("column-toggle").click();
  await page.getByTestId("column-panel").getByText("City", { exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "City" })).toBeVisible();
  await page.getByTestId("column-toggle").click();

  await page.getByTestId("sort-icpScore").click();
  await expect(page).toHaveURL(/sort=icpScore%3Adesc/);

  await saveCurrentView(page, name);

  // Go somewhere without either, then come back through the tab.
  await page.getByTestId("view-tab-all").click();
  await expect(page.getByRole("columnheader", { name: "City" })).toHaveCount(0);

  await page.getByTestId("view-tab").filter({ hasText: name }).click();
  await expect(page.getByRole("columnheader", { name: "City" })).toBeVisible();
  await expect(page).toHaveURL(/sort=icpScore%3Adesc/);

  await deleteView(page, name);
});

test("two views with the same name are refused", async ({ page }) => {
  const name = `Twice ${Date.now()}`;
  await page.goto("/leads");
  await addStageFilter(page, "RESEARCHED");
  await saveCurrentView(page, name);

  await page.getByTestId("view-save").click();
  await page.getByTestId("view-name").fill(name);
  await page.getByTestId("view-save-confirm").click();
  await expect(page.getByRole("dialog").getByText(/already have a view/i)).toBeVisible();

  await page.getByRole("button", { name: "Cancel" }).click();
  await deleteView(page, name);
});

test("a shared view is marked as shared", async ({ page }) => {
  const name = `Shared ${Date.now()}`;
  await page.goto("/leads");
  await addStageFilter(page, "RESEARCHED");
  await saveCurrentView(page, name, true);

  const tab = page.getByTestId("view-tab").filter({ hasText: name });
  await expect(tab).toHaveAttribute("title", "Shared view");

  await deleteView(page, name);
});

test("editing a view offers to absorb the change, and does", async ({ page }) => {
  const name = `Update ${Date.now()}`;
  await page.goto("/leads");
  await addStageFilter(page, "RESEARCHED");
  await saveCurrentView(page, name);

  // Nothing to update while the table still matches the tab.
  await expect(page.getByTestId("view-update")).toHaveCount(0);

  await page.getByTestId("sort-icpScore").click();
  await expect(page).toHaveURL(/sort=icpScore%3Adesc/);
  const update = page.getByTestId("view-update");
  await expect(update).toBeVisible();

  await update.click();
  // Absorbed: the tab matches again, so the offer withdraws.
  await expect(page.getByTestId("view-update")).toHaveCount(0);
  await expect(page.getByTestId("view-tab").filter({ hasText: name })).toHaveAttribute(
    "aria-current",
    "true",
  );

  // And it persists — reopening the tab restores the new sort.
  await page.getByTestId("view-tab-all").click();
  await page.getByTestId("view-tab").filter({ hasText: name }).click();
  await expect(page).toHaveURL(/sort=icpScore%3Adesc/);

  await deleteView(page, name);
});

test("a deleted view disappears from the tabs", async ({ page }) => {
  const name = `Temporary ${Date.now()}`;
  await page.goto("/leads");
  await addStageFilter(page, "RESEARCHED");
  await saveCurrentView(page, name);

  // deleteView confirms through a reload, which is exactly the assertion here.
  await deleteView(page, name);
});
