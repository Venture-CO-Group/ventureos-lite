import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * The Revenue tab (playbook-v3 P11/1b).
 *
 * The maths is unit-tested; what these prove is that the tab renders the real
 * book — including the clause the P11 VERIFICATION names: a churned
 * subscription showing as negative MRR in the month it churned.
 */
test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const TAG = "E2E Revenue";

let workspaceId = "";
let companyId = "";

async function reset() {
  await prisma.subscriptionEvent.deleteMany({ where: { workspaceId } });
  await prisma.subscription.deleteMany({ where: { workspaceId } });
  await prisma.company.deleteMany({ where: { workspaceId, name: { startsWith: TAG } } });
  companyId = (
    await prisma.company.create({
      data: { workspaceId, name: `${TAG} Danubia`, clientStatus: "CLIENT" },
    })
  ).id;
}

/** A subscription plus its event log, written directly for a known shape. */
async function seedSubscription(opts: {
  monthlyNet: number;
  startedAt: string;
  churnedAt?: string;
  churnReason?: string;
  status?: "ACTIVE" | "PAUSED" | "CHURNED";
  plan?: string;
}) {
  const sub = await prisma.subscription.create({
    data: {
      workspaceId,
      companyId,
      planName: opts.plan ?? "Hosting",
      monthlyNet: opts.monthlyNet,
      startDate: new Date(opts.startedAt),
      status: opts.status ?? (opts.churnedAt ? "CHURNED" : "ACTIVE"),
      churnedAt: opts.churnedAt ? new Date(opts.churnedAt) : null,
      churnReason: opts.churnReason ?? null,
      source: "hosting",
    },
  });
  await prisma.subscriptionEvent.create({
    data: {
      workspaceId,
      subscriptionId: sub.id,
      kind: "new",
      deltaNet: opts.monthlyNet,
      monthlyNetAfter: opts.monthlyNet,
      at: new Date(opts.startedAt),
    },
  });
  if (opts.churnedAt) {
    await prisma.subscriptionEvent.create({
      data: {
        workspaceId,
        subscriptionId: sub.id,
        kind: "churn",
        deltaNet: -opts.monthlyNet,
        monthlyNetAfter: 0,
        reason: opts.churnReason ?? null,
        at: new Date(opts.churnedAt),
      },
    });
  }
  return sub;
}

/** A month key inside the 12-month chart window, relative to today. */
function monthsAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(15);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

test.beforeAll(async () => {
  const user = await prisma.user.findUnique({ where: { email: "e2e-runner@ventureco.test" } });
  const membership = await prisma.membership.findFirst({ where: { userId: user!.id } });
  workspaceId = membership!.workspaceId;
});

test.afterAll(async () => {
  await prisma.subscriptionEvent.deleteMany({ where: { workspaceId } });
  await prisma.subscription.deleteMany({ where: { workspaceId } });
  await prisma.company.deleteMany({ where: { workspaceId, name: { startsWith: TAG } } });
  await prisma.$disconnect();
});

test("Analytics offers a Revenue tab and it is reachable", async ({ page }) => {
  await reset();
  await page.goto("/analytics");
  await expect(page.getByTestId("analytics-tab-performance")).toHaveAttribute(
    "aria-current",
    "true",
  );

  await page.getByTestId("analytics-tab-revenue").click();
  await expect(page).toHaveURL(/tab=revenue/);
  await expect(page.getByTestId("analytics-tab-revenue")).toHaveAttribute("aria-current", "true");
});

test("an empty book says so rather than drawing a chart of nothing", async ({ page }) => {
  await reset();
  await page.goto("/analytics?tab=revenue");
  await expect(page.getByTestId("revenue-mrr")).toHaveText("0 Ft");
  await expect(page.getByTestId("revenue-empty")).toBeVisible();
});

test("the headline numbers come from the live book", async ({ page }) => {
  await reset();
  await seedSubscription({ monthlyNet: 100_000, startedAt: monthsAgo(6) });
  await seedSubscription({ monthlyNet: 50_000, startedAt: monthsAgo(4) });

  await page.goto("/analytics?tab=revenue");
  await expect(page.getByTestId("revenue-mrr")).toHaveText("150 000 Ft");
  await expect(page.getByTestId("revenue-arr")).toHaveText("1 800 000 Ft");
  // Two subscriptions, one company: one client.
  await expect(page.getByTestId("revenue-clients")).toHaveText("1");
  await expect(page.getByTestId("revenue-arpc")).toHaveText("150 000 Ft");
});

