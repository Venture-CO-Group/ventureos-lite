import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

test.afterAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  const flags = (ws?.featureFlags ?? {}) as Record<string, unknown>;
  delete flags.hiddenNav;
  await prisma.workspace.update({
    where: { id: ws!.id },
    data: { featureFlags: flags as never },
  });
  await prisma.$disconnect();
});

test("switching a menu item off removes it from the sidebar and the palette", async ({ page }) => {
  await page.goto("/leads");
  const sidebar = page.locator("aside");
  await expect(sidebar.getByText("Campaigns", { exact: true })).toBeVisible();

  // ---- switch it off -----------------------------------------------------
  await page.goto("/settings/admin");
  const toggle = page.getByTestId("nav-toggle-campaigns").locator("input");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(page.getByTestId("nav-visibility-saved")).toBeVisible();

  // ---- gone from the sidebar --------------------------------------------
  await page.goto("/leads");
  await expect(sidebar.getByText("Campaigns", { exact: true })).toHaveCount(0);
  // The screens that stay are untouched.
  await expect(sidebar.getByText("Lead Engine", { exact: true })).toBeVisible();

  // ---- gone from the command palette -------------------------------------
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(400);
  await page.keyboard.type("campaign");
  await page.waitForTimeout(700);
  await expect(page.getByText("Go to Campaigns")).toHaveCount(0);
  await page.keyboard.press("Escape");

  /**
   * ---- and yet the route still works ------------------------------------
   *
   * This is the assertion that says what the feature IS. Hiding declutters a
   * menu; it does not restrict access, and a notification or a share link that
   * points into a hidden screen must not become a dead end. Anyone reading
   * "hidden" as "denied" would be wrong, and the settings panel says so too.
   */
  const res = await page.goto("/campaigns", { waitUntil: "domcontentloaded" });
  expect(res?.status()).toBeLessThan(400);

  // ---- switch it back on -------------------------------------------------
  await page.goto("/settings/admin");
  await page.getByTestId("nav-toggle-campaigns").locator("input").check();
  await expect(page.getByTestId("nav-visibility-saved")).toBeVisible();
  await page.goto("/leads");
  await expect(sidebar.getByText("Campaigns", { exact: true })).toBeVisible();
});

test("the screens nobody may be locked out of cannot be switched off", async ({ page }) => {
  await page.goto("/settings/admin");
  // They are not rendered as switches at all — a disabled checkbox invites
  // somebody to keep clicking it.
  await expect(page.getByTestId("nav-toggle-leads")).toHaveCount(0);
  await expect(page.getByTestId("nav-toggle-settings")).toHaveCount(0);
  await expect(page.getByText(/Always shown:/)).toBeVisible();
});
