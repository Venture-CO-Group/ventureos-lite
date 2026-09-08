import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import { E2E_PASSWORD } from "./helpers/auth";

const prisma = new PrismaClient();
const INVITEE = "invitee@ventureco.test";
const VICTIM = "suspendme@ventureco.test";

let workspaceId = "";
let victimId = "";

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  const victim = await prisma.user.upsert({
    where: { email: VICTIM },
    update: { passwordHash: await hashPassword(E2E_PASSWORD), lockedUntil: null },
    create: { email: VICTIM, name: "Suspend Me", passwordHash: await hashPassword(E2E_PASSWORD) },
  });
  victimId = victim.id;
  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: victim.id, workspaceId } },
    update: { role: "BDR", suspendedAt: null, suspendedBy: null },
    create: { userId: victim.id, workspaceId, role: "BDR", grants: [] },
  });
  await prisma.loginAttempt.deleteMany({ where: { email: { in: [VICTIM, INVITEE] } } });
});

test.afterAll(async () => {
  for (const email of [INVITEE, VICTIM]) {
    const u = await prisma.user.findUnique({ where: { email } });
    if (!u) continue;
    await prisma.passwordResetToken.deleteMany({ where: { userId: u.id } });
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.membership.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }
  await prisma.$disconnect();
});

test("inviting somebody creates the account and hands back a link they set their own password with", async ({
  page,
}) => {
  await page.goto("/settings/admin/members");
  await page.getByTestId("invite-user").click();
  await page.getByTestId("invite-name").fill("New Person");
  await page.getByTestId("invite-email").fill(INVITEE);
  await page.getByTestId("invite-role").selectOption("BDR");
  await page.getByTestId("invite-submit").click();

  const url = await page.getByTestId("reset-link-url").textContent();
  expect(url).toContain("/reset/");

  const user = await prisma.user.findUnique({ where: { email: INVITEE } });
  expect(user).not.toBeNull();
  const membership = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: user!.id, workspaceId } },
  });
  expect(membership?.role).toBe("BDR");

  // A live, unused token — this is what replaces the Owner typing a password
  // into a chat window.
  const token = await prisma.passwordResetToken.findFirst({
    where: { userId: user!.id, usedAt: null },
  });
  expect(token).not.toBeNull();

  // And it shows as Invited, not as "no password", which reads like a fault.
  await page.goto("/settings/admin/members");
  await expect(page.getByTestId(`user-status-${user!.id}`)).toHaveText("Invited");
});

test("a role can be changed from the table", async ({ page }) => {
  await page.goto("/settings/admin/members");
  await page.getByTestId(`user-role-${victimId}`).selectOption("ADMIN");
  await expect(page.getByTestId("users-message")).toContainText("ADMIN");

  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: victimId, workspaceId } },
  });
  expect(m?.role).toBe("ADMIN");

  await prisma.membership.update({
    where: { userId_workspaceId: { userId: victimId, workspaceId } },
    data: { role: "BDR" },
  });
});

