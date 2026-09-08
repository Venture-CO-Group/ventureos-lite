import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";

/**
 * Sector reports (playbook-v4 P12/2), through the real pages.
 *
 * The batch itself spends money on Places and on sixty audits, so it is not
 * driven here — the unit tests cover the arithmetic and the anonymity. What
 * this proves is the half a prospect touches: a published report is readable,
 * the file is behind the dual-consent form, and a download becomes a lead
 * carrying the sector it came from.
 */
const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

const SLUG = `e2e-report-${Date.now()}`;
let reportId = "";

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  const report = await prisma.sectorReport.create({
    data: {
      workspaceId: ws!.id,
      sector: "fogorvos",
      location: "Debrecen",
      title: "E2E Sector Report",
      status: "published",
      slug: SLUG,
      cap: 20,
      foundCount: 30,
      auditedCount: 18,
      publishedAt: new Date(),
      // A published report without a rendered file cannot be downloaded — see
      // the test at the bottom, which takes it away again to prove it.
      pdfPath: `sector-reports/${"e2e"}.pdf`,
      stats: {
        audited: 18,
        found: 30,
        scoreMedian: 54,
        scoreBands: { weak: 9, middling: 6, strong: 3 },
        loadMsMedian: 2600,
        failing: [
          { key: "impresszum", label: "nincs impresszum", share: 0.61, of: 18 },
          { key: "dmarc", label: "nincs DMARC (levélhamisítás elleni védelem)", share: 0.5, of: 18 },
        ],
        categories: [{ category: "legal", median: 70 }],
      },
      narrative: { summary: "A megmért oldalak több mint fele elavult." },
    },
  });
  reportId = report.id;

  /**
   * Clear this suite's own rate-limit ledger.
   *
   * The download form allows ten per network per DAY, which is the right rule
   * and made the spec unrunnable more than ten times in one day: the eleventh
   * run got "Mára elfogyott a letöltési keret erről a hálózatról." and reported
   * a defect that did not exist. `auth.setup.ts` clears `loginAttempt` for
   * exactly the same reason; this is the Redis-side equivalent.
   */
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
  try {
    const keys = await redis.keys("rl:sector-download:*");
    if (keys.length > 0) await redis.del(...keys);
  } finally {
    await redis.quit();
  }
});

test.afterAll(async () => {
  await prisma.sectorReportDownload.deleteMany({ where: { reportId } });
  await prisma.lead.deleteMany({ where: { contactName: "E2E Report Reader" } });
  await prisma.sectorReport.deleteMany({ where: { id: reportId } });
});

test("a published report is readable, and its numbers are visible before the form", async ({ page }) => {
  await page.goto(`/reports/${SLUG}`);
  await expect(page.getByRole("heading", { name: /e2e sector report/i })).toBeVisible();
  await expect(page.getByText("A megmért oldalak több mint fele elavult.")).toBeVisible();
  // The teaser is the real finding, not a blurred screenshot.
  await expect(page.getByText("nincs impresszum")).toBeVisible();
  await expect(page.getByText("61%")).toBeVisible();
  await expect(page.getByText(/egyetlen vállalkozás sem azonosítható/i)).toBeVisible();
});

test("the file needs the required consent, and marketing consent stays separate", async ({ page }) => {
  await page.goto(`/reports/${SLUG}`);

  await page.getByTestId("report-name").fill("E2E Report Reader");
  await page.getByTestId("report-email").fill(`report${Date.now()}@example.com`);

  // Nothing to submit until the required box is ticked.
  await expect(page.getByTestId("report-submit")).toBeDisabled();
  await page.getByTestId("report-consent-service").check();
  // …and the marketing box is untouched by that.
  await expect(page.getByTestId("report-consent-marketing")).not.toBeChecked();
  await expect(page.getByTestId("report-submit")).toBeEnabled();

  await page.getByTestId("report-submit").click();
  await expect(page.getByTestId("report-download")).toBeVisible({ timeout: 20_000 });

  const download = await prisma.sectorReportDownload.findFirst({ where: { reportId } });
  expect(download!.serviceConsent).toBe(true);
  expect(download!.marketingConsent).toBe(false);
  expect(download!.consentTextVersion).toBeTruthy();

  // The download became a lead, tagged with where it came from.
  const lead = await prisma.lead.findUnique({ where: { id: download!.leadId! } });
  expect(lead!.contactName).toBe("E2E Report Reader");
  expect(lead!.signals).toEqual(["Szektor-riport: fogorvos"]);
});

test("an unpublished report is not readable at all", async ({ page }) => {
  await prisma.sectorReport.update({ where: { id: reportId }, data: { status: "ready" } });
  const res = await page.goto(`/reports/${SLUG}`);
  expect(res!.status()).toBe(404);
  await prisma.sectorReport.update({ where: { id: reportId }, data: { status: "published" } });
});

test("a report with no rendered file cannot be downloaded", async ({ page }) => {
  await prisma.sectorReport.update({ where: { id: reportId }, data: { pdfPath: null } });
  await page.goto(`/reports/${SLUG}`);
  await page.getByTestId("report-name").fill("E2E Report Reader");
  await page.getByTestId("report-email").fill(`nofile${Date.now()}@example.com`);
  await page.getByTestId("report-consent-service").check();
  await page.getByTestId("report-submit").click();
  await expect(page.getByText("Ez a riport nem érhető el.")).toBeVisible({ timeout: 20_000 });
  await prisma.sectorReport.update({
    where: { id: reportId },
    data: { pdfPath: "sector-reports/e2e.pdf" },
  });
});

test("the reports index lists what is published", async ({ page }) => {
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "szektor-riportok" })).toBeVisible();
  await expect(page.getByText("E2E Sector Report")).toBeVisible();
});
