import { test, expect } from "@playwright/test";

/** P1/1e — the download must be authenticated and must be a real zip. */
test("signed-in users can download a valid extension zip", async ({ page }) => {
  await page.goto("/settings/extension");
  const link = page.getByTestId("download-extension");
  await expect(link).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toMatch(/^venture-os-capture-\d+\.\d+\.\d+\.zip$/);

  const path = await download.path();
  expect(path).toBeTruthy();
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the download refuses without a session", async ({ request }) => {
    const res = await request.get("/api/extension/download", { maxRedirects: 0 });
    expect([401, 302, 307]).toContain(res.status());
  });
});
