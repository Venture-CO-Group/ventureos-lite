import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { NOTIFICATION_TYPES } from "../src/modules/notifications/types";

/**
 * The notification bell and centre (playbook-v2 P6/1).
 *
 * The store's rules are proved in test/integration/notifications.test.ts. These
 * prove the surface: the badge counts, the panel lists, an item deep-links to
 * its entity and marks itself read on the way.
 */
test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const EMAIL = "e2e-runner@ventureco.test";
const TAG = "e2e-notify";

let userId = "";
let workspaceId = "";

async function seed(count: number, hrefs: string[] = []) {
  // Clear EVERYTHING for this user, not just this spec's rows. The runner is an
  // Owner, so sibling specs that book a meeting or accept a quote now genuinely
  // produce notifications for them — which is the wiring working, and which
  // makes any count assertion meaningless without a known starting state.
  await prisma.notification.deleteMany({ where: { userId } });
  for (let i = 0; i < count; i += 1) {
    await prisma.notification.create({
      data: {
        workspaceId,
        userId,
        type: "callback_due",
        title: `E2E notification ${i}`,
        body: `Body of notification ${i}`,
        href: hrefs[i] ?? "/calls",
        entityType: "call",
        entityId: `e2e-call-${i}`,
        dedupeKey: `${TAG}:${i}:${Date.now()}`,
      },
    });
  }
}

test.beforeAll(async () => {
  const user = await prisma.user.findUnique({ where: { email: EMAIL } });
  userId = user!.id;
  const membership = await prisma.membership.findFirst({ where: { userId } });
  workspaceId = membership!.workspaceId;
});

test.afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId } });
  await prisma.$disconnect();
});

test("the badge shows the unread count and the panel lists them", async ({ page }) => {
  await seed(3);
  await page.goto("/");

  await expect(page.getByTestId("notification-bell-badge")).toHaveText("3");

  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId("notification-bell-panel")).toBeVisible();
  await expect(page.getByTestId("notification-bell-item")).toHaveCount(3);
  await expect(page.getByTestId("notification-bell-item").first()).toContainText("E2E notification");
});

test("an empty centre says so instead of showing a blank box", async ({ page }) => {
  await prisma.notification.deleteMany({ where: { userId } });
  await page.goto("/");

  await expect(page.getByTestId("notification-bell-badge")).toHaveCount(0);
  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId("notification-bell-empty")).toBeVisible();
});

test("opening a notification deep-links to its entity and marks it read", async ({ page }) => {
  await seed(1, ["/pipeline"]);
  await page.goto("/");

  await page.getByTestId("notification-bell").click();
  await page.getByTestId("notification-bell-item").first().click();

  // Followed the stored deep link.
  await expect(page).toHaveURL(/\/pipeline$/);
  // And the badge is gone, because it was the only unread one.
  await expect(page.getByTestId("notification-bell-badge")).toHaveCount(0);

  const row = await prisma.notification.findFirst({
    where: { userId, dedupeKey: { startsWith: TAG } },
  });
  expect(row?.readAt).not.toBeNull();
});

test("mark all read clears the badge and the highlights", async ({ page }) => {
  await seed(3);
  await page.goto("/");

  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId("notification-bell-item").first()).toHaveAttribute("data-read", "false");

  await page.getByTestId("notification-bell-mark-all").click();
  await expect(page.getByTestId("notification-bell-badge")).toHaveCount(0);
  await expect(page.getByTestId("notification-bell-item").first()).toHaveAttribute("data-read", "true");

  const unread = await prisma.notification.count({ where: { userId, readAt: null } });
  expect(unread).toBe(0);
});

test("mark all read is offered only when there is something to read", async ({ page }) => {
  await seed(2);
  await page.goto("/");
  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId("notification-bell-mark-all")).toBeEnabled();

  await page.getByTestId("notification-bell-mark-all").click();
  await expect(page.getByTestId("notification-bell-mark-all")).toBeDisabled();
});

test("the bell survives a reload with the right count", async ({ page }) => {
  await seed(2);
  await page.goto("/");
  await expect(page.getByTestId("notification-bell-badge")).toHaveText("2");
  await page.reload();
  await expect(page.getByTestId("notification-bell-badge")).toHaveText("2");
});

