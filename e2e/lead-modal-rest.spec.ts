import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { openLeadDetail } from "./helpers/leads";

/**
 * The rest of the lead modal's controls.
 *
 * `lead-modal-controls.spec.ts` covers the four that were reported dead. These
 * are the ones nothing exercised at all: the score override, the stage buttons
 * and the gate behind them, the deal conversion, and the signal chips. Every
 * assertion is on what the operator SEES, because the failure mode this suite
 * exists for is a control that does its nothing quietly.
 */
const prisma = new PrismaClient();
const PREFIX = "E2E Rest ";

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function openFreshLead(page: import("@playwright/test").Page, suffix: string) {
  const name = `${PREFIX}${suffix}`;
  await page.goto("/leads");
  await page.getByRole("button", { name: "Add manually" }).click();
  await page.getByPlaceholder("Contact name").fill(name);
  await page.getByPlaceholder("Company name *").fill(`E2E Rest Co ${suffix}`);
  await page.getByRole("button", { name: "Add lead" }).click();
  await expect(page.locator("tr", { hasText: name })).toBeVisible();
  await openLeadDetail(page, name);
  return name;
}

test("the score override asks for a reason, then reports the new score", async ({ page }) => {
  const suffix = String(Date.now());
  await openFreshLead(page, suffix);

  // The reason box and the save button only appear once a different score is
  // picked — there is nothing to justify otherwise.
  await expect(page.getByTestId("lead-score-save")).toHaveCount(0);
  await page.getByTestId("lead-score-4").click();
  await expect(page.getByTestId("lead-score-save")).toBeVisible();

  // Two characters is not a reason, and the button says so by staying disabled.
  await page.getByTestId("lead-score-reason").fill("ok");
  await expect(page.getByTestId("lead-score-save")).toBeDisabled();

  await page.getByTestId("lead-score-reason").fill("Warm intro from an existing client");
  await page.getByTestId("lead-score-save").click();
  await expect(page.getByText("Score set to 4.")).toBeVisible();
});

/**
 * HARD RULE 5. A lead under the threshold cannot enter Contacted, and the
 * refusal has to be visible — a stage button that silently does nothing is the
 * same bug as a missing gate, from a chair.
 */
test("the score gate refuses Contacted, and says why", async ({ page }) => {
  const suffix = String(Date.now() + 1);
  await openFreshLead(page, suffix);

  await page.getByTestId("lead-score-1").click();
  await page.getByTestId("lead-score-reason").fill("Nowhere near the profile");
  await page.getByTestId("lead-score-save").click();
  await expect(page.getByText("Score set to 1.")).toBeVisible();

  await page.getByTestId("lead-stage-CONTACTED").click();
  await expect(page.getByText(/score|threshold|gate/i).first()).toBeVisible();

  // And the lead did not move.
  const lead = await prisma.lead.findFirst({ where: { contactName: `${PREFIX}${suffix}` } });
  expect(lead?.stage).not.toBe("CONTACTED");
});

test("a stage move above the threshold goes through and is reported", async ({ page }) => {
  const suffix = String(Date.now() + 2);
  const name = await openFreshLead(page, suffix);

  await page.getByTestId("lead-score-5").click();
  await page.getByTestId("lead-score-reason").fill("Textbook fit for the offer");
  await page.getByTestId("lead-score-save").click();
  await expect(page.getByText("Score set to 5.")).toBeVisible();

  await page.getByTestId("lead-stage-CONTACTED").click();
  await expect(page.getByText(/Moved to/i)).toBeVisible();

  const lead = await prisma.lead.findFirst({ where: { contactName: name } });
  expect(lead?.stage).toBe("CONTACTED");
});

/**
 * A deal starts where the lead's journey ends, so the conversion is refused
 * below Qualified. It was refused correctly and said so — after the click. The
 * audit button beside it disables itself with the reason on it, and this one now
 * does the same: a control that answers "no" reads as a broken button.
 */
