import { chromium } from "playwright";

export interface PdfOptions {
  /**
   * Let the document's own `@page` rule decide the sheet size and orientation.
   *
   * Without this Playwright's `format` wins and a template that asks for
   * landscape prints portrait anyway — the lead list was doing exactly that,
   * asking for `A4 landscape` in its CSS and getting a portrait page with its
   * right-hand columns walked off the edge.
   */
  preferCssPageSize?: boolean;
  /** Printed at the foot of every page. Chrome's template syntax. */
  footerTemplate?: string;
  /** Needed for a footer to have anywhere to print. */
  margin?: { top: string; bottom: string; left: string; right: string };
}

/**
 * The one headless-Chrome print pipeline (CLAUDE.md): HTML template -> PDF.
 * Reused for audits now, and quotes/contracts/certificates later. Worker-only
 * (never imported by the web process).
 */
export async function renderHtmlToPdf(html: string, opts: PdfOptions = {}): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    /**
     * Load the markup, then let it settle — but never fail on the settling.
     *
     * Every template here inlines its assets, so `networkidle` normally
     * resolves at once. When it does not — one remote font slipped into a
     * template, an outbound rule on the server — waiting for idle as a
     * REQUIREMENT throws after the default thirty seconds and the job dies
     * with no PDF, for a document that had rendered perfectly. This is the
     * same trap that was killing site audits at the navigation step; it is
     * closed the same way, and once, for every PDF in the product.
     */
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    return await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: opts.preferCssPageSize ?? false,
      margin: opts.margin ?? { top: "0", bottom: "0", left: "0", right: "0" },
      ...(opts.footerTemplate
        ? {
            displayHeaderFooter: true,
            // An empty header still has to be declared, or Chrome prints its
            // own default one (the document title and the URL) above ours.
            headerTemplate: "<span></span>",
            footerTemplate: opts.footerTemplate,
          }
        : {}),
    });
  } finally {
    await browser.close();
  }
}
