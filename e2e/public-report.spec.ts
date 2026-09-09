import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * P1/3a+3b — the public audit report.
 *
 * Signed OUT: this is what a prospect sees. The pitch angle is written FOR US,
 * about how to sell to the person reading it, and it used to render right here.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const prisma = new PrismaClient();
const PITCH = "PITCHLEAK their site is ancient, lead with the mobile failure";
// beforeAll runs once PER WORKER and the config is fullyParallel, so a
// timestamp alone collides on the unique slug. Each worker gets its own.
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const AUDIT_URL = `https://pelda-public-${RUN}.hu`;
let slug = "";

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const audit = await prisma.auditResult.create({
    data: {
      workspaceId: ws!.id,
      url: AUDIT_URL,
      status: "done",
      score: 71,
      verdict: "STRONG",
      flags: ["nincs mobil nézet"],
      checks: [
        { key: "https", label: "HTTPS", pass: true, detail: null },
        { key: "mobile", label: "Mobil nézet", pass: false, detail: "hiányzó viewport" },
      ],
      screenshots: {
        desktop: "audits/e2e-public-desktop.png",
        mobile: "audits/e2e-public-mobile.png",
      },
      pitchSummary: PITCH,
      expiresAt: new Date(Date.now() + 9e10),
    },
  });
  slug = `e2e-public-${RUN}`;
  await prisma.auditShare.create({
    data: {
      workspaceId: ws!.id,
      auditId: audit.id,
      slug,
      expiresAt: new Date(Date.now() + 9e10),
    },
  });
});

test.afterAll(async () => {
  await prisma.auditShare.deleteMany({ where: { slug } });
  await prisma.auditResult.deleteMany({ where: { url: AUDIT_URL } });
  await prisma.$disconnect();
});

test("the public report never shows the pitch angle or internal framing", async ({ page }) => {
  await page.goto(`/share/${slug}`);

  const body = await page.locator("body").innerText();
  expect(body).not.toContain("PITCHLEAK");
  expect(body).not.toMatch(/pitch angle/i);
  // The old closing line explained our scoring in terms of how weak they are.
  expect(body).not.toMatch(/weak site/i);
  expect(body).not.toMatch(/strong opportunity/i);

  // The facts are still there.
  expect(body).toContain(`pelda-public-${RUN}.hu`);
  expect(body).toMatch(/HTTPS/);
});

test("screenshots render on the public page without a session", async ({ page }) => {
  await page.goto(`/share/${slug}`);
  const shots = page.locator('img[alt="Asztali nézet"], img[alt="Mobil nézet"]');
  await expect(shots).toHaveCount(2);
  // The public image route must be the source — /api/files needs a session.
  await expect(shots.first()).toHaveAttribute("src", new RegExp(`/api/share/${slug}/shot/`));
});

test("the screenshot route refuses anything but the two known captures", async ({ request }) => {
  expect((await request.get(`/api/share/${slug}/shot/desktop`)).status()).toBeLessThan(500);
  expect((await request.get(`/api/share/${slug}/shot/../../etc/passwd`)).status()).toBe(404);
  expect((await request.get(`/api/share/nonexistent-slug/shot/desktop`)).status()).toBe(404);
});
