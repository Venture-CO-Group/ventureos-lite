import { test, expect } from "@playwright/test";
import { openLeadDetail } from "./helpers/leads";

/**
 * The deals layer end to end (playbook-v2 P4 VERIFICATION):
 * "old lead flow works top-of-funnel; a deal moves through a custom pipeline".
 *
 * Serial: every test drives the same workspace's boards, and running them in
 * parallel had one test's stage move reflowing another's column mid-click.
 */
test.describe.configure({ mode: "serial" });

async function captureQualifiedLead(page: import("@playwright/test").Page, suffix: number) {
  const name = `E2E Deal ${suffix}`;
  const company = `E2E Deal Co ${suffix}`;

  await page.goto("/leads");
  await page.getByRole("button", { name: "Add manually" }).click();
  await page.getByPlaceholder("Contact name").fill(name);
  await page.getByPlaceholder("Company name *").fill(company);
  await page.getByRole("button", { name: "Add lead" }).click();
  await expect(page.locator("tr", { hasText: name })).toBeVisible();

  return { name, company };
}

test("the lead board still owns the top of funnel, and says where the money lives", async ({
  page,
}) => {
  await page.goto("/pipeline");
  // The boundary is stated on the board itself, not only in a doc.
  await expect(page.getByText("is the lead journey")).toBeVisible();
  await expect(page.getByRole("link", { name: "Deals", exact: true }).first()).toBeVisible();
  // Both zones are labelled.
  await expect(page.getByText("lead journey", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("deal territory", { exact: true }).first()).toBeVisible();
});

test("a qualified lead converts to a deal and appears on the board", async ({ page }) => {
  const suffix = Date.now();
  const { name, company } = await captureQualifiedLead(page, suffix);

  // Open the lead and walk it into deal territory. Meeting booked rather than
  // Qualified: Qualified has its own gate (3 of 4 qualification answers, spec
  // §4.7), and this test is about the deals boundary, not that gate.
  await openLeadDetail(page, name);

  const convert = page.getByTestId("convert-to-deal");
  await expect(page.getByTestId("lead-stage-MEETING_BOOKED")).toBeVisible();
  await page.getByTestId("lead-stage-MEETING_BOOKED").click();
  await expect(page.getByText("Moved to Meeting booked.")).toBeVisible();
  await expect(convert).toBeVisible();
  await convert.click();

  // The modal now lists the deal instead of offering to create one.
  await expect(page.getByTestId("lead-deals")).toContainText(company);

  // And it is on the deals board, in the default pipeline's first open stage.
  await page.goto("/deals");
  await expect(page.getByTestId("deal-card").filter({ hasText: company })).toBeVisible();
});

test("a deal moves through its pipeline and closing it requires a reason", async ({ page }) => {
  const suffix = Date.now();
  const { name, company } = await captureQualifiedLead(page, suffix);

  await openLeadDetail(page, name);
  await expect(page.getByTestId("lead-stage-MEETING_BOOKED")).toBeVisible();
  await page.getByTestId("lead-stage-MEETING_BOOKED").click();
  await expect(page.getByText("Moved to Meeting booked.")).toBeVisible();
  await page.getByTestId("convert-to-deal").click();
  await expect(page.getByTestId("lead-deals")).toBeVisible();

  await page.goto("/deals");
  const card = page.getByTestId("deal-card").filter({ hasText: company });
  await expect(card).toBeVisible();

  // Move it along with the touch fallback, which is deterministic in a browser
  // test in a way that HTML5 drag-and-drop is not.
  await card.getByRole("button", { name: "Move to…" }).click();
  await page.getByRole("button", { name: /^Negotiation/ }).click();
  await expect(
    page
      .getByTestId("deal-column")
      .filter({ hasText: "Negotiation" })
      .getByTestId("deal-card")
      .filter({ hasText: company }),
  ).toBeVisible();

  // Marking it lost demands a reason before anything is written.
  const moved = page.getByTestId("deal-card").filter({ hasText: company });
  await moved.getByRole("button", { name: "Move to…" }).click();
  await page.getByRole("button", { name: /^Lost/ }).click();
  const confirm = page.getByRole("button", { name: "Mark lost" });
  await expect(confirm).toBeDisabled();
  await page.getByPlaceholder(/Reason/).fill("went in-house");
  await confirm.click();

  await expect(
    page
      .getByTestId("deal-column")
      .filter({ hasText: "Lost" })
      .getByTestId("deal-card")
      .filter({ hasText: company }),
  ).toBeVisible();
});

test("the pipeline tabs switch boards, and the forecast reads the open ones", async ({ page }) => {
  await page.goto("/deals");
  await expect(page.getByTestId("pipeline-tab").filter({ hasText: "Web projects" })).toBeVisible();
  await page.getByTestId("pipeline-tab").filter({ hasText: "Grants" }).click();
  // The Grants board models a different journey, which is the whole point of
  // pipelines being data.
  await expect(page.getByTestId("deal-column").filter({ hasText: "Submitted" })).toBeVisible();

  await page.goto("/analytics?tab=forecast");
  await expect(page.getByTestId("forecast-weighted")).toBeVisible();
  await expect(page.getByTestId("forecast-commit")).toBeVisible();
  await expect(page.getByTestId("forecast-table")).toBeVisible();
});
