import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const prisma = new PrismaClient();
const FILES = process.env.FILES_DIR!;

/**
 * Then and now.
 *
 * The captures and the delta already existed; this is the view. What only a
 * browser can prove is that BOTH images actually load — the file route derives
 * the owning workspace from the audit id embedded in the filename, so a
 * mismatch is a 404 and a silently broken image rather than an error.
 *
 * ── WHY THE CLEANUP IS AT THE START ─────────────────────────────────────────
 *
 * Both tests here fabricate audit rows, and both used to delete them on their
 * last line. That works right up to the first failure: a run that stops in the
 * middle leaves a `done` audit for the same URL behind, the next run's audit is
 * served from the 30-day cache instead of being taken again, and the captures
 * it points at are files an earlier run has since removed. The image then
 * fails to load and the test fails for a reason that has nothing to do with
 * the thing it is testing — and it keeps failing until somebody clears the
 * table by hand. Deleting first makes each run start from nothing.
 */
const URLS = ["https://ventureco.agency", "https://example.com"];

test.beforeEach(async () => {
  await prisma.auditResult.deleteMany({ where: { url: { in: URLS } } });
});

test.afterAll(async () => {
  await prisma.auditResult.deleteMany({ where: { url: { in: URLS } } });
  await prisma.$disconnect();
});
test("the before/after wipe loads both captures", async ({ page }) => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  // A real audit first, so there are genuine captures on disk.
  await page.goto("/audit");
  await page.getByPlaceholder("Website URL").fill("https://ventureco.agency");
  await page.getByRole("button", { name: "Run audit" }).click();
  await expect(page.getByText("Opportunity score")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("cached 30 days").first()).toBeVisible({ timeout: 120_000 });

  const done = await prisma.auditResult.findFirst({
    where: { workspaceId: ws!.id, url: "https://ventureco.agency", status: "done" },
    orderBy: { createdAt: "desc" },
  });
  const shots = done!.screenshots as { desktop?: string; mobile?: string };

  // Fabricate the PREVIOUS run: same captures, an older date, a worse score,
  // and a delta pointing at it. Re-running the real audit would just hit the
  // 30-day cache.
  await mkdir(join(FILES, "audits"), { recursive: true });
  const prev = await prisma.auditResult.create({
    data: {
      workspaceId: ws!.id, url: "https://ventureco.agency", status: "done",
      score: 61, verdict: "STRONG", flags: [], checks: done!.checks as never,
      screenshots: {}, schemaVersion: 4,
      createdAt: new Date(Date.now() - 40 * 86400000),
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  // Named after the previous audit's OWN id: /api/files derives the owning
  // workspace from the id embedded in the filename, so a made-up name is
  // (correctly) a 404.
  for (const k of ["desktop", "mobile"] as const) {
    const src = shots[k];
    if (!src) continue;
    const name = `${prev.id}-${k}.png`;
    await copyFile(join(FILES, src), join(FILES, "audits", name));
  }
  await prisma.auditResult.update({
    where: { id: prev.id },
    data: { screenshots: { desktop: `audits/${prev.id}-desktop.png`, mobile: `audits/${prev.id}-mobile.png` } },
  });
  await prisma.auditResult.update({
    where: { id: done!.id },
    data: { delta: { previousAuditId: prev.id, previousAt: prev.createdAt.toISOString(),
      scoreFrom: 61, scoreTo: done!.score, scoreDelta: done!.score - 61,
      categories: [], resolved: [], broken: [], significance: "better" } as never },
  });

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/audit");
  await page.getByPlaceholder("Website URL").fill("https://ventureco.agency");
  await page.getByRole("button", { name: "Run audit" }).click();
  await expect(page.getByTestId("screenshot-compare")).toBeVisible({ timeout: 60_000 });
  // The score movement is stated, in the right direction: a LOWER opportunity
  // score means the site improved.
  await expect(page.getByTestId("screenshot-compare")).toContainText(`61 → ${done!.score}`);

  await page.getByTestId("compare-slider").fill("45");

  // Both <img> elements have to have decoded. A broken one renders as an icon
  // and would otherwise pass every visibility assertion.
  for (const testid of ["compare-before"] as const) {
    const ok = await page.getByTestId(testid).evaluate((el) => {
      const img = el as HTMLImageElement;
      return img.complete && img.naturalWidth > 0;
    });
    expect(ok, `${testid} did not load`).toBe(true);
  }
  const nowOk = await page
    .getByTestId("screenshot-compare")
    .locator('img[alt="Now"]')
    .evaluate((el) => {
      const img = el as HTMLImageElement;
      return img.complete && img.naturalWidth > 0;
    });
  expect(nowOk, "the current capture did not load").toBe(true);

  // Both form factors were captured, so the toggle is offered.
  await expect(page.getByTestId("compare-desktop")).toBeVisible();
  await page.getByTestId("compare-mobile").click();
  await expect(page.getByTestId("compare-before")).toBeVisible();
});

test("nothing is rendered when there is no previous run to compare against", async ({ page }) => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });

  await page.goto("/audit");
  await page.getByPlaceholder("Website URL").fill("https://example.com");
  await page.getByRole("button", { name: "Run audit" }).click();
  await expect(page.getByText("cached 30 days").first()).toBeVisible({ timeout: 120_000 });

  // A first audit has nothing to compare, and an empty box beside a real
  // screenshot would read as "your site broke" — a claim we would be inventing.
  await expect(page.getByTestId("screenshot-compare")).toHaveCount(0);
  expect(ws).toBeTruthy();
});
