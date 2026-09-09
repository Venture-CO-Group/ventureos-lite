import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * Bulk actions (playbook-v2 P3/2).
 *
 * The rules are proved against the database in test/integration/lead-bulk.test.ts.
 * These prove the surface: that a selection can be made and used, that the score
 * gate visibly refuses the leads it should, and that "select all matching" acts
 * on the filtered set rather than on the visible page.
 *
 * Serial: every test writes to the same workspace's leads.
 */
test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
/** Every company this file creates starts with this. */
const COMPANY_PREFIX = "Bulk Co ";

/**
 * Clear this file's OWN leftovers before it runs.
 *
 * The filter these tests narrow with is the fuzzy one (P3/1), and fuzziness is
 * the point of it: two random six-letter tags one edit apart match each other.
 * So after enough runs, "the two leads I just made" quietly became four, and
 * the spec failed on its own accumulated history rather than on the product.
 * The suite shares one workspace; a spec that seeds into it should tidy up.
 */
test.beforeAll(async () => {
  const companies = await prisma.company.findMany({
    where: { name: { startsWith: COMPANY_PREFIX } },
    select: { id: true },
  });
  const ids = companies.map((c) => c.id);
  if (ids.length === 0) return;
  const leads = await prisma.lead.findMany({
    where: { companyId: { in: ids } },
    select: { id: true },
  });
  const leadIds = leads.map((l) => l.id);
  if (leadIds.length) {
    await prisma.activity.deleteMany({ where: { leadId: { in: leadIds } } });
    await prisma.deal.deleteMany({ where: { leadId: { in: leadIds } } });
    await prisma.task.deleteMany({ where: { entityType: "lead", entityId: { in: leadIds } } });
    await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  }
  await prisma.company.deleteMany({ where: { id: { in: ids } } });
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

/** Letters, not a timestamp — near-identical digits fuzzy-match each other. */
function tag(): string {
  return Math.random().toString(36).slice(2, 8).replace(/\d/g, "x");
}

/**
 * Read one column's cells by its HEADER, not by position.
 *
 * nth-child indices were how two of these specs broke the moment the selection
 * checkbox added a column: the assertions still passed a number, just the wrong
 * one. The header is the stable name for a column.
 */
/**
 * Assert on a column once the table has settled.
 *
 * The whole suite shares one workspace and one dev server, so a sibling spec
 * revalidating /leads can leave the client router serving a render that
 * predates this test's own mutation. Reading the cells once and asserting on
 * them turns that into a flake; retrying the read until it agrees turns it back
 * into a test of the mutation.
 */
async function expectColumnEventually(
  page: Page,
  header: string,
  predicate: (values: string[]) => boolean,
) {
  await expect(async () => {
    expect(predicate(await columnValues(page, header))).toBe(true);
  }).toPass({ timeout: 15_000 });
}

async function columnValues(page: Page, header: string): Promise<string[]> {
  const headers = await page.locator("thead th").allInnerTexts();
  const index = headers.findIndex((h) => h.trim().toLowerCase().startsWith(header.toLowerCase()));
  if (index === -1) throw new Error(`No "${header}" column on screen`);
  return page.locator(`tbody tr td:nth-child(${index + 1})`).allInnerTexts();
}

/**
 * Wait for a row, reloading if it does not appear.
 *
 * The whole suite runs against one workspace, and a sibling spec revalidating
 * /leads at the same moment can leave the client router serving a cached table
 * that predates this lead. The row exists in the database either way, so the
 * check goes back to the server rather than trusting the cached render.
 */
async function expectRowEventually(page: Page, name: string) {
  // Generous, and it reloads only after a real wait rather than after a short
  // one: the seeded workspace accumulates leads across runs, the dev-mode page
  // render grows with it, and a 2s inner timeout meant every attempt gave up
  // before the table had painted and then reloaded into the same race.
  await expect(page.locator("tr", { hasText: name })).toBeVisible({ timeout: 15_000 }).catch(
    async () => {
      await page.reload();
      await expect(page.locator("tr", { hasText: name })).toBeVisible({ timeout: 15_000 });
    },
  );
}

async function createLead(page: Page, name: string, company: string) {
  await page.getByRole("button", { name: "Add manually" }).click();
  await page.getByPlaceholder("Contact name").fill(name);
  await page.getByPlaceholder("Company name *").fill(company);
  await page.getByRole("button", { name: "Add lead" }).click();
  await expectRowEventually(page, name);
}

/** Narrow the table to just this run's leads, via the shared company name. */
async function filterTo(page: Page, text: string) {
  await page.getByTestId("filter-toggle").click();
  await page.getByTestId("filter-add").click();
  const row = page.getByTestId("filter-condition").last();
  await row.getByTestId("filter-field").selectOption("text");
  await row.getByTestId("filter-value").fill(text);
  await page.getByTestId("filter-apply").click();
  await expect(page.getByTestId("filter-chip")).toBeVisible();
}

/** Two leads sharing a company, so one filter finds exactly them. */
async function seedPair(page: Page) {
  const suffix = tag();
  const company = `${COMPANY_PREFIX}${suffix}`;
  await page.goto("/leads");
  await createLead(page, `Bulk One ${suffix}`, company);
  await createLead(page, `Bulk Two ${suffix}`, company);
  await filterTo(page, company);
  await expect(page.locator("tbody tr")).toHaveCount(2);
  return { suffix, company };
}

test("selecting rows reveals the bar with a count", async ({ page }) => {
  await seedPair(page);
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);

  await page.getByTestId("select-row").first().check();
  await expect(page.getByTestId("bulk-bar")).toBeVisible();
  await expect(page.getByTestId("bulk-count")).toContainText("1 selected");

  await page.getByTestId("select-page").check();
  await expect(page.getByTestId("bulk-count")).toContainText("2 selected");

  await page.getByTestId("bulk-clear").click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
});

test("a bulk stage change moves the selected leads", async ({ page }) => {
  const { company } = await seedPair(page);

  // Both need a score at or above the gate first, via the audited override.
  for (const i of [0, 1]) {
    await page.locator("tbody tr").nth(i).getByRole("button", { name: "Override" }).click();
    await page.getByRole("button", { name: "4", exact: true }).click();
    await page.getByPlaceholder("Reason (required)").fill("bulk e2e");
    await page.getByRole("button", { name: "Save override" }).click();
    await expect(page.getByRole("button", { name: "Save override" })).toHaveCount(0);
  }

  await page.getByTestId("select-page").check();
  await page.getByTestId("bulk-bar").getByText("Change stage").click();
  await page.getByTestId("bulk-stage-select").selectOption("CONTACTED");
  await page.getByTestId("bulk-confirm").click();

  await expect(page.getByTestId("bulk-summary")).toContainText("2 leads updated");
  await filterTo(page, company);
  await expectColumnEventually(page, "Stage", (stages) =>
    stages.length > 0 && stages.every((s) => s.toLowerCase().includes("contacted")),
  );
});

test("the score gate refuses the leads below it and says which", async ({ page }) => {
  await seedPair(page);

  // Score only the first; the second stays unscored and must be refused.
  await page.locator("tbody tr").first().getByRole("button", { name: "Override" }).click();
  await page.getByRole("button", { name: "4", exact: true }).click();
  await page.getByPlaceholder("Reason (required)").fill("bulk gate e2e");
  await page.getByRole("button", { name: "Save override" }).click();
  await expect(page.getByRole("button", { name: "Save override" })).toHaveCount(0);

  await page.getByTestId("select-page").check();
  await page.getByTestId("bulk-bar").getByText("Change stage").click();
  await page.getByTestId("bulk-stage-select").selectOption("CONTACTED");
  await page.getByTestId("bulk-confirm").click();

  const summary = page.getByTestId("bulk-summary");
  await expect(summary).toContainText("1 lead updated");
  await expect(summary).toContainText("1 skipped");
  // Named, not silently dropped.
  await expect(summary).toContainText(/score gate/i);
});

test("bulk signals add a tag to every selected lead", async ({ page }) => {
  const { company, suffix } = await seedPair(page);

  await page.getByTestId("select-page").check();
  await page.getByTestId("bulk-bar").getByText("Signals", { exact: true }).click();
  await page.getByTestId("bulk-signals-add").fill(`tagged-${suffix}`);
  await page.getByTestId("bulk-confirm").click();
  await expect(page.getByTestId("bulk-summary")).toContainText("2 leads updated");

  await filterTo(page, company);
  const rows = page.locator("tbody tr");
  await expect(rows.first()).toContainText(`tagged-${suffix}`);
  await expect(rows.nth(1)).toContainText(`tagged-${suffix}`);
});

test("bulk owner assignment fills the owner column", async ({ page }) => {
  const { company } = await seedPair(page);

  await page.getByTestId("select-page").check();
  await page.getByTestId("bulk-bar").getByText("Assign owner").click();
  const select = page.getByTestId("bulk-owner-select");
  const value = await select.locator("option").nth(1).getAttribute("value");
  await select.selectOption(value!);
  await page.getByTestId("bulk-confirm").click();
  await expect(page.getByTestId("bulk-summary")).toContainText("2 leads updated");

  // Show the owner column and confirm it is no longer "unassigned".
  await filterTo(page, company);
  await page.getByTestId("column-toggle").click();
  await page.getByTestId("column-panel").getByText("Owner", { exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "Owner" })).toBeVisible();
  await expect(page.locator("tbody tr").first()).not.toContainText("unassigned");
});

