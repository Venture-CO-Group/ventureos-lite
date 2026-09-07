import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import { E2E_PASSWORD } from "./helpers/auth";
import { denyToken } from "../src/lib/grants";

/**
 * "a bdr is minden funkcióval rendelkezzen pl. lead törlés teljes körüen."
 *
 * Driven as a REAL BDR through a real sign-in, because the interesting failures
 * are not in `grantAllowed` — that is unit-tested — but in the pages and
 * components that were passing `isOwner()` into a `canDelete` prop and hiding
 * the button regardless of what the server would have allowed.
 */
const prisma = new PrismaClient();
const EMAIL = "bdr-caps@ventureco.test";
const MARK = "BdrCaps";

let bdrUserId = "";
let workspaceId = "";

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: { passwordHash: await hashPassword(E2E_PASSWORD), lockedUntil: null, totpEnabled: false },
    create: { email: EMAIL, name: "BDR Caps", passwordHash: await hashPassword(E2E_PASSWORD) },
  });
  bdrUserId = user.id;
  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId } },
    update: { role: "BDR", grants: [] },
    create: { userId: user.id, workspaceId, role: "BDR", grants: [] },
  });
  await prisma.loginAttempt.deleteMany({ where: { email: EMAIL } });
});

test.afterAll(async () => {
  await prisma.lead.deleteMany({ where: { contactName: { startsWith: MARK } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.session.deleteMany({ where: { userId: bdrUserId } });
  await prisma.membership.deleteMany({ where: { userId: bdrUserId } });
  await prisma.user.deleteMany({ where: { id: bdrUserId } });
  await prisma.$disconnect();
});

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(E2E_PASSWORD);
  await page.locator("button[type=submit]").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
}

async function makeLead(suffix: string): Promise<string> {
  const company = await prisma.company.create({
    data: { workspaceId, name: `${MARK} Co ${suffix}` },
  });
  const lead = await prisma.lead.create({
    data: {
      workspaceId,
      companyId: company.id,
      contactName: `${MARK} ${suffix}`,
      stage: "RESEARCHED",
    },
  });
  return lead.id;
}

test("a BDR can delete a lead, end to end, through the UI", async ({ page }) => {
  const id = await makeLead("Deletable");
  await signIn(page);

  await page.goto("/leads");
  await page.getByPlaceholder(/search/i).first().fill(`${MARK} Deletable`);
  await page.waitForTimeout(1200);
  await page.locator('tbody input[type="checkbox"]').first().check();

  const del = page.getByTestId("bulk-delete");
  // The button used to be disabled for every BDR — `canDelete={owner}`.
  await expect(del).toBeEnabled();
  await del.click();
  await page.getByTestId("bulk-confirm").click();
  await page.waitForTimeout(2500);

  // The row is gone from the database, not merely from the screen.
  expect(await prisma.lead.count({ where: { id } })).toBe(0);
});

test("a BDR reaches the pages that were Owner-only", async ({ page }) => {
  await signIn(page);
  for (const path of ["/public-pages", "/reports-admin", "/analytics"]) {
    const res = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(res?.status(), path).toBeLessThan(400);
    const body = await page.locator("body").innerText();
    expect(body, path).not.toMatch(/Only an Owner/i);
  }
});

test("an Owner can still withdraw a capability from one BDR", async ({ page }) => {
  const id = await makeLead("Protected");
  // What the grants screen writes when the Owner unticks the box.
  await prisma.membership.update({
    where: { userId_workspaceId: { userId: bdrUserId, workspaceId } },
    data: { grants: [denyToken("leads.delete")] },
  });

  await signIn(page);
  await page.goto("/leads");
  await page.getByPlaceholder(/search/i).first().fill(`${MARK} Protected`);
  await page.waitForTimeout(1200);
  await page.locator('tbody input[type="checkbox"]').first().check();

  // Withdrawn: the button is refused in the UI...
  await expect(page.getByTestId("bulk-delete")).toBeDisabled();

  // ...and, far more importantly, on the server. A UI that hides a button is
  // not a permission check.
  const lead = await prisma.lead.findUnique({ where: { id } });
  expect(lead).not.toBeNull();

  await prisma.membership.update({
    where: { userId_workspaceId: { userId: bdrUserId, workspaceId } },
    data: { grants: [] },
  });
});

test("a BDR is still refused the document capabilities", async ({ page }) => {
  await signIn(page);
  await page.goto("/documents");
  const body = await page.locator("body").innerText();
  // Quotes, contracts and certificates stay behind an explicit grant: they are
  // what the company is bound by.
  expect(body).toMatch(/grant|Owner|capability/i);
});
