import { expect, type Page } from "@playwright/test";

/**
 * Open a lead's detail modal from the table.
 *
 * ── WHY THIS RETRIES ────────────────────────────────────────────────────────
 *
 * The name in the table is a button that opens a modal, so it does nothing at
 * all until React has hydrated. Nothing on the page announces that moment: the
 * rows are server-rendered and look finished, the skeleton is already gone, and
 * a click landing in the window between paint and hydration is simply
 * discarded. Every spec that did `goto("/leads")` then `click()` was quietly
 * racing that window, and the ones that clicked soonest lost most often.
 *
 * So the open is an ASSERTION rather than a click: click, wait for the modal,
 * click again if it did not come. What is being waited for is not "is the
 * button there" but "did the click take".
 *
 * ── AND WHY IT MAY NOT NEED TO CLICK AT ALL ─────────────────────────────────
 *
 * The open lead now lives in the URL (`/leads?lead=<id>`), so a reload reopens
 * it — which is the point of putting it there. A spec that reloads mid-test
 * therefore already has the modal in front of it, and clicking the row behind
 * the overlay hangs for ever on an intercepted pointer event.
 *
 * ── AND WHY "IS IT OPEN" IS NOT THE SAME QUESTION AS "IS IT LOADED" ─────────
 *
 * The modal appears immediately and fetches the lead afterwards, so for a
 * moment it is an overlay with no title in it. Asking only about the title
 * therefore answers "nothing is open" while an overlay is covering the row —
 * which is exactly how this helper first got it wrong, and it looped for
 * thirty seconds clicking at a button it could not reach. So the two states
 * are checked separately: the dialog says whether anything is open, the title
 * says which lead it is.
 */
export async function openLeadDetail(page: Page, name: string): Promise<void> {
  const dialog = page.locator('[role="dialog"]');
  const title = page.locator("#lead-modal-title");

  await expect(async () => {
    if (await dialog.first().isVisible().catch(() => false)) {
      // Something is open. Give it a moment to finish loading and say which
      // lead it is.
      await expect(title).toBeVisible({ timeout: 8_000 });
      const heading = (await title.textContent()) ?? "";
      if (heading.includes(name)) return;
      // A different lead. Close it and let the next attempt click.
      await page.keyboard.press("Escape");
      await expect(dialog.first()).toBeHidden({ timeout: 2_000 });
      throw new Error(`another lead was open (“${heading}”); closed it`);
    }

    await page
      .locator("tr", { hasText: name })
      .getByTestId("lead-open-detail")
      .click({ timeout: 5_000 });
    await expect(title).toBeVisible({ timeout: 8_000 });
    // Generous, because the first visit to /leads in a `next dev` run compiles
    // the route: the wait is for the bundle, not for anything the product does
    // slowly.
  }).toPass({ timeout: 40_000 });
}
