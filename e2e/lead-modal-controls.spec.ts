import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * The four controls that were reported dead (items 1-4).
 *
 * Every one of them failed differently and three of them failed SILENTLY, which
 * is why this spec asserts on messages rather than on state alone: a save that
 * changes nothing and says nothing is indistinguishable from a broken button,
 * and that ambiguity was the actual bug.
 */
const prisma = new PrismaClient();
const PREFIX = "E2E Modal ";

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function openFreshLead(page: import("@playwright/test").Page, suffix: string) {
  const name = `${PREFIX}${suffix}`;
  await page.goto("/leads");
  await page.getByRole("button", { name: "Add manually" }).click();
  await page.getByPlaceholder("Contact name").fill(name);
  await page.getByPlaceholder("Company name *").fill(`E2E Modal Co ${suffix}`);
  await page.getByRole("button", { name: "Add lead" }).click();
  await expect(page.locator("tr", { hasText: name })).toBeVisible();
  await page.locator("tr", { hasText: name }).getByTestId("lead-open-detail").click();
  return name;
}

test("the save reports what happened, whatever happens", async ({ page }) => {
  const suffix = String(Date.now());
  await openFreshLead(page, suffix);

  // The job title and the location commit in place now (playbook-v5 P16/1),
  // so they are not part of what Save reports on.
  await page.getByTestId("lead-title").getByTestId("inline-cell").click();
  await page.getByTestId("lead-title").getByRole("textbox").fill("Ügyvezető");
  await page.getByTestId("lead-title").getByRole("textbox").press("Enter");
  await expect(page.getByTestId("lead-title")).toContainText("Ügyvezető");

  // The email and the company block still go through Save, because the NAV and
  // web-search lookups fill them for review. A refusal is also an answer, and
  // it names the field.
  await page.getByTestId("lead-email").fill("not-an-email");
  await page.getByTestId("lead-save").click();
  await expect(page.getByText(/email address does not look right/i)).toBeVisible();
});

/**
 * ITEM 1's second bug: the company fields were shown for a lead with no company
 * row, and filling them in said "Saved." and threw them away.
 */
test("a company typed onto a lead that has none is created, not discarded", async ({ page }) => {
  const suffix = String(Date.now() + 1);
  const name = `${PREFIX}nocompany ${suffix}`;
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  const lead = await prisma.lead.create({
    data: {
      workspaceId: ws!.id,
      contactName: name,
      source: "MANUAL",
      stage: "RESEARCHED",
      language: "HU",
    },
  });

  await page.goto("/leads");
  await page.locator("tr", { hasText: name }).getByTestId("lead-open-detail").click();
  await page.getByTestId("lead-company").fill(`E2E Modal Co ${suffix}`);
  await page.getByTestId("lead-city").fill("Debrecen");
  await page.getByTestId("lead-save").click();
  await expect(page.getByText("Saved.")).toBeVisible();

  const after = await prisma.lead.findUnique({
    where: { id: lead.id },
    include: { company: true },
  });
  expect(after?.company?.name, "the typed company was discarded again").toBe(
    `E2E Modal Co ${suffix}`,
  );
  expect(after?.company?.city).toBe("Debrecen");

  await prisma.activity.deleteMany({ where: { leadId: lead.id } });
  await prisma.lead.delete({ where: { id: lead.id } });
  await prisma.company.deleteMany({ where: { id: after!.companyId! } });
});

/** ITEMS 2 and 4: neither control existed in the modal at all. */
test("research and site audit are reachable for a lead that already exists", async ({ page }) => {
  const suffix = String(Date.now() + 2);
  await openFreshLead(page, suffix);

  // Research: present, and it ANSWERS — this lead has no text to analyse, and
  // saying so is the correct outcome, not silence.
  const research = page.getByTestId("lead-run-research");
  await expect(research).toBeVisible();
  await research.click();
  await expect(page.getByTestId("lead-modal-message")).toBeVisible({ timeout: 30_000 });

  // Audit: disabled without a domain, and it says why.
  const audit = page.getByTestId("lead-run-audit");
  await expect(audit).toBeDisabled();
  await expect(page.getByText(/audit needs a domain/i)).toBeVisible();

  // With one, it goes to the audit page with the URL prefilled and running.
  await page.getByTestId("lead-company-domain").fill("example.com");
  await page.getByTestId("lead-save").click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.getByTestId("lead-run-audit").click();
  await expect(page).toHaveURL(/\/audit\?url=example\.com&run=1/);
});

/** ITEM 3: the adószám lookup had no button anywhere. */
test("the adószám lookup is offered, and answers rather than hanging", async ({ page }) => {
  const suffix = String(Date.now() + 3);
  await openFreshLead(page, suffix);

  const lookup = page.getByTestId("lead-taxid-lookup");
  // Nothing to look up yet.
  await expect(lookup).toBeDisabled();

  // A malformed number is refused locally, before any request is made.
  await page.getByTestId("lead-company-taxid").fill("12345678-1-99");
  await expect(lookup).toBeEnabled();
  await lookup.click();
  // Either the checksum rejection or "NAV is not configured" — both are answers,
  // and which one depends on whether this environment has credentials.
  await expect(page.getByTestId("lead-modal-message")).toBeVisible({ timeout: 20_000 });
  const text = await page.getByTestId("lead-modal-message").innerText();
  expect(text.length, "the lookup said nothing at all").toBeGreaterThan(0);
});
