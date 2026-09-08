import type { AuditVerdict } from "@prisma/client";
import {
  DEFAULT_AUDIT_THRESHOLDS,
  type AuditThresholds,
} from "./config";
import type { AuditAnalysis, AuditCheck, PageProbe } from "./types";
import { overallFromCategories, scoreByCategory } from "./categories";
import {
  detectFramework,
  jsDependencyCheck,
  jsDependencyPercent,
} from "./framework";

/**
 * Rule-based opportunity scoring (spec §4.4). High score = weak site = strong
 * sales opportunity. No AI here — thresholds come from Settings; the verdict is
 * a rule, not a model.
 */

function fmtMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function verdictFor(
  score: number,
  thresholds: AuditThresholds = DEFAULT_AUDIT_THRESHOLDS,
): AuditVerdict {
  if (score >= thresholds.verdict.strong) return "STRONG";
  if (score >= thresholds.verdict.possible) return "POSSIBLE";
  return "SKIP";
}

export function analyzeAudit(
  probe: PageProbe,
  thresholds: AuditThresholds = DEFAULT_AUDIT_THRESHOLDS,
  now: Date = new Date(),
): AuditAnalysis {
  const altCoverage =
    probe.imgTotal === 0 ? 1 : probe.imgWithAlt / probe.imgTotal;
  const copyrightOld =
    probe.copyrightYear !== null && probe.copyrightYear < now.getUTCFullYear() - 2;
  const hasContact = probe.hasPhone || probe.hasEmail || probe.hasForm;

  const checks: AuditCheck[] = [
    { key: "https", label: "HTTPS valid", pass: probe.isHttps },
    { key: "viewport", label: "Mobile viewport", pass: probe.hasViewport },
    { key: "title", label: "Page title", pass: !!probe.title },
    { key: "metaDescription", label: "Meta description", pass: !!probe.metaDescription },
    { key: "h1", label: "H1 heading", pass: probe.h1Count >= 1 },
    {
      key: "altCoverage",
      label: "Image alt coverage",
      pass: altCoverage >= 0.5,
      detail: `${Math.round(altCoverage * 100)}%`,
    },
    { key: "sitemap", label: "sitemap.xml", pass: probe.hasSitemap },
    { key: "robots", label: "robots.txt", pass: probe.hasRobots },
    {
      key: "copyright",
      label: "Copyright year",
      pass: !copyrightOld,
      detail: probe.copyrightYear ? String(probe.copyrightYear) : undefined,
    },
    { key: "contact", label: "Contact method visible", pass: hasContact },
    { key: "booking", label: "Online booking", pass: probe.hasBooking },
    { key: "cookie", label: "Cookie consent (GDPR)", pass: probe.hasCookieBanner },
    {
      key: "pageWeight",
      label: "Page weight",
      pass: probe.pageWeightBytes <= thresholds.heavyPageBytes,
      detail: fmtMb(probe.pageWeightBytes),
    },
  ];

  // ---- P1/3c: expanded deterministic checks -------------------------------
  // Each block is skipped entirely when its signal was not measured, so an
  // unreachable DNS server or a failed axe run leaves its category as
  // "not measured" rather than inventing failures.
  const add = (key: string, label: string, pass: boolean, detail?: string) =>
    checks.push({ key, label, pass, ...(detail ? { detail } : {}) });

  if (probe.httpsRedirect !== undefined) {
    add("httpsRedirect", "HTTP redirects to HTTPS", probe.httpsRedirect);
  }
  if (probe.sslDaysLeft !== undefined && probe.sslDaysLeft !== null) {
    add(
      "sslExpiry",
      "Certificate not expiring soon",
      probe.sslDaysLeft >= 30,
      probe.sslDaysLeft < 0 ? "expired" : `${probe.sslDaysLeft} days left`,
    );
  }
  if (probe.hsts !== undefined) add("hsts", "HSTS header", probe.hsts);
  if (probe.xContentTypeOptions !== undefined) {
    add("xcto", "X-Content-Type-Options", probe.xContentTypeOptions);
  }
  if (probe.xFrameOptions !== undefined) add("xfo", "Clickjacking protection", probe.xFrameOptions);
  if (probe.csp !== undefined) add("csp", "Content-Security-Policy", probe.csp);
  if (probe.mixedContent !== undefined) {
    add("mixedContent", "No mixed content", !probe.mixedContent);
  }

  if (probe.spf !== undefined) add("spf", "SPF record", probe.spf);
  if (probe.dmarc !== undefined) add("dmarc", "DMARC record", probe.dmarc);

  if (probe.hasImpresszum !== undefined) {
    add("impresszum", "Impresszum", probe.hasImpresszum);
  }
  if (probe.hasPrivacyPolicy !== undefined) {
    add("privacyPolicy", "Adatkezelési tájékoztató", probe.hasPrivacyPolicy);
  }
  // ÁSZF is only required of a webshop; on a brochure site its absence is
  // not a finding, so the check is not emitted at all.
  if (probe.isWebshop && probe.hasAszf !== undefined) {
    add("aszf", "ÁSZF (webshop)", probe.hasAszf);
  }

  if (probe.hasOpenGraph !== undefined) add("openGraph", "Open Graph tags", probe.hasOpenGraph);
  if (probe.hasCanonical !== undefined) add("canonical", "Canonical URL", probe.hasCanonical);
  if (probe.hasSchemaOrg !== undefined) add("schemaOrg", "Structured data", probe.hasSchemaOrg);
  if (probe.headingHierarchyOk !== undefined) {
    add("headingHierarchy", "Heading structure", probe.headingHierarchyOk);
  }
  if (probe.sitemapUrlCount !== undefined && probe.sitemapUrlCount !== null) {
    // Enrich the existing sitemap check rather than pushing a second one with
    // the same key — a duplicate would be counted twice by the category
    // scorer and shown twice in the report.
    const existing = checks.find((c) => c.key === "sitemap");
    const detail = `${probe.sitemapUrlCount} URLs`;
    if (existing) {
      existing.pass = probe.sitemapUrlCount > 0;
      existing.detail = detail;
    } else {
      add("sitemap", "sitemap.xml", probe.sitemapUrlCount > 0, detail);
    }
  }

  if (probe.hasAnalytics !== undefined) add("analytics", "Analytics installed", probe.hasAnalytics);
  add("clickToCall", "Click-to-call link", probe.hasPhone);
  add("contactForm", "Contact form", probe.hasForm);

  if (probe.a11y) {
    add(
      "a11yCritical",
      "No critical accessibility violations",
      probe.a11y.critical === 0,
      probe.a11y.critical > 0 ? `${probe.a11y.critical} critical` : undefined,
    );
    add(
      "a11ySerious",
      "No serious accessibility violations",
      probe.a11y.serious === 0,
      probe.a11y.serious > 0 ? `${probe.a11y.serious} serious` : undefined,
    );
  }

  // Not measured is not "passed". The row fails so it renders in red beside
  // the others, but its default weight is 0: PageSpeed being unreachable is
  // our problem, not evidence against the prospect's site, and it must never
  // move the opportunity score.
  if (!probe.psi && probe.psiUnavailable) {
    add("psiAvailable", "PageSpeed measured", false, probe.psiUnavailable);
  }

  if (probe.psi) {
    checks.push(
      {
        key: "psiPerformance",
        label: "PageSpeed performance",
        pass: (probe.psi.performance ?? 100) >= 50,
        detail: probe.psi.performance != null ? `${probe.psi.performance}/100` : undefined,
      },
      {
        key: "psiSeo",
        label: "PageSpeed SEO",
        pass: (probe.psi.seo ?? 100) >= 50,
        detail: probe.psi.seo != null ? `${probe.psi.seo}/100` : undefined,
      },
      {
        key: "psiAccessibility",
        label: "PageSpeed accessibility",
        pass: (probe.psi.accessibility ?? 100) >= 50,
        detail:
          probe.psi.accessibility != null ? `${probe.psi.accessibility}/100` : undefined,
      },
    );
  }

  /**
   * ---- the JS-dependency finding (P2/9) -------------------------------
   *
   * Moved in here from the worker.
   *
   * It is derived entirely from the probe — framework markers in the server's
   * HTML, against how much text only appears after hydration — so there was
   * never a reason for it to live outside the pure analysis. Appending it in
   * `processAudit` instead meant it was NOT scored, and meant every stage that
   * re-ran the analysis had to remember to fold it back in or it silently
   * vanished from the report. That fragility has its own three-line comment in
   * jobs.ts; this deletes the need for it.
   */
  if (probe.rawHtml !== undefined) {
    const detection = detectFramework(probe.rawHtml);
    const jsCheck = jsDependencyCheck(
      jsDependencyPercent(probe.rawHtml, probe.renderedTextLength ?? 0),
      detection,
    );
    if (jsCheck) checks.push(jsCheck);
  }

  /**
   * ---- the score --------------------------------------------------------
   *
   * From the CATEGORY system, which maps all thirty-three checks — not from
   * the thirteen-entry flat table this used to sum, under which twenty checks
   * were worth nothing at all. See config.ts for the whole story.
   *
   * `overallFromCategories` counts only categories that were actually
   * measured, and shrinks its divisor with them: a site whose DNS would not
   * resolve is not quietly penalised for what we failed to look at. A crawled
   * audit stays comparable with an uncrawled one for the same reason — the
   * structure category is absent here, so it contributes nothing either way.
   */
  const categories = scoreByCategory(checks);
  const score = overallFromCategories(categories, thresholds.categoryWeights);

  // Opportunity flags — attach to the lead as trigger signals (spec §4.4).
  const flags: string[] = [];
  if (!probe.hasViewport) flags.push("no mobile");
  if (probe.psi?.performance != null && probe.psi.performance < 50) flags.push("slow site");
  if (copyrightOld) flags.push("outdated website");
  if (!hasContact) flags.push("no conversion path");
  if (!probe.hasBooking) flags.push("no online booking");
  if (!probe.hasCookieBanner) flags.push("GDPR gap");
  if (!probe.metaDescription) flags.push("weak SEO");

  return { score, verdict: verdictFor(score, thresholds), checks, flags };
}
