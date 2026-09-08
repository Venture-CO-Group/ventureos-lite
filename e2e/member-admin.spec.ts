import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const TARGET = "admin-flow-target@ventureco.test";
const TAKER = "admin-flow-taker@ventureco.test";
let workspaceId = "";
let targetId = "";
let takerId = "";

test.beforeEach(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  await cleanup();

  for (const [email, name] of [
    [TARGET, "Flow Target"],
    [TAKER, "Flow Taker"],
  ] as const) {
    const user = await prisma.user.create({
      data: { email, name, passwordHash: "x", totpEnabled: true, totpSecret: "JBSWY3DPEHPK3PXP" },
    });
    await prisma.membership.create({
      data: { userId: user.id, workspaceId, role: "BDR", grants: [], state: "ACTIVE" },
    });
    if (email === TARGET) targetId = user.id;
    else takerId = user.id;
  }
});

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { in: [TARGET, TAKER] } } });
  for (const u of users) {
    await prisma.lead.updateMany({ where: { ownerId: u.id }, data: { ownerId: null } });
    await prisma.task.updateMany({ where: { assigneeId: u.id }, data: { assigneeId: null } });
    await prisma.emailChange.deleteMany({ where: { userId: u.id } });
    await prisma.membershipEvent.deleteMany({ where: { userId: u.id } });
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.teamMember.deleteMany({ where: { userId: u.id } });
    await prisma.membership.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }
}

test.afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function openDrawer(page: import("@playwright/test").Page, userId: string) {
  await page.goto("/settings/admin/members");
  await expect(page.getByTestId("settings-users")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`open-member-${userId}`).click();
  await expect(page.getByTestId("member-drawer")).toBeVisible();
}

/**
 * The member administration actions (§4), through the screen.
 *
 * Each has its own confirmation semantics, and the severities differ: a
 * profile edit saves on a button, a 2FA reset demands a written reason, and
 * removal is a four-step flow.
 */
test("a profile edit saves, and a bad timezone is refused", async ({ page }) => {
  await openDrawer(page, targetId);

  await page.getByTestId("profile-job-title").fill("Senior BDR");
  await page.getByTestId("profile-timezone").fill("Nowhere/Nothing");
  await page.getByTestId("profile-save").click();
  /**
   * The timezone decides when their start-of-day email arrives. An
   * unparseable value degrades to UTC — a digest at the wrong hour every day
   * with nothing to explain it — so it is checked rather than trusted.
   */
  await expect(page.getByTestId("member-actions-message")).toContainText(/not a timezone/i);

  await page.getByTestId("profile-timezone").fill("Europe/Budapest");
  await page.getByTestId("profile-save").click();
  await expect(page.getByTestId("member-actions-message")).toContainText("Profile saved");

  const user = await prisma.user.findUniqueOrThrow({ where: { id: targetId } });
  expect(user.jobTitle).toBe("Senior BDR");
  expect(user.timezone).toBe("Europe/Budapest");
  // On the timeline with the before and after, not just "profile updated".
  const ev = await prisma.membershipEvent.findFirstOrThrow({
    where: { userId: targetId, kind: "profile_changed" },
  });
  expect(ev.after).toMatchObject({ jobTitle: "Senior BDR" });
});

test("an email change is staged, not applied", async ({ page }) => {
  await openDrawer(page, targetId);
  await page.getByTestId("email-change-new").fill("moved@ventureco.test");
  await page.getByTestId("email-change-send").click();
  await expect(page.getByTestId("member-actions-message")).toContainText("old address works");

  /**
   * The email IS the sign-in identity, so a typo locks somebody out and nobody
   * finds out until they try to sign in. Nothing is applied until the link is
   * clicked.
   */
  const user = await prisma.user.findUniqueOrThrow({ where: { id: targetId } });
  expect(user.email).toBe(TARGET);
  const staged = await prisma.emailChange.findFirstOrThrow({ where: { userId: targetId } });
  expect(staged.newEmail).toBe("moved@ventureco.test");
  expect(staged.confirmedAt).toBeNull();
  // Only a hash of the token is stored.
  expect(staged.tokenHash).toHaveLength(64);
});

test("a 2FA reset will not go through without a reason", async ({ page }) => {
  await openDrawer(page, targetId);
  // The button is refused until a real reason is written — this is the classic
  // social-engineering target.
  await expect(page.getByTestId("totp-reset")).toBeDisabled();
  await page.getByTestId("totp-reset-reason").fill("short");
  await expect(page.getByTestId("totp-reset")).toBeDisabled();

  await page.getByTestId("totp-reset-reason").fill("Called me from her known number, confirmed her last invoice number");
  await page.getByTestId("totp-reset").click();
  await expect(page.getByTestId("member-actions-message")).toContainText("register a new authenticator");

  const user = await prisma.user.findUniqueOrThrow({ where: { id: targetId } });
  expect(user.totpEnabled).toBe(false);
  expect(user.totpSecret).toBeNull();
  // And the shell will send them to enrolment on their next click.
  expect(user.mustEnrollTotp).toBe(true);

  const ev = await prisma.membershipEvent.findFirstOrThrow({
    where: { userId: targetId, kind: "totp_reset" },
  });
  expect(ev.reason).toContain("known number");
  expect(ev.actorUserId).toBeTruthy();
});

