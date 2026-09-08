import { test, expect } from "@playwright/test";

/**
 * Every page, twice: at desktop width and at 390px.
 *
 * Written during the full audit, and kept, because the existing specs each
 * exercise ONE screen deeply and nothing asserted the cheap thing — that every
 * route in the app still renders at all. Three failures a screenshot would not
 * tell apart are covered here: a server error, Next's error boundary, and a
 * console exception. The 390px pass is the CLAUDE.md definition of done, which
 * only two pages were checked against before (`desktop-layout` covers wide
 * viewports, not narrow ones).
 *
 * Deliberately shallow: it proves nothing works BETTER than "it loads". That is
 * exactly the gap it fills.
 */
const PAGES = [
  "/", "/analytics", "/audit", "/calls", "/campaigns", "/content", "/deals",
  "/documents", "/inbox", "/leads", "/meetings", "/outreach", "/pipeline",
  "/prospector", "/public-pages", "/referrers", "/settings",
  "/settings/security", "/settings/notifications", "/settings/email",
  "/settings/extension", "/settings/admin", "/settings/admin/members",
  "/settings/admin/workspace", "/settings/admin/sales", "/settings/admin/audit",
  "/settings/admin/integrations", "/settings/admin/security",
  "/templates",
];

for (const path of PAGES) {
  test(`mobile ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path, { waitUntil: "networkidle" });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, `${path} overflows by ${overflow}px at 390`).toBeLessThanOrEqual(0);
  });

  test(`page ${path}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    const res = await page.goto(path, { waitUntil: "networkidle" });
    expect(res?.status(), `${path} returned ${res?.status()}`).toBeLessThan(400);
    // Next's error boundary and the digest-only production crash.
    await expect(page.locator("text=Application error")).toHaveCount(0);
    await expect(page.locator("text=/A server-side exception/")).toHaveCount(0);
    const real = errors.filter(
      (e) =>
        // Service-worker and favicon noise in dev is not a page defect.
        !/favicon|sw\.js|manifest|Failed to load resource.*40[34]/i.test(e),
    );
    expect(real, `${path} logged: ${real.join(" | ")}`).toEqual([]);
  });
}