test("a paused subscription is off the MRR but still on the book", async ({ page }) => {
  await reset();
  await seedSubscription({ monthlyNet: 100_000, startedAt: monthsAgo(6) });
  await seedSubscription({ monthlyNet: 60_000, startedAt: monthsAgo(5), status: "PAUSED" });

  await page.goto("/analytics?tab=revenue");
  await expect(page.getByTestId("revenue-mrr")).toHaveText("100 000 Ft");
  await page.getByTestId("sub-filter-PAUSED").click();
  await expect(page.getByTestId("subscription-row")).toHaveCount(1);
});

test("a churned subscription shows as negative MRR in the month it churned", async ({ page }) => {
  // The P11 VERIFICATION clause, on the real page.
  await reset();
  await seedSubscription({
    monthlyNet: 200_000,
    startedAt: monthsAgo(6),
    churnedAt: monthsAgo(2),
    churnReason: "price",
  });

  await page.goto("/analytics?tab=revenue");
  // It left the book entirely.
  await expect(page.getByTestId("revenue-mrr")).toHaveText("0 Ft");

  // The churn column carries the negative bar, titled with the amount, and it
  // sits in the month of the churn — not the month it started.
  const chart = page.getByTestId("movement-chart");
  const churnBar = chart.locator('[title*="churn"]');
  await expect(churnBar).toHaveCount(1);
  // Normalise before comparing: hu-HU formatting uses a non-breaking space as
  // the thousands separator, so a regex over the raw title matches nothing.
  const title = (await churnBar.getAttribute("title")) ?? "";
  expect(title.replace(/[^\d-]/g, "")).toBe("-200000");

  const columns = chart.locator("> div");
  const churnMonth = monthsAgo(2).slice(0, 7);
  const startMonth = monthsAgo(6).slice(0, 7);
  const label = (m: string) =>
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][
      Number(m.split("-")[1]) - 1
    ];
  // The churn bar belongs to the churn month's column.
  const churnColumn = columns.filter({ hasText: label(churnMonth) });
  await expect(churnColumn.locator('[title*="churn"]')).toHaveCount(1);
  const startColumn = columns.filter({ hasText: label(startMonth) });
  await expect(startColumn.locator('[title*="churn"]')).toHaveCount(0);
  await expect(startColumn.locator('[title*="new"]')).toHaveCount(1);
});

test("the churn breakdown counts reasons", async ({ page }) => {
  await reset();
  await seedSubscription({
    monthlyNet: 100_000,
    startedAt: monthsAgo(8),
    churnedAt: monthsAgo(3),
    churnReason: "price",
  });
  await seedSubscription({
    monthlyNet: 30_000,
    startedAt: monthsAgo(7),
    churnedAt: monthsAgo(2),
    churnReason: "price",
  });
  await seedSubscription({
    monthlyNet: 250_000,
    startedAt: monthsAgo(9),
    churnedAt: monthsAgo(1),
    churnReason: "went_quiet",
  });

  await page.goto("/analytics?tab=revenue");
  const breakdown = page.getByTestId("churn-breakdown");
  await expect(breakdown).toBeVisible();
  // Worst first: went_quiet took more MRR than the two price churns together.
  await expect(breakdown.locator("> div").first()).toContainText("went quiet");
  await expect(breakdown).toContainText("×2");
});

test("the status filter narrows the subscriptions table", async ({ page }) => {
  await reset();
  await seedSubscription({ monthlyNet: 100_000, startedAt: monthsAgo(6), plan: "Live one" });
  await seedSubscription({
    monthlyNet: 40_000,
    startedAt: monthsAgo(6),
    churnedAt: monthsAgo(1),
    churnReason: "budget_cut",
    plan: "Gone one",
  });

  await page.goto("/analytics?tab=revenue");
  // Defaults to active.
  await expect(page.getByTestId("subscription-row")).toHaveCount(1);
  await expect(page.getByTestId("subscriptions-table")).toContainText("Live one");

  await page.getByTestId("sub-filter-ALL").click();
  await expect(page.getByTestId("subscription-row")).toHaveCount(2);
  await expect(page.getByTestId("subscriptions-table")).toContainText("Gone one");

  await page.getByTestId("sub-filter-CHURNED").click();
  await expect(page.getByTestId("subscription-row")).toHaveCount(1);
  await expect(page.getByTestId("subscriptions-table")).toContainText("budget cut");
});

