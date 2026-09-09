import { test, expect } from "@playwright/test";
import { openLeadDetail } from "./helpers/leads";

/**
 * Editing and deleting a lead from the Lead Engine.
 *
 * Neither was reachable there: the detail modal existed but only the pipeline
 * board opened it, and the erasure code in modules/gdpr/erase.ts was only ever
 * called by a background job, so the product had no delete at all.
 */
async function createLead(page: import("@playwright/test").Page, suffix: number) {
  const name = `Edit Lead ${suffix}`;
  const company = `Edit Co ${suffix}`;
  await page.goto("/leads");
  await page.getByRole("button", { name: "Add manually" }).click();
  await page.getByPlaceholder("Contact name").fill(name);
  await page.getByPlaceholder("Email").fill(`before${suffix}@example.com`);
  await page.getByPlaceholder("Company name *").fill(company);
  await page.getByRole("button", { name: "Add lead" }).click();
  await expect(page.locator("tr", { hasText: name })).toBeVisible();
  return { name, company };
}

test("edit a lead's details from the Lead Engine", async ({ page }) => {
  const suffix = Date.now();
  const { name } = await createLead(page, suffix);

  await openLeadDetail(page, name);

  const email = page.getByTestId("lead-email");
  await expect(email).toHaveValue(`before${suffix}@example.com`);
  await email.fill(`after${suffix}@example.com`);

  // The company domain matters beyond this test: audits link to a company by
  // domain, and it could not be filled in after creation until now.
  const domain = page.getByTestId("lead-company-domain");
  if (await domain.count()) await domain.fill(`edited${suffix}.example`);

  await page.getByTestId("lead-save").click();
  await expect(page.getByText("Saved.")).toBeVisible();

  // Survives a reload — proves it persisted rather than just updating state.
  await page.reload();
  await openLeadDetail(page, name);
  await expect(page.getByTestId("lead-email")).toHaveValue(`after${suffix}@example.com`);
});

test("delete a lead, with a confirmation step", async ({ page }) => {
  const suffix = Date.now() + 1;
  const { name } = await createLead(page, suffix);

  await openLeadDetail(page, name);

  // One click must not destroy anything — it only reveals the confirmation.
  await page.getByTestId("lead-delete").click();
  await expect(page.getByTestId("lead-delete-confirm")).toBeVisible();

  // Backing out leaves the lead alone.
  await page.getByRole("button", { name: "Keep it" }).click();
  await expect(page.getByTestId("lead-delete-confirm")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("tr", { hasText: name })).toBeVisible();

  // Now go through with it.
  await openLeadDetail(page, name);
  await page.getByTestId("lead-delete").click();
  await page.getByTestId("lead-delete-confirmed").click();

  await expect(page.locator("tr", { hasText: name })).toHaveCount(0);
  await page.reload();
  await expect(page.locator("tr", { hasText: name })).toHaveCount(0);
});