test("the conversion is offered only where it is possible", async ({ page }) => {
  const suffix = String(Date.now() + 3);
  await openFreshLead(page, suffix);

  await expect(page.getByTestId("convert-to-deal")).toBeDisabled();
  await expect(page.getByText(/Move it to Qualified/i)).toBeVisible();
});

test("converting to a deal creates one, and the modal then shows it", async ({ page }) => {
  const suffix = String(Date.now() + 4);
  const name = await openFreshLead(page, suffix);

  // A deal needs a qualified lead, and Qualified needs a score above the gate.
  await page.getByTestId("lead-score-5").click();
  await page.getByTestId("lead-score-reason").fill("Ready to talk about money");
  await page.getByTestId("lead-score-save").click();
  await expect(page.getByText("Score set to 5.")).toBeVisible();
  // Three of the four qualification answers, from the modal itself.
  await page.getByTestId("lead-qual-authority").check();
  await page.getByTestId("lead-qual-budget").check();
  await page.getByTestId("lead-qual-timeline").check();
  await expect(page.getByText("3 of 4 answered")).toBeVisible();

  await page.getByTestId("lead-stage-QUALIFIED").click();
  await expect(page.getByText(/Moved to/i)).toBeVisible();

  await expect(page.getByTestId("convert-to-deal")).toBeEnabled();
  await page.getByTestId("convert-to-deal").click();
  await expect(page.getByText("Deal created.")).toBeVisible();
  await expect(page.getByTestId("lead-deals")).toBeVisible();
  // The button is gone, because the offer no longer applies.
  await expect(page.getByTestId("convert-to-deal")).toHaveCount(0);

  const lead = await prisma.lead.findFirst({
    where: { contactName: name },
    include: { deals: true },
  });
  expect(lead?.deals.length).toBe(1);
});

/**
 * The qualification checklist lived only inside an Inbox thread, so a lead with
 * no conversation — one from the Prospector, one qualified on the telephone —
 * could never satisfy the gate that stood in front of Qualified.
 */
test("a lead with no inbox thread can still be qualified", async ({ page }) => {
  const suffix = String(Date.now() + 6);
  const name = await openFreshLead(page, suffix);

  await expect(page.getByText("0 of 4 answered")).toBeVisible();
  await page.getByTestId("lead-qual-authority").check();
  await page.getByTestId("lead-qual-history").check();
  await expect(page.getByText("2 of 4 answered")).toBeVisible();

  // Written straight through, not held for Save changes. Polled, because the
  // tick is optimistic: the screen is deliberately ahead of the database here.
  await expect
    .poll(async () => {
      const lead = await prisma.lead.findFirst({ where: { contactName: name } });
      return lead?.qualification;
    })
    .toMatchObject({ authority: true, history: true, budget: false });
});

/**
 * The chips edit the FORM, not the database — Save changes is still a
 * deliberate press. That is the modal's rule everywhere, and the thing worth
 * pinning is that the round trip survives it.
 */
test("a signal added and one removed both survive the save", async ({ page }) => {
  const suffix = String(Date.now() + 5);
  const name = await openFreshLead(page, suffix);

  await page.getByTestId("lead-signal-input").fill("hiring");
  await page.getByTestId("lead-signal-input").press("Enter");
  await page.getByTestId("lead-signal-input").fill("rebrand");
  await page.getByTestId("lead-signal-input").press("Enter");
  await page.getByTestId("lead-save").click();
  await expect(page.getByText("Saved.")).toBeVisible();

  let lead = await prisma.lead.findFirst({ where: { contactName: name } });
  expect(lead?.signals).toEqual(["hiring", "rebrand"]);

  await page.getByRole("button", { name: "Remove hiring" }).click();
  await page.getByTestId("lead-save").click();
  await expect(page.getByText("Saved.")).toBeVisible();

  lead = await prisma.lead.findFirst({ where: { contactName: name } });
  expect(lead?.signals).toEqual(["rebrand"]);
});