test("red clients surface in the attention list with a reason", async ({ page }) => {
  await reset();
  // Healthy: recent start, no unpaid invoice, touched today.
  await seedSubscription({ monthlyNet: 100_000, startedAt: monthsAgo(20), plan: "Healthy" });
  const lead = await prisma.lead.create({
    data: { workspaceId, companyId, contactName: `${TAG} contact`, lastActivityAt: new Date() },
  });

  await page.goto("/analytics?tab=revenue");
  await expect(page.getByTestId("health-empty")).toBeVisible();

  // Now make it red: an invoice issued 60 days ago and still unpaid.
  const issued = new Date();
  issued.setUTCDate(issued.getUTCDate() - 60);
  await prisma.invoice.create({
    data: { workspaceId, companyId, netAmount: 400_000, status: "ISSUED", at: issued },
  });

  await page.reload();
  const row = page.getByTestId("health-row").first();
  await expect(row).toHaveAttribute("data-level", "red");
  await expect(row).toContainText("60 days past due");

  await prisma.lead.delete({ where: { id: lead.id } });
  await prisma.invoice.deleteMany({ where: { workspaceId, companyId } });
});

test("a red client can be turned into a task, once per day", async ({ page }) => {
  await reset();
  await seedSubscription({ monthlyNet: 100_000, startedAt: monthsAgo(20) });
  const issued = new Date();
  issued.setUTCDate(issued.getUTCDate() - 60);
  await prisma.invoice.create({
    data: { workspaceId, companyId, netAmount: 400_000, status: "ISSUED", at: issued },
  });
  await prisma.task.deleteMany({ where: { workspaceId, source: "client_health" } });

  await page.goto("/analytics?tab=revenue");
  await page.getByTestId("health-task").first().click();
  await expect(page.getByText(/Task queued/i)).toBeVisible();

  let tasks = await prisma.task.count({ where: { workspaceId, source: "client_health" } });
  expect(tasks).toBe(1);

  // Asking again the same day does not queue a second call.
  await page.getByTestId("health-task").first().click();
  await expect(page.getByText(/Already queued/i)).toBeVisible();
  tasks = await prisma.task.count({ where: { workspaceId, source: "client_health" } });
  expect(tasks).toBe(1);

  await prisma.task.deleteMany({ where: { workspaceId, source: "client_health" } });
  await prisma.invoice.deleteMany({ where: { workspaceId, companyId } });
});

test("the manual support flag makes an otherwise healthy client amber", async ({ page }) => {
  await reset();
  await seedSubscription({ monthlyNet: 100_000, startedAt: monthsAgo(20) });
  await prisma.lead.create({
    data: { workspaceId, companyId, contactName: `${TAG} contact`, lastActivityAt: new Date() },
  });

  await page.goto("/analytics?tab=revenue");
  await expect(page.getByTestId("health-empty")).toBeVisible();

  await page.getByTestId("health-show-all").click();
  await page.getByTestId("health-flag").first().click();
  await expect(page.getByTestId("health-row").first()).toHaveAttribute("data-level", "amber");
  await expect(page.getByTestId("health-row").first()).toContainText("Support flag is open");

  await prisma.company.update({ where: { id: companyId }, data: { supportFlag: false } });
  await prisma.lead.deleteMany({ where: { workspaceId, companyId } });
});

