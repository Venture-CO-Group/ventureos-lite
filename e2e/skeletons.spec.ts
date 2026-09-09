import { test, expect, type Page } from "@playwright/test";

/**
 * Skeletons, and the layout not moving (playbook-v5 P16/2).
 *
 * ── WHAT IS ACTUALLY BEING PROVEN ───────────────────────────────────────────
 *
 * That the placeholder is the right SHAPE. A skeleton exists to stop the page
 * jumping when the content lands, so the test that matters measures the page
 * before and after the swap and asserts it did not jump. A skeleton that is
 * merely present, at the wrong height, is a layout shift with extra steps —
 * and it would pass a "does a skeleton appear" test happily.
 *
 * ── HOW THE SKELETON IS CAUGHT AT ALL ───────────────────────────────────────
 *
 * These are `<Suspense>` fallbacks around a server component's data fetch, so
 * on a fast local database they can be gone within a frame. The route is
 * delayed deliberately so the fallback is observable — throttling the network
 * would not help, because the wait is the database, not the wire.
 */
declare function contentHeight(): number;

const SURFACES = [
  { path: "/leads", name: "leads table" },
  { path: "/pipeline", name: "pipeline board" },
  { path: "/deals", name: "deals board" },
  { path: "/tasks", name: "task board" },
  { path: "/inbox", name: "inbox" },
  { path: "/prospector", name: "prospector" },
  { path: "/analytics", name: "analytics" },
  { path: "/content", name: "content hub" },
];

/** Hold the document response back so the streamed fallback is on screen. */
async function slowRoute(page: Page, path: string, ms: number) {
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      await new Promise((r) => setTimeout(r, ms));
      await route.continue();
    },
  );
}

/**
 * Record real layout shifts, from the browser's own Layout Instability API.
 *
 * This replaced a bounding-box comparison of `<main>`, which passed on all
 * eight surfaces and proved nothing: `main` is positioned by the shell, so its
 * top-left cannot move whatever the skeleton does inside it. The shift that
 * actually hurts is the content BELOW the placeholder jumping when the real
 * header, tab strip and rows turn out to be a different height — and only the
 * browser can see that.
 *
 * `hadRecentInput` entries are excluded the way CLS itself excludes them: a
 * shift the user caused by clicking is not a shift they were surprised by.
 */
async function recordShifts(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __shift: number };
    w.__shift = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[]) {
        if (!entry.hadRecentInput) w.__shift += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

async function shiftScore(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __shift: number }).__shift ?? 0);
}

/**
 * How tall the swapped region actually is.
 *
 * NOT `documentElement.scrollHeight`: `main` is a flex child that fills the
 * viewport, so a surface whose content fits on screen reports the same
 * scrollHeight whether it holds a full board or a 4px block — which is how the
 * first two versions of this test passed with a deliberately broken skeleton.
 * Summing `main`'s own element children measures the placeholder against the
 * content that replaces it, and nothing else.
 */
async function installContentHeight(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { contentHeight: () => number }).contentHeight = () => {
      const main = document.querySelector("main");
      if (!main) return 0;
      return [...main.children].reduce(
        (sum, el) => sum + el.getBoundingClientRect().height,
        0,
      );
    };
  });
}

test.describe("every listed surface has a skeleton of the right shape", () => {
  for (const surface of SURFACES) {
    test(`${surface.name} shows a placeholder and does not jump`, async ({ page }) => {
      await recordShifts(page);
      await installContentHeight(page);
      await slowRoute(page, surface.path, 900);
      await page.goto(surface.path, { waitUntil: "commit" });

      // The fallback is up, and it is a skeleton rather than a spinner.
      await expect(page.getByTestId("skeleton").first()).toBeVisible({ timeout: 20_000 });
      const loadingHeight = await page.evaluate(() => contentHeight());

      // The swap: the last skeleton leaves when the real content arrives.
      await expect(page.getByTestId("skeleton")).toHaveCount(0, { timeout: 30_000 });
      await page.waitForTimeout(300);
      const loadedHeight = await page.evaluate(() => contentHeight());

      /**
       * THE HEIGHT IS THE FALSIFIABLE PART.
       *
       * A first version of this test compared `<main>`'s bounding box and then
       * measured CLS, and BOTH passed when the skeleton was replaced with a
       * 4px block. They had to: `main` is positioned by the shell, and the
       * Layout Instability API only scores elements that MOVE — since these
       * regions are the last thing on the page, content growing into empty
       * space below them shifts nothing at all.
       *
       * What a wrong-shaped placeholder actually does is change the page's
       * HEIGHT under the swap, which is the jump a person sees as the
       * scrollbar leaping. The band is wide because the real row and card
       * counts depend on the data, but "half" and "double" catch a placeholder
       * that was never the shape of its surface.
       */
      const ratio = loadingHeight / loadedHeight;
      expect(
        ratio,
        `${surface.path}: the skeleton was ${loadingHeight}px against ${loadedHeight}px of real content — the page jumps under the swap`,
      ).toBeGreaterThan(0.5);
      expect(ratio, `${surface.path}: the skeleton is far taller than its surface`).toBeLessThan(2);

      // And no shift for anything that does sit below the boundary.
      const score = await shiftScore(page);
      expect(score, `${surface.path} shifted its layout by ${score.toFixed(4)}`).toBeLessThan(0.1);
    });
  }
});

/**
 * And the shimmer is motion, so it obeys the reduced-motion setting — the one
 * accessibility rule this item owns.
 */
test("the shimmer is gone when motion is reduced, but the block stays", async ({ browser }) => {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    storageState: "e2e/.auth/state.json",
  });
  const page = await context.newPage();
  try {
    await slowRoute(page, "/leads", 900);
    await page.goto("/leads", { waitUntil: "commit" });

    const skeleton = page.getByTestId("skeleton").first();
    await expect(skeleton).toBeVisible({ timeout: 20_000 });

    // The placeholder is still THERE — reduced motion removes the highlight,
    // not the shape, or the page would look empty rather than loading.
    const box = await skeleton.boundingBox();
    expect(box!.height).toBeGreaterThan(4);

    const shimmer = await skeleton.evaluate((el) => {
      const style = getComputedStyle(el, "::after");
      return { display: style.display, animationName: style.animationName };
    });
    expect(shimmer.display === "none" || shimmer.animationName === "none").toBe(true);
  } finally {
    await context.close();
  }
});
