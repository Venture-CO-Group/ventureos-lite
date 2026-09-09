import { test, expect, type Page } from "@playwright/test";

/**
 * The leads table surface (playbook-v2 P3/2): filter builder, sorting, column
 * selection and pagination.
 *
 * The filter engine itself is unit-tested (test/unit/lead-filters.test.ts) —
 * what these prove is the wiring: that the URL carries the state, that the
 * server filters rather than the browser hiding rows, and that a reload lands
 * on the same table.
 */

/**
 * A token that cannot fuzzy-match another run's.
 *
 * Date.now() was the obvious choice and the wrong one: two runs seconds apart
 * produce 13-digit strings differing in three or four characters, which the
 * P3/1 matcher forgives on purpose — so a filter for one run's lead also
 * matched the previous run's leftover. Six random letters are far enough apart
 * that no edit budget reaches across them.
 */
function tag(): string {
  return Math.random().toString(36).slice(2, 8).replace(/\d/g, "x");
}

/**
 * Read one column's cells by its HEADER, not by position.
 *
 * nth-child indices were how two of these specs broke the moment the selection
 * checkbox added a column: the assertions still passed a number, just the wrong
 * one. The header is the stable name for a column.
 */
async function columnValues(page: Page, header: string): Promise<string[]> {
  const headers = await page.locator("thead th").allInnerTexts();
  const index = headers.findIndex((h) => h.trim().toLowerCase().startsWith(header.toLowerCase()));
  if (index === -1) throw new Error(`No "${header}" column on screen`);
  return page.locator(`tbody tr td:nth-child(${index + 1})`).allInnerTexts();
}

/**
 * Wait for a row, reloading if it does not appear.
 *
 * The whole suite runs against one workspace, and a sibling spec revalidating
 * /leads at the same moment can leave the client router serving a cached table
 * that predates this lead. The row exists in the database either way, so the
 * check goes back to the server rather than trusting the cached render.
 */
async function expectRowEventually(page: Page, name: string) {
  // Generous, and it reloads only after a real wait rather than after a short
  // one: the seeded workspace accumulates leads across runs, the dev-mode page
  // render grows with it, and a 2s inner timeout meant every attempt gave up
  // before the table had painted and then reloaded into the same race.
  await expect(page.locator("tr", { hasText: name })).toBeVisible({ timeout: 15_000 }).catch(
    async () => {
      await page.reload();
      await expect(page.locator("tr", { hasText: name })).toBeVisible({ timeout: 15_000 });
    },
  );
}

async function createLead(page: Page, name: string, company: string) {
  await page.goto("/leads");
  await page.getByRole("button", { name: "Add manually" }).click();
  await page.getByPlaceholder("Contact name").fill(name);
  await page.getByPlaceholder("Company name *").fill(company);
  await page.getByRole("button", { name: "Add lead" }).click();
  await expectRowEventually(page, name);
}

/** Apply a single free-text condition through the real filter builder UI. */
async function filterByText(page: Page, text: string) {
  await page.getByTestId("filter-toggle").click();
  await page.getByTestId("filter-add").click();
  const row = page.getByTestId("filter-condition").last();
  await row.getByTestId("filter-field").selectOption("text");
  await row.getByTestId("filter-value").fill(text);
  await page.getByTestId("filter-apply").click();
  // The chip renders from the URL, so its appearance means the navigation landed.
  await expect(page.getByTestId("filter-chip")).toBeVisible();
}

test("a filter narrows the table, and the URL carries it", async ({ page }) => {
  const suffix = tag();
  const name = `Filter Lead ${suffix}`;
  await createLead(page, name, `Filter Co ${suffix}`);

  const before = await page.locator("tbody tr").count();
  expect(before).toBeGreaterThan(1);

  await filterByText(page, name);

  // The server did the filtering: exactly one row came back, not one visible
  // row out of many rendered.
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr").first()).toContainText(name);

  // Linkable and refresh-proof.
  expect(page.url()).toContain("f=");
  await expect(page.getByTestId("filter-chip")).toBeVisible();
  await expect(page.getByTestId("lead-count")).toContainText("1 of");

  await page.reload();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByTestId("filter-chip")).toBeVisible();
});

test("clearing the filter brings the other leads back", async ({ page }) => {
  const suffix = tag();
  const name = `Clear Lead ${suffix}`;
  await createLead(page, name, `Clear Co ${suffix}`);

  await filterByText(page, name);
  await expect(page.locator("tbody tr")).toHaveCount(1);

  await page.getByTestId("filter-clear").click();
  await expect(page.getByTestId("filter-chip")).toHaveCount(0);
  expect(await page.locator("tbody tr").count()).toBeGreaterThan(1);
});

