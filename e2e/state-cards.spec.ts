import { test, expect } from "@playwright/test";

/**
 * The three states a list can be in (playbook-v5 P17/3).
 *
 * ── THE BUG THIS PINS ───────────────────────────────────────────────────────
 *
 * Mistaking "the filter matched nothing" for "there is nothing here" is the
 * common one, and it produces a screen that tells somebody with four hundred
 * leads to capture their first. The two must say different things and offer
 * different actions.
 */
test("a filter that matches nothing offers to clear itself, not to start over", async ({
  page,
}) => {
  await page.goto("/leads");
  await expect(page.getByTestId("skeleton")).toHaveCount(0, { timeout: 30_000 });

  // Narrow to something nothing can match. The free-text field takes its
  // default operator — selecting one explicitly picks from a per-field list.
  await page.getByTestId("filter-toggle").click();
  await page.getByTestId("filter-add").click();
  const row = page.getByTestId("filter-condition").last();
  await row.getByTestId("filter-field").selectOption("text");
  await row.getByTestId("filter-value").fill("zzzz-nobody-is-called-this-zzzz");
  await page.getByTestId("filter-apply").click();
  await expect(page.getByTestId("filter-chip")).toBeVisible();

  const zero = page.getByTestId("leads-zero-results");
  await expect(zero).toBeVisible({ timeout: 20_000 });
  await expect(zero).toHaveAttribute("data-mode", "zero-results");

  // It says the leads are there, and does NOT tell them to capture their first.
  await expect(zero).toContainText(/none of them match/i);
  await expect(zero).not.toContainText(/no leads yet/i);

  // And the one useful action undoes the filter.
  await zero.getByTestId("state-action").click();
  await expect(page.getByTestId("leads-zero-results")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator("tbody tr").first()).toBeVisible();
});

/**
 * And the getting-started checklist. It has to DISAPPEAR when finished — a
 * checklist that stays after it is complete is a to-do list that lies.
 *
 * The dismissal is reset first rather than skipping when it is already gone: a
 * test that skips on a workspace where somebody has used the product proves
 * nothing, and this one has a real assertion to make.
 */
test("the getting-started checklist shows progress and can be dismissed", async ({ page }) => {
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();
  try {
    await db.user.updateMany({
      where: { email: "e2e-runner@ventureco.test" },
      data: { checklistHiddenAt: null },
    });

    await page.goto("/");
    await expect(page.getByTestId("skeleton")).toHaveCount(0, { timeout: 30_000 });

    const checklist = page.getByTestId("getting-started");
    await expect(checklist).toBeVisible({ timeout: 20_000 });
    // Progress, in words, so it is obvious how much is left.
    await expect(checklist).toContainText(/\d of \d/);

    await page.getByTestId("checklist-hide").click();
    await expect(page.getByTestId("getting-started")).toHaveCount(0, { timeout: 20_000 });

    // Dismissal is remembered, not just hidden for this render.
    await expect
      .poll(
        async () =>
          (await db.user.findFirst({ where: { email: "e2e-runner@ventureco.test" } }))!
            .checklistHiddenAt,
        { timeout: 15_000 },
      )
      .not.toBeNull();
  } finally {
    await db.$disconnect();
  }
});