test("suspending somebody stops them immediately, and restoring lets them back", async ({
  browser,
  page,
}) => {
  // They are signed in first, so the suspension has a live session to bite.
  // Explicitly signed OUT: the project's storageState would otherwise hand
  // this context the Owner's cookies and /login would redirect away.
  const theirs = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const theirPage = await theirs.newPage();
  await theirPage.goto("/login");
  await theirPage.locator("#email").fill(VICTIM);
  await theirPage.locator("#password").fill(E2E_PASSWORD);
  await theirPage.locator("button[type=submit]").click();
  await theirPage.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });

  // ---- suspend -----------------------------------------------------------
  await page.goto("/settings/admin/members");
  page.once("dialog", (d) => d.accept());
  await page.getByTestId(`user-suspend-${victimId}`).click();
  await expect(page.getByTestId("users-message")).toContainText("suspended");

  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: victimId, workspaceId } },
  });
  expect(m?.suspendedAt).not.toBeNull();
  expect(m?.suspendedBy).toBeTruthy();

  /**
   * The assertion the whole feature rests on.
   *
   * A suspension that only takes effect at the NEXT sign-in is not a
   * suspension: somebody stood down at 14:00 with a browser already open would
   * keep reading the workspace until their token expired, up to thirty days.
   */
  await theirPage.goto("/leads");
  await theirPage.waitForURL(/\/login/, { timeout: 20_000 });
  expect(theirPage.url()).toContain("/login");

  // And they cannot sign in again while suspended.
  await theirPage.locator("#email").fill(VICTIM);
  await theirPage.locator("#password").fill(E2E_PASSWORD);
  await theirPage.locator("button[type=submit]").click();
  await theirPage.waitForTimeout(2000);
  expect(theirPage.url()).toContain("/login");

  // ---- restore -----------------------------------------------------------
  await page.goto("/settings/admin/members");
  await expect(page.getByTestId(`user-status-${victimId}`)).toHaveText("Suspended");
  await page.getByTestId(`user-suspend-${victimId}`).click();
  await expect(page.getByTestId("users-message")).toContainText("can sign in again");

  await theirPage.goto("/login");
  await theirPage.locator("#email").fill(VICTIM);
  await theirPage.locator("#password").fill(E2E_PASSWORD);
  await theirPage.locator("button[type=submit]").click();
  await theirPage.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });

  await theirs.close();
});

test("an Owner is offered the destructive controls only while somebody else can take over", async ({
  page,
}) => {
  /**
   * The guard itself is a pure function with its own tests
   * (`isLastLiveOwner`) — the same one the server action uses to refuse, so the
   * hidden button and the refused mutation cannot disagree. What is checked
   * HERE is that the panel is actually wired to it.
   */
  const owners = await prisma.membership.findMany({
    where: { workspaceId, role: "OWNER", suspendedAt: null },
    select: { userId: true },
  });
  expect(owners.length).toBeGreaterThan(0);

  await page.goto("/settings/admin/members");

  if (owners.length === 1) {
    const last = owners[0]!.userId;
    await expect(page.getByTestId(`user-role-${last}`)).toBeDisabled();
    // Suspend and Remove are not rendered at all — a disabled destructive
    // button only invites somebody to keep clicking it.
    await expect(page.getByTestId(`user-suspend-${last}`)).toHaveCount(0);
    await expect(page.getByTestId(`user-remove-${last}`)).toHaveCount(0);
    return;
  }

  // More than one Owner: every one of them is demotable, and at least one that
  // is not the signed-in user carries the destructive controls.
  const runner = await prisma.user.findUnique({ where: { email: "e2e-runner@ventureco.test" } });
  const other = owners.find((o) => o.userId !== runner?.id);
  expect(other, "expected a second Owner").toBeTruthy();
  await expect(page.getByTestId(`user-role-${other!.userId}`)).toBeEnabled();
  await expect(page.getByTestId(`user-suspend-${other!.userId}`)).toBeVisible();

  // And you are never offered them against yourself: the next request would
  // fail to resolve a context and drop you at the login form.
  await expect(page.getByTestId(`user-suspend-${runner!.id}`)).toHaveCount(0);
});

test("a session list shows which devices somebody is signed in on", async ({ page }) => {
  await page.goto("/settings/admin/members");
  const me = await prisma.membership.findFirst({
    where: { workspaceId },
    include: { user: { select: { id: true, email: true } } },
  });
  // Whoever the runner is, they have at least this browser.
  const runner = await prisma.user.findUnique({ where: { email: "e2e-runner@ventureco.test" } });
  await page.getByTestId(`user-sessions-${runner!.id}`).click();
  await expect(page.getByTestId("session-row").first()).toBeVisible();
  await expect(page.getByTestId("session-row").first()).toContainText(/Chrome|Browser/);
  expect(me).toBeTruthy();
});