test("the bell is reachable on a phone", async ({ page }) => {
  // CLAUDE.md: the daily loop has to work at 390px, and triage on the move is
  // exactly what a notification centre is for.
  await page.setViewportSize({ width: 390, height: 780 });
  await seed(1);
  await page.goto("/");

  const bell = page.getByTestId("notification-bell-mobile");
  await expect(bell).toBeVisible();
  const box = await bell.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(32);
  expect(box!.height).toBeGreaterThanOrEqual(32);

  await bell.click();
  await expect(page.getByTestId("notification-bell-mobile-panel")).toBeVisible();
  // The panel must not push the page sideways at 390px.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("the preference matrix lists every type this role may receive", async ({ page }) => {
  await page.goto("/settings/notifications");
  const panel = page.getByTestId("settings-notifications");
  await expect(panel).toBeVisible();

  const rows = page.getByTestId("preference-row");
  // Derived from the catalogue rather than hardcoded: the count changed the
  // moment P6/2 added the new-sign-in type, and a literal here only ever
  // catches the person who added a type, never a bug.
  // The seeded runner is an Owner, so the Owner-only types are present too.
  await expect(rows).toHaveCount(NOTIFICATION_TYPES.length);
  await expect(panel).toContainText("Signal Engine proposal");
  await expect(panel).toContainText("Callback due");
});

test("a preference toggle persists across a reload", async ({ page }) => {
  await page.goto("/settings/notifications");
  const panel = page.getByTestId("settings-notifications");

  const push = page.getByTestId("pref-callback_due-push");
  const wasOn = await push.isChecked();
  // Push toggles are disabled when the server has no VAPID keys — then the
  // in-app column is the one to exercise.
  const target = (await push.isDisabled())
    ? page.getByTestId("pref-callback_due-emailDigest")
    : push;

  const before = await target.isChecked();
  await target.setChecked(!before);
  await expect(target).toBeChecked({ checked: !before });

  // The tick is OPTIMISTIC — it flips before the server has answered — so a
  // reload here can race the write it is meant to verify. Wait for the panel to
  // report no writes in flight.
  await expect(panel).toHaveAttribute("data-saving", "false");
  await page.reload();
  await expect(target).toBeChecked({ checked: !before });

  // Put it back.
  await target.setChecked(before);
  await expect(target).toBeChecked({ checked: before });
  await expect(panel).toHaveAttribute("data-saving", "false");
  expect(typeof wasOn).toBe("boolean");
});

test("flipping one channel leaves the other three alone", async ({ page }) => {
  await page.goto("/settings/notifications");
  const inApp = page.getByTestId("pref-escalation-inApp");
  const digest = page.getByTestId("pref-escalation-emailDigest");
  // Four channels now: the immediate-email one was added for task assignment
  // (P8/2), and a partial preference row must not disturb it either.
  const now = page.getByTestId("pref-escalation-emailNow");

  const digestBefore = await digest.isChecked();
  const nowBefore = await now.isChecked();
  await inApp.setChecked(false);
  // Same optimistic-write race as above.
  await expect(page.getByTestId("settings-notifications")).toHaveAttribute("data-saving", "false");
  await page.reload();

  // The row is written from the RESOLVED state, so turning in-app off must not
  // have silently reset the other columns to their defaults.
  await expect(digest).toBeChecked({ checked: digestBefore });
  await expect(now).toBeChecked({ checked: nowBefore });
  await expect(inApp).not.toBeChecked();

  await inApp.setChecked(true);
});

/**
 * The one channel that mails per event (P8/2).
 *
 * Every other type batches into a digest. `task_assigned` does not, because a
 * task handed over on Friday afternoon that first surfaces in Monday's digest
 * is a handover that did not happen.
 */
test("only task assignment mails straight away by default", async ({ page }) => {
  await page.goto("/settings/notifications");
  await expect(page.getByTestId("pref-task_assigned-emailNow")).toBeChecked();
  for (const type of ["escalation", "callback_due", "quote_accepted", "meeting_booked"]) {
    await expect(page.getByTestId(`pref-${type}-emailNow`), type).not.toBeChecked();
  }
});

test("push says why it is unavailable rather than failing silently", async ({ page }) => {
  await page.goto("/settings/notifications");
  const panel = page.getByTestId("settings-notifications");
  const enable = page.getByTestId("push-enable");

  if (await enable.isDisabled()) {
    await expect(panel).toContainText("no VAPID keys are configured");
  } else {
    await expect(panel).toContainText(/registered|Not registered/);
  }
});
