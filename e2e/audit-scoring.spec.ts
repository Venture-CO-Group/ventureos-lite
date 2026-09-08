import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

test.afterAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  const cfg = (ws?.auditConfig ?? {}) as Record<string, unknown>;
  delete cfg.verdict;
  delete cfg.categoryWeights;
  delete cfg.heavyPageBytes;
  await prisma.workspace.update({
    where: { id: ws!.id },
    data: { auditConfig: cfg as never },
  });
  await prisma.$disconnect();
});

/**
 * The audit screen has always printed "Thresholds set in Settings, not by AI".
 * There was no such setting: `Workspace.auditConfig` was read by the scorer and
 * written by nothing at all.
 */
test("audit scoring is configurable, and the numbers reach the database", async ({ page }) => {
  await page.goto("/settings/admin");
  await page.locator("#audit-scoring").scrollIntoViewIfNeeded();

  // All eight categories are on screen — the level people actually think at.
  for (const key of [
    "security",
    "email",
    "legal",
    "seo",
    "conversion",
    "accessibility",
    "performance",
    "structure",
  ]) {
    await expect(page.getByTestId(`weight-${key}`)).toBeVisible();
  }

  await page.getByTestId("weight-legal").fill("40");
  await page.getByTestId("weight-performance").fill("2");
  await page.getByTestId("verdict-strong").fill("50");
  await page.getByTestId("verdict-possible").fill("30");
  await page.getByTestId("heavy-page-mb").fill("2");
  await page.getByTestId("scoring-save").click();
  await expect(page.getByTestId("scoring-saved")).toBeVisible();

  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  const cfg = ws!.auditConfig as Record<string, never>;
  expect((cfg.categoryWeights as unknown as Record<string, number>).legal).toBe(40);
  expect((cfg.categoryWeights as unknown as Record<string, number>).performance).toBe(2);
  expect(cfg.verdict as unknown).toEqual({ strong: 50, possible: 30 });
  expect(cfg.heavyPageBytes as unknown).toBe(2_000_000);
});

test("a band order that would strand a verdict is refused", async ({ page }) => {
  await page.goto("/settings/admin");
  await page.locator("#audit-scoring").scrollIntoViewIfNeeded();
  await page.getByTestId("verdict-strong").fill("30");
  await page.getByTestId("verdict-possible").fill("40");
  await page.getByTestId("scoring-save").click();
  // Otherwise one of the three verdicts could never happen, and the panel
  // would be quietly lying about what it does.
  await expect(page.getByTestId("scoring-error")).toContainText("above the Possible");
});

test("switching every category off is refused rather than silently disabling the module", async ({
  page,
}) => {
  await page.goto("/settings/admin");
  await page.locator("#audit-scoring").scrollIntoViewIfNeeded();
  for (const key of [
    "security",
    "email",
    "legal",
    "seo",
    "conversion",
    "accessibility",
    "performance",
    "structure",
  ]) {
    await page.getByTestId(`weight-${key}`).fill("0");
  }
  await page.getByTestId("scoring-save").click();
  await expect(page.getByTestId("scoring-error")).toContainText("at least one category", {
    ignoreCase: true,
  });
});

test("the scoring can be put back to the defaults", async ({ page }) => {
  await page.goto("/settings/admin");
  await page.locator("#audit-scoring").scrollIntoViewIfNeeded();
  await page.getByTestId("weight-legal").fill("40");
  await page.getByTestId("verdict-strong").fill("50");
  await page.getByTestId("verdict-possible").fill("30");
  await page.getByTestId("scoring-save").click();
  await expect(page.getByTestId("scoring-saved")).toBeVisible();

  await page.getByTestId("scoring-reset").click();
  await expect(page.getByText("Currently on the defaults.")).toBeVisible();

  // The keys are DELETED rather than written back, so the workspace keeps
  // following the product's defaults as they change.
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  const cfg = (ws!.auditConfig ?? {}) as Record<string, unknown>;
  expect(cfg.categoryWeights).toBeUndefined();
  expect(cfg.verdict).toBeUndefined();
});
