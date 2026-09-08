import { describe, it, expect } from "vitest";
import { analyzeAudit } from "../../src/modules/audit/analyze";
import {
  AUDIT_CATEGORIES,
  CHECK_META,
  scoreByCategory,
} from "../../src/modules/audit/categories";
import {
  DEFAULT_AUDIT_THRESHOLDS,
  auditThresholdsFromConfig,
} from "../../src/modules/audit/config";
import type { PageProbe } from "../../src/modules/audit/types";

/**
 * The audit had TWO scoring systems and the headline number used the poor one.
 *
 * `categories.ts` mapped all thirty-three checks into eight weighted
 * categories and exported `overallFromCategories` — which nothing called.
 * `analyze.ts` scored by summing a flat thirteen-entry table instead, so
 * twenty checks were worth nothing: an expiring certificate, no CSP, no SPF,
 * no impresszum, no privacy notice and twenty-one serious accessibility
 * violations all counted zero.
 */
const healthy: PageProbe = {
  url: "https://good.example",
  finalUrl: "https://good.example",
  isHttps: true,
  statusOk: true,
  hasViewport: true,
  title: "Good Co",
  metaDescription: "We do good things",
  h1Count: 1,
  imgTotal: 4,
  imgWithAlt: 4,
  hasSitemap: true,
  hasRobots: true,
  copyrightYear: 2026,
  hasPhone: true,
  hasEmail: true,
  hasForm: true,
  hasBooking: true,
  hasCookieBanner: true,
  pageWeightBytes: 500_000,
  psi: { performance: 95, seo: 95, accessibility: 95, bestPractices: 95 },
  screenshots: {},
  httpsRedirect: true,
  sslDaysLeft: 300,
  hsts: true,
  xContentTypeOptions: true,
  xFrameOptions: true,
  csp: true,
  mixedContent: false,
  spf: true,
  dmarc: true,
  hasImpresszum: true,
  hasPrivacyPolicy: true,
  hasOpenGraph: true,
  hasCanonical: true,
  hasSchemaOrg: true,
  headingHierarchyOk: true,
  sitemapUrlCount: 40,
  hasAnalytics: true,
  a11y: { critical: 0, serious: 0, moderate: 0, minor: 0, top: [] },
};

const NOW = new Date("2026-09-08T00:00:00Z");

describe("the checks that used to count for nothing now move the score", () => {
  /** One probe, one thing wrong. */
  const withOnly = (patch: Partial<PageProbe>): number =>
    analyzeAudit({ ...healthy, ...patch }, DEFAULT_AUDIT_THRESHOLDS, NOW).score;

  const baseline = analyzeAudit(healthy, DEFAULT_AUDIT_THRESHOLDS, NOW).score;

  it("scores a site with nothing wrong at zero", () => {
    expect(baseline).toBe(0);
  });

  it.each([
    ["an expiring certificate", { sslDaysLeft: 5 }],
    ["no HSTS", { hsts: false }],
    ["no Content-Security-Policy", { csp: false }],
    ["no clickjacking protection", { xFrameOptions: false }],
    ["mixed content", { mixedContent: true }],
    ["no SPF record", { spf: false }],
    ["no DMARC record", { dmarc: false }],
    ["no impresszum", { hasImpresszum: false }],
    ["no privacy notice", { hasPrivacyPolicy: false }],
    ["no Open Graph tags", { hasOpenGraph: false }],
    ["no canonical URL", { hasCanonical: false }],
    ["no structured data", { hasSchemaOrg: false }],
    ["a broken heading structure", { headingHierarchyOk: false }],
    ["no analytics", { hasAnalytics: false }],
    [
      "serious accessibility violations",
      { a11y: { critical: 0, serious: 6, moderate: 0, minor: 0, top: [] } },
    ],
    [
      "critical accessibility violations",
      { a11y: { critical: 4, serious: 0, moderate: 0, minor: 0, top: [] } },
    ],
  ])("counts %s", (_label, patch) => {
    // Every one of these was worth exactly zero points before.
    expect(withOnly(patch as Partial<PageProbe>)).toBeGreaterThan(baseline);
  });

  it("scores a site that fails everything at 100", () => {
    const awful = analyzeAudit(
      {
        ...healthy,
        isHttps: false,
        hasViewport: false,
        title: null,
        metaDescription: null,
        h1Count: 0,
        imgWithAlt: 0,
        hasSitemap: false,
        hasRobots: false,
        copyrightYear: 2019,
        hasPhone: false,
        hasEmail: false,
        hasForm: false,
        hasBooking: false,
        hasCookieBanner: false,
        pageWeightBytes: 6_000_000,
        psi: { performance: 18, seo: 30, accessibility: 25, bestPractices: 30 },
        httpsRedirect: false,
        sslDaysLeft: 5,
        hsts: false,
        xContentTypeOptions: false,
        xFrameOptions: false,
        csp: false,
        mixedContent: true,
        spf: false,
        dmarc: false,
        hasImpresszum: false,
        hasPrivacyPolicy: false,
        hasOpenGraph: false,
        hasCanonical: false,
        hasSchemaOrg: false,
        headingHierarchyOk: false,
        sitemapUrlCount: 0,
        hasAnalytics: false,
        a11y: { critical: 9, serious: 12, moderate: 0, minor: 0, top: [] },
      },
      DEFAULT_AUDIT_THRESHOLDS,
      NOW,
    );
    expect(awful.score).toBe(100);
    expect(awful.verdict).toBe("STRONG");
  });
});

