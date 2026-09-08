import { test, expect } from "@playwright/test";

/**
 * P1/1e — issuing the credential the extension needs. Shown once, because
 * only a hash is stored.
 */
test("an owner can issue and revoke a capture token", async ({ page }) => {
  // A LABEL UNIQUE TO THIS RUN. A fixed one accumulated across runs — the
  // revoke assertion then matched two rows and failed in strict mode, which is
  // the test's own leftovers rather than the product.
  const label = `e2e laptop ${Math.random().toString(36).slice(2, 8)}`;
  await page.goto("/settings/extension");

  await page.getByPlaceholder(/Which browser/i).fill(label);
  await page.getByTestId("issue-capture-token").click();

  const shown = page.getByTestId("issued-token");
  await expect(shown).toBeVisible();
  await expect(shown).toContainText(/vos_cap_/);

  // It appears in the list, and can be revoked again.
  const row = page.locator("li", { hasText: label });
  await expect(row).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText(label)).toHaveCount(0, { timeout: 10_000 });
});