test("a filter matching nothing says so, and offers the way back", async ({ page }) => {
  await page.goto("/leads");
  await filterByText(page, "zzzz-no-such-lead-zzzz");

  /**
   * The copy comes from the shared ZeroResults primitive now (playbook-v5
   * P17/3) rather than being prose in the table. Same two guarantees: it says
   * the leads are THERE and the filter is what matched nothing, and it offers
   * the one useful action.
   */
  const zero = page.getByTestId("leads-zero-results");
  await expect(zero).toBeVisible();
  await expect(zero).toContainText(/none of them match/i);

  await zero.getByTestId("state-action").click();
  await expect(page.getByTestId("filter-chip")).toHaveCount(0);
});

test("a stage filter uses the real stage values, not free text", async ({ page }) => {
  await page.goto("/leads");
  await page.getByTestId("filter-toggle").click();
  await page.getByTestId("filter-add").click();

  const row = page.getByTestId("filter-condition").last();
  await row.getByTestId("filter-field").selectOption("stage");
  await row.getByTestId("filter-operator").selectOption("is");
  await row.getByTestId("filter-value").selectOption("RESEARCHED");
  await page.getByTestId("filter-apply").click();

  await expect(page.getByTestId("filter-chip")).toContainText("researched");
  // Every remaining row is in that stage — the chip is not decorative.
  const stages = await columnValues(page, "Stage");
  for (const cell of stages) {
    expect(cell.toLowerCase()).toMatch(/researched|below gate/);
  }
});

test("clicking a column header sorts, and clicking again reverses it", async ({ page }) => {
  await page.goto("/leads");

  await page.getByTestId("sort-icpScore").click();
  await expect(page).toHaveURL(/sort=icpScore%3Adesc/);
  await expect(page.getByTestId("sort-icpScore")).toContainText("↓");

  await page.getByTestId("sort-icpScore").click();
  await expect(page).toHaveURL(/sort=icpScore%3Aasc/);
  await expect(page.getByTestId("sort-icpScore")).toContainText("↑");

  // Descending really is descending — and unscored leads sort last rather than
  // counting as zero (the engine's rule; see test/unit/lead-filters.test.ts).
  await page.getByTestId("sort-icpScore").click();
  await expect(page).toHaveURL(/sort=icpScore%3Adesc/);

  const cells = await columnValues(page, "ICP score");
  const scores = cells.map((t) => {
    const digits = t.trim().match(/\d+/);
    return digits ? Number(digits[0]) : null;
  });

  const scored = scores.filter((n): n is number => n !== null);
  expect(scored).toEqual([...scored].sort((a, b) => b - a));

  // No unscored lead appears above a scored one.
  const firstNull = scores.indexOf(null);
  if (firstNull !== -1) {
    expect(scores.slice(firstNull).every((n) => n === null)).toBe(true);
  }
});

test("the column picker adds and removes columns", async ({ page }) => {
  await page.goto("/leads");
  await expect(page.getByRole("columnheader", { name: "City" })).toHaveCount(0);

  await page.getByTestId("column-toggle").click();
  await page.getByTestId("column-panel").getByText("City", { exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "City" })).toBeVisible();
  expect(page.url()).toContain("cols=");

  // Survives a reload, because it is in the URL and not in component state.
  await page.reload();
  await expect(page.getByRole("columnheader", { name: "City" })).toBeVisible();
});

test("the lead column cannot be switched off", async ({ page }) => {
  await page.goto("/leads");
  await page.getByTestId("column-toggle").click();
  const lead = page.getByTestId("column-panel").locator("label", { hasText: "Lead" });
  await expect(lead.locator("input[type=checkbox]")).toBeDisabled();
  await expect(lead).toContainText("always");
});

test("pagination appears past one page and moves between them", async ({ page }) => {
  await page.goto("/leads");

  const next = page.getByTestId("page-next");
  const pageCount = await next.count();
  test.skip(pageCount === 0, "workspace has one page of leads — nothing to page through");

  const firstRow = await page.locator("tbody tr").first().innerText();
  await next.click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByTestId("page-prev")).toBeEnabled();
  // A different page shows different leads.
  expect(await page.locator("tbody tr").first().innerText()).not.toBe(firstRow);

  await page.getByTestId("page-prev").click();
  await expect(page.locator("tbody tr").first()).toContainText(firstRow.split("\n")[0]!);
});