test("the role preview is computed, not described", async ({ page }) => {
  await openDrawer(page, targetId);
  await page.getByTestId("role-preview-select").selectOption("ADMIN");
  const preview = page.getByTestId("role-preview");
  await expect(preview).toBeVisible({ timeout: 20_000 });
  // A BDR carries everything except the five document/template capabilities,
  // so those are exactly what a promotion to Admin gains.
  await expect(preview).toContainText("+ templates.edit");
  await expect(preview).toContainText("+ documents.send");
  await expect(preview).not.toContainText("− exports.run");
});

test("suspending signs them out, and reinstating gives back what they had", async ({ page }) => {
  await prisma.membership.update({
    where: { userId_workspaceId: { userId: targetId, workspaceId } },
    data: { grants: ["templates.edit"] },
  });
  await prisma.session.create({
    data: {
      userId: targetId,
      workspaceId,
      token: `e2e-admin-${Date.now()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  await openDrawer(page, targetId);
  await page.getByTestId("member-suspend").click();
  await expect(page.getByTestId("member-actions-message")).toContainText("signed out everywhere");

  const suspended = await prisma.membership.findUniqueOrThrow({
    where: { userId_workspaceId: { userId: targetId, workspaceId } },
  });
  expect(suspended.state).toBe("SUSPENDED");
  expect(
    await prisma.session.count({
      where: { userId: targetId, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
  ).toBe(0);
  // Stored, so reinstating restores exactly this rather than recomputing.
  expect(suspended.suspendedGrants).toEqual(["templates.edit"]);

  await page.reload();
  await page.getByTestId(`open-member-${targetId}`).click();
  await page.getByTestId("member-reinstate").click();
  await expect(page.getByTestId("member-actions-message")).toContainText("exactly what they had");

  const back = await prisma.membership.findUniqueOrThrow({
    where: { userId_workspaceId: { userId: targetId, workspaceId } },
  });
  expect(back.state).toBe("ACTIVE");
  // The explicit grant survived. Recomputing from the role would have dropped
  // it, and the person coming back would not know what they had lost.
  expect(back.grants).toEqual(["templates.edit"]);
});

test("removal shows an impact report, demands the typed name, and reassigns", async ({ page }) => {
  const company = await prisma.company.findFirstOrThrow({ where: { workspaceId } });
  for (let i = 0; i < 2; i += 1) {
    await prisma.lead.create({
      data: { workspaceId, companyId: company.id, contactName: `Flow lead ${i}`, ownerId: targetId },
    });
  }

  await openDrawer(page, targetId);
  await page.getByTestId("member-remove").click();
  await expect(page.getByTestId("remove-flow")).toBeVisible();

  // Step 1: what they are holding. A dialog saying "are you sure" asks a
  // question nobody can answer without this.
  await expect(page.getByTestId("impact-leads")).toContainText("2");
  await page.getByTestId("remove-next-1").click();

  // Step 2: where it goes.
  await page.getByTestId("remove-target-leads").selectOption(takerId);
  await page.getByTestId("remove-next-2").click();
  // Step 3: their mailbox.
  await page.getByTestId("remove-next-3").click();

  // Step 4: the typed name, checked on the server too.
  await page.getByTestId("remove-reason").fill("Left the company on the 30th");
  await page.getByTestId("remove-confirm-name").fill("Wrong Name");
  await page.getByTestId("remove-submit").click();
  await expect(page.getByTestId("remove-error")).toContainText("to confirm");

  await page.getByTestId("remove-confirm-name").fill("Flow Target");
  await page.getByTestId("remove-submit").click();
  await expect(page.getByTestId("remove-flow")).toHaveCount(0, { timeout: 20_000 });

  expect(await prisma.lead.count({ where: { workspaceId, ownerId: takerId } })).toBe(2);
  const m = await prisma.membership.findUniqueOrThrow({
    where: { userId_workspaceId: { userId: targetId, workspaceId } },
  });
  // The row survives: it is what keeps "created by" and the timeline readable.
  expect(m.state).toBe("REMOVED");

  const events = await prisma.membershipEvent.findMany({ where: { userId: targetId } });
  expect(events.map((e) => e.kind)).toContain("removed");
  expect(events.find((e) => e.kind === "removed")!.reason).toContain("30th");

  await prisma.lead.deleteMany({ where: { workspaceId, contactName: { startsWith: "Flow lead" } } });
});

test("the last Owner cannot remove or suspend themselves", async ({ page }) => {
  const runner = await prisma.user.findUniqueOrThrow({
    where: { email: "e2e-runner@ventureco.test" },
  });
  await openDrawer(page, runner.id);
  /**
   * A workspace with no Owner cannot grant a role, provision anything or
   * restore itself — recovering one needs shell access to the server, which is
   * not a support process, it is an outage.
   */
  await expect(page.getByTestId("member-suspend")).toBeDisabled();
  await expect(page.getByTestId("member-remove")).toBeDisabled();
});
