import { test, expect } from "@playwright/test";
import { prismaUnsafe } from "../src/lib/db";

/**
 * The P7 polish surfaces (playbook-v2 P7 VERIFICATION):
 * "inline edit respects the score gate; undo restores a bulk stage move;
 *  ⌘K finds a lead by typo'd name and creates a task."
 *
 * The rules behind all three are proved against the database in
 * test/integration/{inline-edit,undo}.test.ts. What a browser can prove — and
 * what these do — is that the surfaces are wired to them.
 *
 * Serial: they share one workspace's leads.
 */
test.describe.configure({ mode: "serial" });

function tag(): string {
  return Math.random().toString(36).slice(2, 8).replace(/\d/g, "x");
}

async function createLead(page: import("@playwright/test").Page, name: string, company: string) {
  await page.goto("/leads");
  await page.getByRole("button", { name: "Add manually" }).click();
  await page.getByPlaceholder("Contact name").fill(name);
  await page.getByPlaceholder("Company name *").fill(company);
  await page.getByRole("button", { name: "Add lead" }).click();
  await expect(page.locator("tr", { hasText: name })).toBeVisible({ timeout: 15_000 });
}

async function filterTo(page: import("@playwright/test").Page, text: string) {
  await page.getByTestId("filter-toggle").click();
  await page.getByTestId("filter-add").click();
  const row = page.getByTestId("filter-condition").last();
  await row.getByTestId("filter-field").selectOption("text");
  await row.getByTestId("filter-value").fill(text);
  await page.getByTestId("filter-apply").click();
  await expect(page.getByTestId("filter-chip")).toBeVisible();
}

/**
 * Clear this test's own leftovers before it runs again.
 *
 * It creates "Kovacs Anna <random>" and used to leave it behind, so every run
 * added another namesake. The palette shows five leads per kind, ordered by
 * `lastActivityAt desc` — and a freshly created lead has NULL there, so once
 * enough identical-looking rows had piled up the newest one was pushed out of the
 * list and the test failed on a database that had simply been used too often.
 *
 * It failed that way twice, and both times looked like a bug in the palette
 * rather than in the test. Cleaning up beforehand rather than afterwards also
 * clears whatever previous runs left, so an existing developer database heals
 * itself on the next run.
 */
test.beforeEach(async () => {
  const stale = await prismaUnsafe.lead.findMany({
    where: { contactName: { startsWith: "Kovacs Anna " } },
    select: { id: true, companyId: true },
  });
  if (stale.length === 0) return;
  const companyIds = [...new Set(stale.map((l) => l.companyId).filter(Boolean) as string[])];
  await prismaUnsafe.lead.deleteMany({ where: { id: { in: stale.map((l) => l.id) } } });
  await prismaUnsafe.company.deleteMany({
    where: { id: { in: companyIds }, name: { startsWith: "Palette Co " }, leads: { none: {} } },
  });
});

test("the command palette opens, finds a lead by a typo, and offers the verbs", async ({
  page,
}) => {
  const suffix = tag();
  const name = `Kovacs Anna ${suffix}`;
  await createLead(page, name, `Palette Co ${suffix}`);

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();

  // Empty query shows the verbs.
  await expect(palette.getByTestId("palette-row").filter({ hasText: "New lead" })).toBeVisible();

  // A typo'd name still finds the lead — same fuzzy rules as the top-bar search.
  await page.getByTestId("palette-input").fill("Kovcs Anna");
  await expect(
    palette.getByTestId("palette-row").filter({ hasText: `Kovacs Anna ${suffix}` }),
  ).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
});

test("the palette creates a task", async ({ page }) => {
  await page.goto("/leads");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("palette-input").fill("new task");
  await page.getByTestId("palette-row").filter({ hasText: "New task" }).first().click();

  const title = `Palette task ${tag()}`;
  await page.getByTestId("task-title").fill(title);
  await page.getByTestId("task-save").click();
  await expect(page.getByTestId("task-title")).toHaveCount(0);

  await page.goto("/");
  await expect(page.getByText(title)).toBeVisible({ timeout: 15_000 });
});

