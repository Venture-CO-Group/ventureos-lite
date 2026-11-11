import { test, expect } from "@playwright/test";

/**
 * Company Finder at phone width (CLAUDE.md definition of done: works at
 * 390px). Creates a list, checks the "filtering happens locally" notice and
 * the cached-only toggle are there, and that no page scrolls sideways.
 */
const SHOTS = process.env.FINDER_SHOTS;

async function noSideScroll(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test("company finder: define a list at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/finder");
  await expect(page.getByRole("heading", { name: "company finder" })).toBeVisible();
  await noSideScroll(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/finder-index-390.png`, fullPage: true });

  await page.getByTestId("finder-new").click();
  await expect(page.getByTestId("finder-local-notice")).toContainText("Filtering happens here, not at the registry");
  await expect(page.getByTestId("finder-cached-only")).toBeVisible();
  await noSideScroll(page);

  const name = `E2E finder ${Date.now()}`;
  await page.getByPlaceholder("Budapest micro IT firms").fill(name);
  await page.getByPlaceholder("szoftver, informatika").fill("Szoftver");
  await page.getByLabel("Budapest", { exact: true }).check();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/finder-new-390.png`, fullPage: true });
  await page.getByTestId("finder-save").click();

  await expect(page).toHaveURL(/\/finder\/[a-z0-9]+$/);
  await expect(page.getByRole("heading", { name: name.toLowerCase() })).toBeVisible();
  await expect(page.getByTestId("finder-run-panel")).toBeVisible();
  await expect(page.getByTestId("finder-results")).toBeVisible();
  await noSideScroll(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/finder-list-390.png`, fullPage: true });

  // Clean up after ourselves.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete list" }).click();
  await expect(page).toHaveURL(/\/finder$/);
});
