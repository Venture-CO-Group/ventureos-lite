import { test, expect } from "@playwright/test";
import { openLeadDetail } from "./helpers/leads";

/**
 * The Lookup button beside the lead form's Domain field.
 *
 * Only the DETERMINISTIC path is driven here: a domain is typed in, so the
 * action reads that site and never calls Claude. The web-search path costs a
 * real search per click and needs an API key, which is not something a test
 * suite should spend or depend on — the search wiring is covered by units
 * against a stubbed client instead.
 */
async function openLeadWith(page: import("@playwright/test").Page, suffix: number) {
  const name = `Domain Lead ${suffix}`;
  await page.goto("/leads");
  await page.getByRole("button", { name: "Add manually" }).click();
  await page.getByPlaceholder("Contact name").fill(name);
  await page.getByPlaceholder("Company name *").fill(`Domain Co ${suffix}`);
  await page.getByRole("button", { name: "Add lead" }).click();
  await expect(page.locator("tr", { hasText: name })).toBeVisible();
  await openLeadDetail(page, name);
  return name;
}

test("reads the typed site and normalises what was pasted", async ({ page }) => {
  await openLeadWith(page, Date.now());

  // Pasted the way a person actually pastes: scheme, www, a path.
  await page.getByTestId("lead-company-domain").fill("https://www.example.com/index.html");
  await page.getByTestId("lead-domain-lookup").click();

  await expect(page.getByText(/Read example\.com/)).toBeVisible({ timeout: 30_000 });
  // The field is left holding the bare hostname, which is what the audit and
  // the enrichment both expect to find there.
  await expect(page.getByTestId("lead-company-domain")).toHaveValue("example.com");
});

test("refuses a directory listing instead of filling it in", async ({ page }) => {
  await openLeadWith(page, Date.now() + 1);

  await page.getByTestId("lead-company-domain").fill("linkedin.com/company/whoever");
  await page.getByTestId("lead-domain-lookup").click();

  await expect(
    page.getByText(/directory or social profile, not the company's own site/),
  ).toBeVisible({ timeout: 30_000 });
  // Nothing was overwritten by the refusal.
  await expect(page.getByTestId("lead-company-domain")).toHaveValue(
    "linkedin.com/company/whoever",
  );
});

test("will not point the server at its own network", async ({ page }) => {
  await openLeadWith(page, Date.now() + 2);

  // The whole reason safe-fetch exists: this must not come back with anything.
  await page.getByTestId("lead-company-domain").fill("127.0.0.1");
  await page.getByTestId("lead-domain-lookup").click();

  // Said plainly, and — just as importantly — WITHOUT quietly spending a web
  // search because the field held something unusable.
  await expect(page.getByText(/"127\.0\.0\.1" is not a domain/)).toBeVisible({
    timeout: 30_000,
  });
});

test("the button fits beside the field at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLeadWith(page, Date.now() + 3);

  const field = page.getByTestId("lead-company-domain");
  const button = page.getByTestId("lead-domain-lookup");
  const f = await field.boundingBox();
  const b = await button.boundingBox();
  if (!f || !b) throw new Error("Domain row is not visible at 390px");

  // Side by side, not wrapped or overflowing, and big enough to hit.
  expect(b.x).toBeGreaterThanOrEqual(f.x + f.width - 1);
  expect(b.x + b.width).toBeLessThanOrEqual(390);
  expect(b.height).toBeGreaterThanOrEqual(36);
});
