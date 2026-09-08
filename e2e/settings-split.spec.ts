import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import { signInAs, E2E_PASSWORD } from "./helpers/auth";

/**
 * Settings is yours; admin settings is the software's.
 *
 * "A settings oldal szedd ketté: a settings maradjon a saját profil beállításai,
 * plusz tegyél ide profilkép feltöltési lehetőséget és legyen egy külön admin
 * settings ami a szoftver beállításait tartalmazza — ezt csak én láthatom mint
 * super admin."
 *
 * Two things are worth proving here and neither is visual: that the gate holds
 * for somebody who is an OWNER but not a super admin — the case a role-based
 * check would have got wrong — and that an uploaded photo actually comes back
 * from the serving route.
 */
const prisma = new PrismaClient();
const OWNER_EMAIL = "settings-owner@ventureco.test";

test.afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER_EMAIL } });
  await prisma.$disconnect();
});

test("the personal page holds the profile, and nothing about the software", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-profile")).toBeVisible();
  // Moved out: these are software settings.
  await expect(page.getByTestId("settings-branding")).toHaveCount(0);
  await expect(page.getByTestId("settings-fields")).toHaveCount(0);
  /**
   * And one concern per page, not five in a scroll (P8/3).
   *
   * The personal page used to carry the profile, the password, the
   * notification matrix, the mailbox and the extension tokens in one column.
   * "Settings" is the screen people arrive at knowing exactly which one thing
   * they came to change.
   */
  await expect(page.getByTestId("settings-notifications")).toHaveCount(0);
  await expect(page.getByTestId("settings-nav")).toBeVisible();
  await page.getByTestId("settings-nav-notifications").click();
  // Patient on purpose: in dev the first visit to a route pays for its
  // compile, and the default five seconds is not enough for a cold one. The
  // navigation is not slow in a built app.
  await expect(page).toHaveURL(/\/settings\/notifications$/, { timeout: 30_000 });
  await expect(page.getByTestId("settings-notifications")).toBeVisible();
  // The menu says where you are.
  await expect(page.getByTestId("settings-nav-notifications")).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("a super admin can reach the admin page, and its sections from a menu", async ({ page }) => {
  await page.goto("/settings");
  await page.getByTestId("settings-admin-link").click();
  await expect(page).toHaveURL(/\/settings\/admin$/);

  // The index is a map now, not twenty panels in a column.
  await expect(page.getByTestId("settings-branding")).toHaveCount(0);
  await expect(page.getByTestId("admin-card-members")).toBeVisible();
  await expect(page.getByTestId("admin-card-workspace")).toBeVisible();

  await page.getByTestId("admin-card-workspace").click();
  await expect(page).toHaveURL(/\/settings\/admin\/workspace$/, { timeout: 30_000 });
  await expect(page.getByTestId("settings-branding")).toBeVisible();

  // And the menu carries across, so the next section is one click away.
  await page.getByTestId("settings-nav-members").click();
  await expect(page).toHaveURL(/\/settings\/admin\/members$/, { timeout: 30_000 });
  await expect(page.getByTestId("settings-users")).toBeVisible();
  await expect(page.getByTestId("settings-branding")).toHaveCount(0);
});

/**
 * THE GATE, against the case that matters.
 *
 * This user is an OWNER of the workspace — the highest workspace role there is —
 * and still cannot see the admin page, because administering the INSTALLATION is
 * a different question from administering a workspace. If super admin had been
 * an entry in the Role enum, this test would fail: an Owner can edit
 * memberships, so an Owner could grant it to themselves.
 */
test("an Owner who is not a super admin gets a 404, not a refusal", async ({ browser }) => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  const passwordHash = await hashPassword(E2E_PASSWORD);
  const user = await prisma.user.upsert({
    where: { email: OWNER_EMAIL },
    update: { passwordHash, isSuperAdmin: false, lockedUntil: null },
    create: { email: OWNER_EMAIL, name: "Settings Owner", passwordHash },
  });
  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId: ws!.id } },
    update: { role: "OWNER" },
    create: { userId: user.id, workspaceId: ws!.id, role: "OWNER" },
  });

  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    await signInAs(context, OWNER_EMAIL);
    const page = await context.newPage();

    // Their own settings work.
    await page.goto("/settings");
    await expect(page.getByTestId("settings-profile")).toBeVisible();
    // And the link to the admin page is not even offered.
    await expect(page.getByTestId("settings-admin-link")).toHaveCount(0);

    // A page that says "you may not see this" tells you it exists.
    /**
     * Every admin route, not just the index.
     *
     * The gate is a named helper each page calls rather than a Next layout, so
     * that it is visible where it matters — and the cost of that choice is
     * that somebody can forget it on a page they add. A unit test over the
     * route table checks the call is present; this checks it actually bites.
     */
    for (const route of [
      "/settings/admin",
      "/settings/admin/members",
      "/settings/admin/workspace",
      "/settings/admin/sales",
      "/settings/admin/audit",
      "/settings/admin/integrations",
      "/settings/admin/security",
    ]) {
      const res = await page.goto(route);
      expect(res?.status(), route).toBe(404);
    }
    await expect(page.getByTestId("settings-branding")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a photo can be uploaded, is served back, and can be removed", async ({ page }) => {
  await page.goto("/settings");

  // A one-pixel PNG is a real PNG, which is the point: the route accepts it on
  // its content type and the serving route hands the same bytes back.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.getByTestId("profile-avatar-input").setInputFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: png,
  });

  await expect(page.getByTestId("profile-message")).toContainText("Photo updated.");
  const img = page.getByTestId("profile-avatar");
  await expect(img).toBeVisible();

  // It comes back through the authenticated route, with an image content type.
  const src = await img.getAttribute("src");
  expect(src).toMatch(/^\/api\/users\/[^/]+\/avatar/);
  const fetched = await page.request.get(src!);
  expect(fetched.status()).toBe(200);
  expect(fetched.headers()["content-type"]).toBe("image/png");
  expect((await fetched.body()).byteLength).toBe(png.byteLength);

  /**
   * And it appears where the person is REPRESENTED, not only where it was
   * uploaded. A photo that shows up in Settings and nowhere else is a setting.
   */
  await page.reload();
  await expect(page.getByTestId("shell-avatar")).toBeVisible();
  await expect(page.getByTestId("account-menu-avatar")).toBeVisible();

  await page.getByTestId("profile-avatar-remove").click();
  await expect(page.getByTestId("profile-avatar-empty")).toBeVisible();
  // Back to the gradient disc with initials.
  await page.reload();
  await expect(page.getByTestId("shell-avatar")).toHaveCount(0);
});

test("the upload refuses a file that is not an image", async ({ page }) => {
  await page.goto("/settings");
  const res = await page.request.post("/api/me/avatar", {
    headers: { "content-type": "application/pdf" },
    data: "not an image",
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toMatch(/JPEG, PNG or WebP/);
});
