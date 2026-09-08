import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
let workspaceId = "";

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  await prisma.webhook.deleteMany({ where: { workspaceId } });
});

test.afterAll(async () => {
  await prisma.webhook.deleteMany({ where: { workspaceId } });
  await prisma.$disconnect();
});

async function openPanel(page: import("@playwright/test").Page) {
  await page.goto("/settings/admin");
  await page.getByTestId("settings-webhooks").scrollIntoViewIfNeeded();
}

/**
 * An outbound webhook is a feature that makes the server fetch a URL somebody
 * typed. This spec is mostly about what the panel REFUSES.
 */
test("a webhook can be created, and the secret is shown once", async ({ page }) => {
  await openPanel(page);
  await page.getByTestId("webhook-new").click();
  await page.getByTestId("webhook-url").fill("https://hooks.example.com/venture");
  await page.getByTestId("webhook-description").fill("E2E endpoint");
  await page.getByTestId("webhook-event-lead.stage_changed").check();
  await page.getByTestId("webhook-event-deal.won").check();
  await page.getByTestId("webhook-save").click();

  // Shown exactly once, on creation. A screen that re-displays it for ever is
  // a screen somebody eventually screenshots.
  const secretBox = page.getByTestId("webhook-secret");
  await expect(secretBox).toBeVisible();
  await expect(secretBox).toContainText(/[0-9a-f]{64}/);

  const rows = await prisma.webhook.findMany({ where: { workspaceId } });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.secret).toMatch(/^[0-9a-f]{64}$/);
  expect(rows[0]!.events).toEqual(["lead.stage_changed", "deal.won"]);
  expect(rows[0]!.enabled).toBe(true);

  await page.reload();
  await page.getByTestId("settings-webhooks").scrollIntoViewIfNeeded();
  // Gone after a reload — and the row still exists.
  await expect(page.getByTestId("webhook-secret")).toHaveCount(0);
  await expect(page.getByTestId("webhook-row")).toContainText("hooks.example.com");

  // Creating one is audit-logged: it is a standing instruction to send this
  // workspace's data somewhere else, which is an export with no end date.
  const logged = await prisma.auditLog.count({
    where: { workspaceId, action: "webhook.created" },
  });
  expect(logged).toBeGreaterThanOrEqual(1);
});

test("the panel refuses every address that would reach our own server", async ({ page }) => {
  await openPanel(page);
  await page.getByTestId("webhook-new").click();
  await page.getByTestId("webhook-event-lead.created").check();

  for (const [url, why] of [
    ["http://hooks.example.com/x", /https/i],
    ["https://localhost:3000/api/leads", /belső/i],
    ["https://db/x", /belső/i],
    ["https://169.254.169.254/latest/meta-data/", /IP-cím/i],
    ["https://127.0.0.1/x", /IP-cím/i],
    ["https://user:pass@example.com/x", /jelszó/i],
    ["nem is url", /URL/i],
  ] as const) {
    await page.getByTestId("webhook-url").fill(url);
    await page.getByTestId("webhook-save").click();
    await expect(page.getByTestId("webhook-error"), url).toContainText(why);
  }

  // Nothing was created by any of the seven attempts.
  expect(await prisma.webhook.count({ where: { workspaceId, url: { contains: "localhost" } } })).toBe(
    0,
  );
});

test("an endpoint subscribed to nothing is refused", async ({ page }) => {
  await openPanel(page);
  await page.getByTestId("webhook-new").click();
  await page.getByTestId("webhook-url").fill("https://hooks.example.com/empty");
  await page.getByTestId("webhook-save").click();
  // An endpoint that will never fire is one that gets reported as broken six
  // months from now.
  await expect(page.getByTestId("webhook-error")).toContainText(/legalább egy esemény/i);
});

test("a real event queues a delivery, and the panel shows what happened to it", async ({
  page,
}) => {
  const hook = await prisma.webhook.create({
    data: {
      workspaceId,
      url: "https://this-host-does-not-exist.ventureco-test.invalid/hook",
      secret: "e2e-secret",
      events: ["lead.stage_changed"],
      description: "E2E delivery watcher",
    },
  });

  /**
   * A real stage move, through the UI's own action path.
   *
   * Not a direct database write: the point of this test is that the emit is
   * wired into `moveLeadStage`, and a `prisma.lead.update` would prove nothing
   * about the code path a person actually takes.
   */
  const suffix = String(Date.now());
  const name = `E2E Webhook ${suffix}`;
  await page.goto("/leads");
  await page.getByRole("button", { name: "Add manually" }).click();
  await page.getByPlaceholder("Contact name").fill(name);
  await page.getByPlaceholder("Company name *").fill(`E2E Webhook Co ${suffix}`);
  await page.getByRole("button", { name: "Add lead" }).click();
  await expect(page.locator("tr", { hasText: name })).toBeVisible();
  await page.locator("tr", { hasText: name }).getByTestId("lead-open-detail").click();

  // Above the score gate, or Contacted is refused (hard rule #5).
  await page.getByTestId("lead-score-5").click();
  await page.getByTestId("lead-score-reason").fill("Textbook fit for the offer");
  await page.getByTestId("lead-score-save").click();
  await expect(page.getByText("Score set to 5.")).toBeVisible();

  await page.getByTestId("lead-stage-CONTACTED").click();
  await expect(page.getByText(/Moved to/i)).toBeVisible();

  const deliveries = await prisma.webhookDelivery.findMany({
    where: { webhookId: hook.id },
  });
  expect(deliveries.length).toBeGreaterThanOrEqual(1);
  const payload = deliveries[0]!.payload as Record<string, unknown>;
  expect(payload.event).toBe("lead.stage_changed");
  expect((payload.data as Record<string, unknown>).to).toBe("CONTACTED");

  await openPanel(page);
  await expect(page.getByTestId("webhook-delivery").first()).toContainText("Lead stádiumot váltott");
  await prisma.webhookDelivery.deleteMany({ where: { webhookId: hook.id } });

  // The lead this test made, and its company.
  const made = await prisma.lead.findFirst({ where: { contactName: name } });
  if (made) {
    await prisma.activity.deleteMany({ where: { leadId: made.id } });
    await prisma.lead.delete({ where: { id: made.id } });
    await prisma.company.deleteMany({ where: { name: `E2E Webhook Co ${suffix}` } });
  }
});

test("an endpoint can be switched off, and the secret rotated", async ({ page }) => {
  await prisma.webhook.deleteMany({ where: { workspaceId } });
  const hook = await prisma.webhook.create({
    data: {
      workspaceId,
      url: "https://hooks.example.com/toggle",
      secret: "old-secret",
      events: ["lead.created"],
    },
  });

  await openPanel(page);
  await page.getByTestId("webhook-toggle").click();
  await page.waitForTimeout(1200);
  expect((await prisma.webhook.findUnique({ where: { id: hook.id } }))!.enabled).toBe(false);

  await openPanel(page);
  await page.getByRole("button", { name: "Titok újragenerálása" }).click();
  await expect(page.getByTestId("webhook-secret")).toBeVisible();
  const after = await prisma.webhook.findUnique({ where: { id: hook.id } });
  // The old one is invalid immediately; that is the point of rotating.
  expect(after!.secret).not.toBe("old-secret");
  expect(after!.secret).toMatch(/^[0-9a-f]{64}$/);
});