test("the health thresholds are editable in Settings and change the scoring", async ({ page }) => {
  await reset();
  await seedSubscription({ monthlyNet: 100_000, startedAt: monthsAgo(20) });
  const touched = new Date();
  touched.setUTCMonth(touched.getUTCMonth() - 2);
  await prisma.lead.create({
    data: { workspaceId, companyId, contactName: `${TAG} contact`, lastActivityAt: touched },
  });

  // Default amber threshold is 2 months of silence.
  await page.goto("/analytics?tab=revenue");
  await expect(page.getByTestId("health-row").first()).toHaveAttribute("data-level", "amber");

  // Loosen it to 6 months: the same client is now green.
  await page.goto("/settings/admin/sales");
  const amber = page.getByTestId("health-rule-quietAmberMonths");
  await amber.fill("6");
  await amber.blur();
  await expect(page.getByText("Saved.")).toBeVisible();

  await page.goto("/analytics?tab=revenue");
  await expect(page.getByTestId("health-empty")).toBeVisible();

  await page.getByTestId("health-rules-reset").isVisible().catch(() => {});
  await page.goto("/settings/admin/sales");
  await page.getByTestId("health-rules-reset").click();
  await expect(page.getByTestId("health-rule-quietAmberMonths")).toHaveValue("2");
  await prisma.lead.deleteMany({ where: { workspaceId, companyId } });
});

test("the Commission tab computes a month and shows the lines", async ({ page }) => {
  await reset();
  const sub = await seedSubscription({ monthlyNet: 200_000, startedAt: monthsAgo(3) });
  const lead = await prisma.lead.findFirst({ where: { workspaceId, companyId } })
    ?? (await prisma.lead.create({
      data: { workspaceId, companyId, contactName: `${TAG} contact` },
    }));
  const user = await prisma.user.findUnique({ where: { email: "e2e-runner@ventureco.test" } });
  await prisma.lead.update({ where: { id: lead.id }, data: { ownerId: user!.id } });

  // Two payments in the same month, so the line must aggregate them.
  const month = new Date();
  month.setUTCDate(10);
  const monthKey = month.toISOString().slice(0, 7);
  await prisma.invoice.create({
    data: {
      workspaceId, companyId, subscriptionId: sub.id,
      netAmount: 200_000, status: "PAID", paidAt: month,
    },
  });
  const later = new Date(month);
  later.setUTCDate(20);
  await prisma.invoice.create({
    data: {
      workspaceId, companyId, subscriptionId: sub.id,
      netAmount: 100_000, status: "PAID", paidAt: later,
    },
  });

  await page.goto("/analytics?tab=commission");
  await page.getByTestId("commission-month").fill(monthKey);
  await page.getByTestId("commission-run").click();

  await expect(page.getByTestId("commission-report")).toBeVisible();
  // One line for the client, aggregating both payments: 300 000 net -> 30 000.
  await expect(page.getByTestId("commission-line")).toHaveCount(1);
  await expect(page.getByTestId("commission-total")).toHaveText("30 000 Ft");

  await prisma.invoice.deleteMany({ where: { workspaceId, companyId } });
  await prisma.lead.deleteMany({ where: { workspaceId, companyId } });
});

test("the termination calculator shows revenue and commission side by side", async ({ page }) => {
  await reset();
  const sub = await seedSubscription({ monthlyNet: 100_000, startedAt: monthsAgo(2) });
  const lead = await prisma.lead.create({
    data: { workspaceId, companyId, contactName: `${TAG} contact` },
  });
  const user = await prisma.user.findUnique({ where: { email: "e2e-runner@ventureco.test" } });
  await prisma.lead.update({ where: { id: lead.id }, data: { ownerId: user!.id } });

  // Window opens with a payment two months ago.
  const opened = new Date();
  opened.setUTCMonth(opened.getUTCMonth() - 2);
  opened.setUTCDate(10);
  await prisma.invoice.create({
    data: {
      workspaceId, companyId, subscriptionId: sub.id,
      netAmount: 100_000, status: "PAID", paidAt: opened,
    },
  });

  await page.goto("/analytics?tab=commission");
  await page.getByTestId("settlement-date").fill(new Date().toISOString().slice(0, 10));
  await page.getByTestId("settlement-run").click();

  await expect(page.getByTestId("settlement-report")).toBeVisible();
  // Two months elapsed -> 9 remaining x 100 000 = 900 000 revenue, 90 000 commission.
  await expect(page.getByTestId("settlement-net")).toHaveText("900 000 Ft");
  await expect(page.getByTestId("settlement-commission")).toHaveText("90 000 Ft");

  await prisma.invoice.deleteMany({ where: { workspaceId, companyId } });
  await prisma.lead.deleteMany({ where: { workspaceId, companyId } });
});

