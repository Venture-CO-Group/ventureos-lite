import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const MARK = "DupReview";
let workspaceId = "";

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  // Two companies whose names fuzzy-match but which are genuinely different —
  // the exact shape the scanner is suggestive about rather than certain of.
  await prisma.company.create({ data: { workspaceId, name: `${MARK} Danubia Kft` } });
  await prisma.company.create({ data: { workspaceId, name: `${MARK} Danubia Kft.` } });
});

test.afterAll(async () => {
  const companies = await prisma.company.findMany({ where: { name: { startsWith: MARK } } });
  await prisma.duplicateDismissal.deleteMany({
    where: { OR: companies.flatMap((c) => [{ aId: c.id }, { bId: c.id }]) },
  });
  await prisma.company.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.$disconnect();
});

/**
 * Before this, the review list could only be shrunk by MERGING. A legitimate
 * false positive sat there for ever, and after a few of those the whole panel
 * gets ignored — which costs more than the duplicates it was built to catch.
 */
/**
 * Reload until the pair shows up.
 *
 * The duplicate SCAN is behind a 60-second in-process cache (P6/3) — it is an
 * aggregate over every company and lead, and it only changes when those do. So
 * a company created a moment ago legitimately takes up to a minute to appear.
 * Waiting on one page load would be testing the cache's TTL, not the feature.
 */
async function waitForPair(page: import("@playwright/test").Page) {
  await expect
    .poll(
      async () => {
        await page.goto("/settings/admin/workspace");
        return page.getByTestId("duplicates-companies").getByText(/Danubia/).count();
      },
      { timeout: 90_000, intervals: [2_000] },
    )
    .toBeGreaterThan(0);
}

test("a pair can be dismissed, stays dismissed, and can be put back", async ({ page }) => {
  test.setTimeout(180_000);
  await waitForPair(page);
  const list = page.getByTestId("duplicates-companies");

  // ---- dismiss ----------------------------------------------------------
  page.once("dialog", (d) => d.accept("Different owners, same trading name."));
  await list
    .locator("li")
    .filter({ hasText: "Danubia" })
    .first()
    .getByTestId("duplicate-dismiss")
    .click();
  await expect(page.getByText(/will not be offered again/i)).toBeVisible();

  const dismissals = await prisma.duplicateDismissal.findMany({ where: { workspaceId } });
  expect(dismissals.length).toBeGreaterThan(0);
  const row = dismissals[0]!;
  // Stored SORTED, so (a,b) and (b,a) cannot both be dismissed independently.
  expect(row.aId <= row.bId).toBe(true);
  expect(row.reason).toContain("Different owners");
  expect(row.dismissedBy).toBeTruthy();

  // ---- and it is gone from the list, on a fresh load --------------------
  await page.goto("/settings/admin/workspace");
  const after = page.getByTestId("duplicates-companies");
  if (await after.isVisible()) {
    await expect(after.getByText(/Danubia/)).toHaveCount(0);
  }

  // ---- but visible as a dismissal, with a way back ----------------------
  const shelf = page.getByTestId("dismissed-pairs");
  await expect(shelf).toBeVisible();
  await expect(shelf.getByText(/Danubia/).first()).toBeVisible();
  await expect(shelf.getByText(/Different owners/)).toBeVisible();

  await shelf
    .locator("li")
    .filter({ hasText: "Danubia" })
    .first()
    .getByTestId("duplicate-restore")
    .click();
  await expect(page.getByText(/Back on the review list/i)).toBeVisible();

  expect(await prisma.duplicateDismissal.count({ where: { workspaceId } })).toBe(0);
  await waitForPair(page);
});

test("dismissing the same pair twice is one row, not an error", async ({ page }) => {
  test.setTimeout(180_000);
  await waitForPair(page);
  const item = page
    .getByTestId("duplicates-companies")
    .locator("li")
    .filter({ hasText: "Danubia" })
    .first();

  page.once("dialog", (d) => d.accept("first reason"));
  await item.getByTestId("duplicate-dismiss").click();
  await expect(page.getByText(/will not be offered again/i)).toBeVisible();

  // Restore and dismiss again with a different reason: the unique index must
  // not turn a second opinion into a crash.
  await page
    .getByTestId("dismissed-pairs")
    .locator("li")
    .filter({ hasText: "Danubia" })
    .first()
    .getByTestId("duplicate-restore")
    .click();
  await expect(page.getByText(/Back on the review list/i)).toBeVisible();

  await waitForPair(page);
  page.once("dialog", (d) => d.accept("second reason"));
  await page
    .getByTestId("duplicates-companies")
    .locator("li")
    .filter({ hasText: "Danubia" })
    .first()
    .getByTestId("duplicate-dismiss")
    .click();
  await expect(page.getByText(/will not be offered again/i)).toBeVisible();

  const rows = await prisma.duplicateDismissal.findMany({ where: { workspaceId } });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.reason).toBe("second reason");
});