describe("every check the analysis emits is scored", () => {
  it("maps all of them, so none is silently worth nothing", () => {
    // The defect in one assertion: a check with no registry entry contributes
    // zero, and nothing on screen says so.
    const a = analyzeAudit(healthy, DEFAULT_AUDIT_THRESHOLDS, NOW);
    const unmapped = a.checks.filter((c) => !CHECK_META[c.key]).map((c) => c.key);
    expect(unmapped).toEqual([]);
    expect(a.checks.length).toBeGreaterThan(30);
  });

  it("emits the JS-dependency finding from the analysis, not from the worker", () => {
    // It used to be appended in `processAudit`, which meant it was unscored
    // AND had to be re-folded in by every stage that rebuilt the analysis.
    const spa = analyzeAudit(
      {
        ...healthy,
        rawHtml: '<html><body><div id="root"></div><script src="/main.js"></script></body></html>',
        renderedTextLength: 4000,
      },
      DEFAULT_AUDIT_THRESHOLDS,
      NOW,
    );
    const jsCheck = spa.checks.find((c) => c.key === "jsDependency");
    expect(jsCheck).toBeDefined();
    expect(jsCheck!.pass).toBe(false);
    expect(spa.score).toBeGreaterThan(0);
  });

  it("emits no JS-dependency finding when the server HTML could not be read", () => {
    // Inventing one would be the alarmist finding framework.ts avoids.
    const a = analyzeAudit(healthy, DEFAULT_AUDIT_THRESHOLDS, NOW);
    expect(a.checks.some((c) => c.key === "jsDependency")).toBe(false);
  });
});

describe("a category nobody measured is left out rather than counted as perfect", () => {
  it("ignores an unmeasured category instead of scoring it zero", () => {
    // DNS timed out, so SPF and DMARC were not measured at all.
    const noDns = { ...healthy };
    delete noDns.spf;
    delete noDns.dmarc;
    const a = analyzeAudit(noDns, DEFAULT_AUDIT_THRESHOLDS, NOW);
    expect(scoreByCategory(a.checks).find((c) => c.category === "email")!.subscore).toBeNull();

    // And a site that fails email hygiene must still score worse than one
    // where it could not be checked.
    const failingEmail = analyzeAudit(
      { ...healthy, spf: false, dmarc: false },
      DEFAULT_AUDIT_THRESHOLDS,
      NOW,
    );
    expect(failingEmail.score).toBeGreaterThan(a.score);
  });

  it("keeps a crawled and an uncrawled audit comparable", () => {
    // The structure category only exists on a crawled run, and the analysis
    // never sees those checks — so it cannot shift the score in either
    // direction. Previously this was arithmetic (weights of 0); now it is
    // structural.
    const a = analyzeAudit(healthy, DEFAULT_AUDIT_THRESHOLDS, NOW);
    expect(scoreByCategory(a.checks).find((c) => c.category === "structure")!.subscore).toBeNull();
  });
});

describe("the Owner's knob", () => {
  it("re-weights the score", () => {
    const legalOnly = auditThresholdsFromConfig({
      categoryWeights: Object.fromEntries(
        AUDIT_CATEGORIES.map((c) => [c, c === "legal" ? 100 : 0]),
      ),
    });
    // A site whose ONLY fault is legal scores maximally on a legal-only list,
    // and zero on a list that does not care.
    const noLegal = { ...healthy, hasImpresszum: false, hasPrivacyPolicy: false, hasCookieBanner: false };
    expect(analyzeAudit(noLegal, legalOnly, NOW).score).toBe(100);

    const speedOnly = auditThresholdsFromConfig({
      categoryWeights: Object.fromEntries(
        AUDIT_CATEGORIES.map((c) => [c, c === "performance" ? 100 : 0]),
      ),
    });
    expect(analyzeAudit(noLegal, speedOnly, NOW).score).toBe(0);
  });

  it("accepts a weight of zero but refuses a negative or a non-number", () => {
    const t = auditThresholdsFromConfig({
      categoryWeights: { legal: 0, security: -5, seo: "lots", email: 42 },
    });
    expect(t.categoryWeights.legal).toBe(0);
    expect(t.categoryWeights.security).toBe(DEFAULT_AUDIT_THRESHOLDS.categoryWeights.security);
    expect(t.categoryWeights.seo).toBe(DEFAULT_AUDIT_THRESHOLDS.categoryWeights.seo);
    expect(t.categoryWeights.email).toBe(42);
  });

  it("falls back to the defaults for a config that is not an object", () => {
    expect(auditThresholdsFromConfig(null)).toEqual(DEFAULT_AUDIT_THRESHOLDS);
    expect(auditThresholdsFromConfig("nonsense")).toEqual(DEFAULT_AUDIT_THRESHOLDS);
    // `auditConfig` is a shared bag — the SERP keyword cap and the service map
    // live there too, and neither may disturb the scoring.
    expect(auditThresholdsFromConfig({ keywordCap: 10 })).toEqual(DEFAULT_AUDIT_THRESHOLDS);
  });

  it("keeps the heavy-page threshold configurable and sane", () => {
    expect(auditThresholdsFromConfig({ heavyPageBytes: 1_000_000 }).heavyPageBytes).toBe(1_000_000);
    expect(auditThresholdsFromConfig({ heavyPageBytes: 0 }).heavyPageBytes).toBe(
      DEFAULT_AUDIT_THRESHOLDS.heavyPageBytes,
    );
    expect(auditThresholdsFromConfig({ heavyPageBytes: -1 }).heavyPageBytes).toBe(
      DEFAULT_AUDIT_THRESHOLDS.heavyPageBytes,
    );
  });
});