test("exporting the commission PDF is audit-logged", async ({ page }) => {
  await reset();
  const before = await prisma.auditLog.count({
    where: { workspaceId, action: "export.run" },
  });

  await page.goto("/analytics?tab=commission");
  await page.getByTestId("commission-run").click();
  await expect(page.getByTestId("commission-report")).toBeVisible();
  await page.getByTestId("commission-export").click();
  await expect(page.getByText(/recorded in the audit log/i)).toBeVisible();

  const after = await prisma.auditLog.findMany({
    where: { workspaceId, action: "export.run" },
    orderBy: { at: "desc" },
    take: 1,
  });
  expect(await prisma.auditLog.count({ where: { workspaceId, action: "export.run" } })).toBe(
    before + 1,
  );
  expect((after[0].meta as Record<string, unknown>).kind).toBe("commission.pdf");
});

test("a subscription can be added, and it promotes the company to client", async ({ page }) => {
  await reset();
  await prisma.company.update({ where: { id: companyId }, data: { clientStatus: "PROSPECT" } });

  await page.goto("/analytics?tab=revenue");
  await page.getByTestId("add-subscription").click();
  // The picker is capped and searchable (the seeded workspace has hundreds of
  // companies), so narrow to this one before selecting it.
  const target = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  await page.getByTestId("sub-company-search").fill(target.name);
  await expect(page.getByTestId("sub-company").locator(`option[value="${companyId}"]`)).toHaveCount(
    1,
    { timeout: 10_000 },
  );
  await page.getByTestId("sub-company").selectOption(companyId);
  await page.getByTestId("sub-plan").fill("Hosting + retainer");
  await page.getByTestId("sub-amount").fill("120000");
  await page.getByTestId("sub-source").selectOption("hosting");
  await page.getByTestId("sub-save").click();

  await expect(page.getByTestId("revenue-mrr")).toHaveText("120 000 Ft");
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  expect(company?.clientStatus).toBe("CLIENT");
  expect(company?.clientSince).not.toBeNull();
});

test("ending a subscription demands a reason before it will run", async ({ page }) => {
  await reset();
  await seedSubscription({ monthlyNet: 90_000, startedAt: monthsAgo(4) });

  await page.goto("/analytics?tab=revenue");
  await page.getByTestId("sub-churn").click();
  // The prompt is the point of sub-item (e): no reason, no churn.
  await expect(page.getByTestId("churn-confirm")).toBeDisabled();

  await page.getByTestId("churn-reason-price").click();
  await expect(page.getByTestId("churn-confirm")).toBeEnabled();
  await page.getByTestId("churn-confirm").click();

  // Off the book, and the reason lands in the breakdown.
  await expect(page.getByTestId("revenue-mrr")).toHaveText("0 Ft");
  await expect(page.getByTestId("churn-breakdown")).toContainText("price");

  const sub = await prisma.subscription.findFirst({ where: { workspaceId, companyId } });
  expect(sub?.status).toBe("CHURNED");
  expect(sub?.churnReason).toBe("price");
  // The company is a FORMER client, not a prospect again.
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  expect(company?.clientStatus).toBe("FORMER");
});

test("pausing takes MRR off the book and resuming puts it back", async ({ page }) => {
  await reset();
  await seedSubscription({ monthlyNet: 80_000, startedAt: monthsAgo(4) });

  await page.goto("/analytics?tab=revenue");
  await expect(page.getByTestId("revenue-mrr")).toHaveText("80 000 Ft");

  await page.getByTestId("sub-pause").click();
  await expect(page.getByTestId("revenue-mrr")).toHaveText("0 Ft");

  await page.getByTestId("sub-filter-PAUSED").click();
  await page.getByTestId("sub-pause").click();
  await expect(page.getByTestId("revenue-mrr")).toHaveText("80 000 Ft");

  // The event log kept both moves, so the deltas still reconcile.
  const sub = await prisma.subscription.findFirst({ where: { workspaceId, companyId } });
  const events = await prisma.subscriptionEvent.findMany({
    where: { subscriptionId: sub!.id },
  });
  expect(events.reduce((n, e) => n + e.deltaNet, 0)).toBe(80_000);
  expect(events.map((e) => e.kind)).toEqual(["new", "pause", "resume"]);
});
