import { test, expect } from "@playwright/test";
import { openLeadDetail } from "./helpers/leads";

/**
 * The Verify button beside a lead's email (playbook-v3 P9/2, ad hoc).
 *
 * Drives the real chain — click, server action, layered check against real DNS,
 * verdict written to the lead — for the three answers that matter.
 */
async function leadWithEmail(page: import("@playwright/test").Page, email: string, n: number) {
  const name = `Verify Lead ${n}`;
  await page.goto("/leads");
  await page.getByRole("button", { name: "Add manually" }).click();
  await page.getByPlaceholder("Contact name").fill(name);
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Company name *").fill(`Verify Co ${n}`);
  await page.getByRole("button", { name: "Add lead" }).click();
  await expect(page.locator("tr", { hasText: name })).toBeVisible();
  await openLeadDetail(page, name);
  return name;
}

test("says an ordinary address is deliverable", async ({ page }) => {
  await leadWithEmail(page, "kovacs.anna@gmail.com", Date.now());
  await page.getByTestId("lead-verify-email").click();
  await expect(page.getByText(/Deliverable —/)).toBeVisible({ timeout: 30_000 });
});

test("flags a role address rather than refusing it", async ({ page }) => {
  await leadWithEmail(page, "info@gmail.com", Date.now() + 1);
  await page.getByTestId("lead-verify-email").click();
  // Risky, not blocked: for a small business info@ IS the owner's inbox.
  await expect(page.getByText(/Risky — Role address/)).toBeVisible({ timeout: 30_000 });
});

test("refuses a domain that has no mail server", async ({ page }) => {
  await leadWithEmail(page, "valaki@qwrtzlk-nincs-ilyen-123456.hu", Date.now() + 2);
  await page.getByTestId("lead-verify-email").click();
  await expect(page.getByText(/Not deliverable — The domain does not exist/)).toBeVisible({
    timeout: 30_000,
  });
});
