import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

test.afterAll(async () => {
  // Back to the default so the rest of the suite sees a comfortable shell.
  await prisma.user.updateMany({
    where: { email: "e2e-runner@ventureco.test" },
    data: { density: null },
  });
  await prisma.$disconnect();
});

/**
 * Row density (playbook-v5 P16/6).
 *
 * ── WHAT IS WORTH PROVING ──────────────────────────────────────────────────
 *
 * Not that a class changed — that the ROWS ARE ACTUALLY SHORTER, and that the
 * preference followed the person rather than the browser. The second is the
 * reason it is a column on `users` and not a localStorage key: somebody who
 * prefers compact prefers it on their laptop and on the machine in the meeting
 * room, and a per-device setting means the product looks different depending
 * on where you opened it.
 */
test("compact makes the rows shorter, and the choice follows the user", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByTestId("density-toggle")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("density-comfortable")).toHaveAttribute("aria-pressed", "true");

  await page.goto("/leads");
  await expect(page.getByTestId("skeleton")).toHaveCount(0, { timeout: 30_000 });
  const row = page.locator("tbody tr").first();
  await expect(row).toBeVisible();
  const comfortable = (await row.boundingBox())!.height;

  await page.goto("/settings");
  await page.getByTestId("density-compact").click();
  await expect(page.getByTestId("density-compact")).toHaveAttribute("aria-pressed", "true", {
    timeout: 15_000,
  });

  // It reached the user row, which is what makes it follow them.
  await expect
    .poll(
      async () =>
        (await prisma.user.findFirst({ where: { email: "e2e-runner@ventureco.test" } }))!.density,
      { timeout: 15_000 },
    )
    .toBe("compact");

  await page.goto("/leads");
  await expect(page.getByTestId("skeleton")).toHaveCount(0, { timeout: 30_000 });
  const compact = (await page.locator("tbody tr").first().boundingBox())!.height;

  expect(
    compact,
    `compact rows (${compact}px) should be shorter than comfortable (${comfortable}px)`,
  ).toBeLessThan(comfortable);
});

/**
 * THE RULE THAT OVERRIDES THE PREFERENCE.
 *
 * 44px touch targets are a hard rule, and compact row heights cannot honour
 * them — so below the shell's own breakpoint the tokens go back to comfortable
 * whatever the setting says. The UI stays silent about it: explaining that a
 * setting is being ignored is worse than quietly giving somebody targets they
 * can hit.
 */
test("compact is ignored on a phone, where the targets have to stay tappable", async ({
  page,
}) => {
  await prisma.user.updateMany({
    where: { email: "e2e-runner@ventureco.test" },
    data: { density: "compact" },
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/leads");
  await expect(page.getByTestId("skeleton")).toHaveCount(0, { timeout: 30_000 });

  // The attribute is still there — the preference is honest about what it is.
  await expect(page.locator("[data-density]")).toHaveAttribute("data-density", "compact");

  // But the token is back to the comfortable value.
  const rowPy = await page.evaluate(() =>
    getComputedStyle(document.querySelector("[data-density]")!).getPropertyValue("--row-py").trim(),
  );
  expect(rowPy).toBe("10px");
});