test("parking leads as Not now takes a wake-up date", async ({ page }) => {
  const { company } = await seedPair(page);

  await page.getByTestId("select-page").check();
  await page.getByTestId("bulk-bar").getByText("Change stage").click();
  await page.getByTestId("bulk-stage-select").selectOption("NOT_NOW");
  await page.getByTestId("bulk-wakeup").fill("2027-03-01");
  await page.getByTestId("bulk-confirm").click();
  await expect(page.getByTestId("bulk-summary")).toContainText("2 leads updated");

  await filterTo(page, company);
  await expectColumnEventually(page, "Stage", (stages) =>
    stages.length > 0 && stages.every((s) => s.toLowerCase().includes("not now")),
  );
});

test("disqualifying in bulk demands a reason before it will run", async ({ page }) => {
  await seedPair(page);

  await page.getByTestId("select-page").check();
  await page.getByTestId("bulk-bar").getByText("Change stage").click();
  await page.getByTestId("bulk-stage-select").selectOption("DISQUALIFIED");
  await expect(page.getByTestId("bulk-confirm")).toBeDisabled();

  await page.getByTestId("bulk-reason").fill("bulk e2e disqualify");
  await expect(page.getByTestId("bulk-confirm")).toBeEnabled();
});

test("select-all-matching acts on the whole filtered set, not the page", async ({ page }) => {
  await page.goto("/leads");
  // No filter: the workspace has more leads than one page.
  const next = page.getByTestId("page-next");
  test.skip((await next.count()) === 0, "one page of leads — nothing to distinguish");

  await page.getByTestId("select-page").check();
  const offer = page.getByTestId("bulk-select-all-matching");
  await expect(offer).toBeVisible();

  const total = await page.getByTestId("lead-count").innerText();
  await offer.click();
  // The count now reports the filtered total rather than the page.
  await expect(page.getByTestId("bulk-count")).toContainText(total.replace(/\D+$/, "").trim());

  await page.getByTestId("bulk-clear").click();
});

test("bulk delete erases the selected leads after confirmation", async ({ page }) => {
  const { company } = await seedPair(page);

  await page.getByTestId("select-page").check();
  await page.getByTestId("bulk-delete").click();
  await expect(page.getByRole("dialog")).toContainText("cannot be undone");
  await page.getByTestId("bulk-confirm").click();
  await expect(page.getByTestId("bulk-summary")).toContainText("2 leads deleted");

  await filterTo(page, company);
  // Same contention as expectColumnEventually: the delete has happened, but the
  // client router can still be holding a render from before it.
  await expect(async () => {
    // The zero-results copy comes from the shared StateCard (playbook-v5
    // P17/3), which is lowercase Bricolage and says what to do about it.
    await expect(page.locator("tbody tr")).toContainText("no leads match this filter");
  }).toPass({ timeout: 15_000 });
});