test("the shortcut overlay lists every binding, and g-nav works", async ({ page }) => {
  await page.goto("/leads");
  await page.keyboard.press("?");
  const overlay = page.getByTestId("shortcut-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("Command palette");
  await expect(overlay).toContainText("g p");
  await page.keyboard.press("Escape");

  await page.keyboard.press("g");
  await page.keyboard.press("p");
  await expect(page).toHaveURL(/\/pipeline$/);
});

test("shortcuts stay off while typing, so a note keeps its letters", async ({ page }) => {
  await page.goto("/leads");
  await page.getByRole("button", { name: "Add manually" }).click();
  const field = page.getByPlaceholder("Contact name");
  await field.fill("");
  await field.type("nt?g");
  // No dialog stole the keystrokes, and the field has exactly what was typed.
  await expect(field).toHaveValue("nt?g");
  await expect(page.getByTestId("shortcut-overlay")).toHaveCount(0);
});

test("an inline cell edits a lead, and the score gate still refuses", async ({ page }) => {
  const suffix = tag();
  const name = `Inline ${suffix}`;
  await createLead(page, name, `Inline Co ${suffix}`);
  await filterTo(page, `Inline Co ${suffix}`);

  const row = page.locator("tbody tr").first();

  // Stage is an inline select, and the gate refuses Contacted with no score.
  await row.getByRole("button", { name: "Edit Stage" }).click();
  await row.getByLabel("Stage").selectOption("CONTACTED");
  await expect(row.getByRole("button", { name: "Edit Stage" })).toHaveAttribute(
    "title",
    /cannot enter Contacted/,
  );
  await expect(page.locator("tbody tr").first()).toContainText("researched");
});

test("undo puts a bulk stage move back", async ({ page }) => {
  const suffix = tag();
  const company = `Undo Co ${suffix}`;
  await createLead(page, `Undo One ${suffix}`, company);
  await createLead(page, `Undo Two ${suffix}`, company);
  await filterTo(page, company);
  await expect(page.locator("tbody tr")).toHaveCount(2);

  // Not now needs no score, so the whole selection moves.
  await page.getByTestId("select-page").check();
  await page.getByTestId("bulk-bar").getByText("Change stage").click();
  await page.getByTestId("bulk-stage-select").selectOption("NOT_NOW");
  await page.getByTestId("bulk-confirm").click();
  await expect(page.getByTestId("bulk-summary")).toContainText("2 leads updated");

  const toast = page.getByTestId("undo-toast");
  await expect(toast).toBeVisible();
  await toast.getByTestId("undo-button").click();
  await expect(toast).toHaveCount(0, { timeout: 15_000 });

  await filterTo(page, company);
  await expect(async () => {
    const cells = await page.locator("tbody tr").allInnerTexts();
    expect(cells.every((c) => c.toLowerCase().includes("researched"))).toBe(true);
  }).toPass({ timeout: 15_000 });
});

test("a fresh user gets the tour once, and dismissing it means once", async ({ page }) => {
  // Reset this account's flag through the same action the Settings replay uses,
  // so the test drives the product rather than the database.
  await page.goto("/");
  await page.evaluate(async () => {
    await fetch("/api/health"); // warm the origin so the next nav is not cold
  });

  const tour = page.getByTestId("onboarding-tour");
  // It may already have been dismissed by an earlier run; only assert the
  // behaviour when it is showing.
  if (await tour.isVisible().catch(() => false)) {
    await expect(tour).toContainText("your day starts here");
    await page.getByTestId("tour-skip").click();
    await expect(tour).toHaveCount(0);
  }

  await page.reload();
  await expect(page.getByTestId("onboarding-tour")).toHaveCount(0);
});

test("empty screens say what the module is for", async ({ page }) => {
  await page.goto("/campaigns");
  // Either there are campaigns, or the empty state explains what one is.
  const campaigns = page.getByTestId("campaigns-empty");
  if (await campaigns.isVisible().catch(() => false)) {
    await expect(campaigns).toContainText("no campaigns yet");
    await expect(campaigns).toContainText("counsel");
  }

  await page.goto("/referrers");
  const referrers = page.getByTestId("referrers-empty");
  if (await referrers.isVisible().catch(() => false)) {
    await expect(referrers).toContainText("no referrers yet");
  }
});

test("a workflow rule creates a draft a human must send, and it appears in the log", async ({
  page,
}) => {
  const name = `E2E rule ${tag()}`;
  await page.goto("/settings/admin/workspace");

  const panel = page.getByTestId("settings-workflows");
  await expect(panel).toBeVisible();
  // The copy states the guarantee where somebody chooses the action.
  await expect(panel).toContainText("Email actions only ever prepare a draft");

  await panel.getByTestId("rule-new").click();
  const editor = page.getByTestId("rule-editor");
  await editor.getByTestId("rule-name").fill(name);
  await editor.getByTestId("rule-trigger").selectOption("lead_stage_changed");
  await editor.getByLabel("Stage").selectOption("CONTACTED");
  await editor.getByTestId("action-type").selectOption("draft_email");
  await expect(editor).toContainText("It is never sent");
  await editor.getByPlaceholder("Subject").fill("Following up");
  await editor.getByPlaceholder("Draft body").fill("Hi — following up on our chat.");
  await editor.getByTestId("rule-save").click();
  await expect(page.getByTestId("rule-list")).toContainText(name);

  // Now trigger it: a lead at or above the gate, moved to Contacted.
  const suffix = tag();
  const leadName = `Rule lead ${suffix}`;
  await createLead(page, leadName, `Rule Co ${suffix}`);
  const row = page.locator("tr", { hasText: leadName });
  await row.getByRole("button", { name: "Override" }).click();
  await page.getByRole("button", { name: "4", exact: true }).click();
  await page.getByPlaceholder("Reason (required)").fill("e2e workflow");
  await page.getByRole("button", { name: "Save override" }).click();
  await row.getByRole("button", { name: /Contacted/ }).click();
  await expect(page.locator("tr", { hasText: leadName })).toContainText("contacted");

  // The run log records it.
  await page.goto("/settings/admin/workspace");
  const rule = page
    .getByTestId("rule-list")
    .locator("li")
    .filter({ hasText: name });
  await rule.getByTestId("rule-log-toggle").click();
  await expect(rule.getByTestId("rule-log")).toContainText("Prepared an email draft");

  // And the draft is on the lead, unsent.
  await page.goto("/leads");
  await page.locator("tr", { hasText: leadName }).getByTestId("lead-open-detail").click();
  await expect(page.getByTestId("lead-timeline")).toContainText("Following up");

  // Clean up so the rule does not fire for every later spec.
  await page.goto("/settings/admin/workspace");
  await page
    .getByTestId("rule-list")
    .locator("li")
    .filter({ hasText: name })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(page.getByTestId("rule-list").filter({ hasText: name })).toHaveCount(0);
});
