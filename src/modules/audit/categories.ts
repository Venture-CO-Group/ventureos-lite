/**
 * Audit categories and per-category subscores (P1/3c, 3d).
 *
 * The audit used to be a flat list of pass/fail lines and one number. That is
 * hard to act on: "72" says a site is weak, not WHERE it is weak, and a
 * prospect reading the public report gets a verdict without a shape.
 *
 * Every check now belongs to exactly one category and carries a weight. The
 * subscore for a category is the share of its weight that FAILED — same
 * direction as the overall opportunity score, where high means weak site and
 * therefore strong opportunity. Categories with no applicable checks report
 * null rather than 0, because "nothing to measure" is not "perfect".
 *
 * Pure and dependency-free so the whole scheme is testable without a browser,
 * a network or a database.
 */
import type { AuditCheck } from "./types";

export const AUDIT_CATEGORIES = [
  "security",
  "email",
  "legal",
  "seo",
  "conversion",
  "accessibility",
  "performance",
  "structure",
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** English for the internal view, Hungarian for anything a prospect reads. */
export const CATEGORY_LABEL: Record<AuditCategory, { en: string; hu: string }> = {
  security: { en: "Security & trust", hu: "Biztonság és bizalom" },
  email: { en: "Email hygiene", hu: "E-mail beállítások" },
  legal: { en: "Legal compliance", hu: "Jogi megfelelés" },
  seo: { en: "Findability", hu: "Megtalálhatóság" },
  conversion: { en: "Analytics & conversion", hu: "Mérés és megkeresés" },
  accessibility: { en: "Accessibility", hu: "Akadálymentesség" },
  performance: { en: "Speed", hu: "Sebesség" },
  structure: { en: "Site structure", hu: "Oldalszerkezet" },
};

/**
 * Categories that only a multi-page crawl can produce (P2/1).
 *
 * The crawl is an internal tool: public and self-serve audits stay single-page
 * for cost control, and the public share page must not show findings the
 * reader's own single-page report never contained. Filtered out there.
 */
export const INTERNAL_ONLY_CATEGORIES: ReadonlySet<AuditCategory> = new Set(["structure"]);

/**
 * Default weight per category, summing to 100. The Owner can retune these in
 * Settings; a HoReCa prospect list and a clinic list do not care equally about
 * the same things.
 */
export const DEFAULT_CATEGORY_WEIGHTS: Record<AuditCategory, number> = {
  security: 16,
  email: 8,
  legal: 16,
  seo: 16,
  conversion: 12,
  accessibility: 12,
  performance: 10,
  structure: 10,
};

export type CategoryWeights = Record<AuditCategory, number>;

/** Read weights from the workspace's audit config, falling back per key. */
export function weightsFrom(config: unknown): CategoryWeights {
  const raw =
    config && typeof config === "object" && "categoryWeights" in config
      ? ((config as { categoryWeights?: unknown }).categoryWeights ?? {})
      : {};
  const out = { ...DEFAULT_CATEGORY_WEIGHTS };
  if (raw && typeof raw === "object") {
    for (const key of AUDIT_CATEGORIES) {
      const v = (raw as Record<string, unknown>)[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = v;
    }
  }
  return out;
}

/** A check's category and how much it counts within it. */
export interface CheckMeta {
  category: AuditCategory;
  /** Relative weight inside its category. Defaults to 1. */
  weight?: number;
}

/**
 * The registry. A check absent from here is still displayed but scores
 * nothing — better than silently inventing a category for it.
 */
export const CHECK_META: Record<string, CheckMeta> = {
  // security & trust
  https: { category: "security", weight: 3 },
  httpsRedirect: { category: "security", weight: 2 },
  sslExpiry: { category: "security", weight: 2 },
  hsts: { category: "security" },
  xcto: { category: "security" },
  xfo: { category: "security" },
  csp: { category: "security" },
  mixedContent: { category: "security", weight: 2 },

  // email hygiene
  spf: { category: "email", weight: 2 },
  dmarc: { category: "email", weight: 2 },

  // Hungarian legal
  impresszum: { category: "legal", weight: 3 },
  privacyPolicy: { category: "legal", weight: 3 },
  aszf: { category: "legal", weight: 2 },
  cookie: { category: "legal", weight: 2 },

  // findability
  title: { category: "seo" },
  metaDescription: { category: "seo" },
  openGraph: { category: "seo" },
  canonical: { category: "seo" },
  schemaOrg: { category: "seo" },
  h1: { category: "seo" },
  headingHierarchy: { category: "seo" },
  altCoverage: { category: "seo" },
  sitemap: { category: "seo" },
  robots: { category: "seo" },
  psiSeo: { category: "seo" },
  /// P2/9 — content that only exists after JavaScript runs is content a
  /// search engine may never index.
  jsDependency: { category: "seo", weight: 3 },

  // analytics & conversion
  analytics: { category: "conversion", weight: 2 },
  clickToCall: { category: "conversion", weight: 2 },
  contactForm: { category: "conversion", weight: 2 },
  booking: { category: "conversion" },
  contact: { category: "conversion" },

  // accessibility
  a11yCritical: { category: "accessibility", weight: 3 },
  a11ySerious: { category: "accessibility", weight: 2 },
  psiAccessibility: { category: "accessibility" },

  // speed
  viewport: { category: "performance", weight: 2 },
  pageWeight: { category: "performance", weight: 2 },
  psiPerformance: { category: "performance", weight: 2 },
  copyright: { category: "performance" },

  // site structure — only present on a crawled audit (P2/1)
  brokenLinks: { category: "structure", weight: 3 },
  redirectChains: { category: "structure" },
  pageTitles: { category: "structure", weight: 2 },
  duplicateTitles: { category: "structure", weight: 2 },
  pageMetaDescriptions: { category: "structure" },
  duplicateMetaDescriptions: { category: "structure" },
  h1Consistency: { category: "structure" },
  orphanPages: { category: "structure" },
  pageWeightOutliers: { category: "structure" },
};

export interface CategoryScore {
  category: AuditCategory;
  /** 0-100 share of this category's weight that failed. Null = not measured. */
  subscore: number | null;
  failed: number;
  total: number;
  checks: AuditCheck[];
}

/**
 * Group checks by category and score each one.
 *
 * A category with no checks yields subscore null and is rendered as "not
 * measured" rather than as a perfect or a zero — both of which would be lies.
 */
export function scoreByCategory(checks: AuditCheck[]): CategoryScore[] {
  const buckets = new Map<AuditCategory, AuditCheck[]>();
  for (const c of AUDIT_CATEGORIES) buckets.set(c, []);

  for (const check of checks) {
    const meta = CHECK_META[check.key];
    if (!meta) continue;
    buckets.get(meta.category)!.push(check);
  }

  return AUDIT_CATEGORIES.map((category) => {
    const list = buckets.get(category)!;
    if (list.length === 0) {
      return { category, subscore: null, failed: 0, total: 0, checks: [] };
    }
    let weightTotal = 0;
    let weightFailed = 0;
    for (const c of list) {
      const w = CHECK_META[c.key]?.weight ?? 1;
      weightTotal += w;
      if (!c.pass) weightFailed += w;
    }
    return {
      category,
      subscore: weightTotal === 0 ? null : Math.round((weightFailed / weightTotal) * 100),
      failed: list.filter((c) => !c.pass).length,
      total: list.length,
      checks: list,
    };
  });
}

/**
 * What the public share page is allowed to group and show.
 *
 * One function rather than a filter written inline in the page, so the rule
 * that keeps crawl findings off a prospect-facing surface is the thing a test
 * can pin — a filter in JSX would drift the first time the page is edited.
 */
export function publicCategoryGroups(checks: AuditCheck[]): CategoryScore[] {
  return scoreByCategory(checks).filter(
    (g) => g.total > 0 && !INTERNAL_ONLY_CATEGORIES.has(g.category),
  );
}

/**
 * Checks with no category mapping.
 *
 * Grouping by category would otherwise DROP them from the report entirely, so
 * a check added without a registry entry would silently disappear from every
 * surface. They are rendered in a trailing group and score nothing, which is
 * visible and harmless — unlike vanishing.
 */
export function ungroupedChecks(checks: AuditCheck[]): AuditCheck[] {
  return checks.filter((c) => !CHECK_META[c.key]);
}

/**
 * Weighted opportunity score from the category subscores.
 *
 * Only measured categories count, and the divisor shrinks with them — so a
 * site whose DNS could not be resolved is not quietly penalised for it.
 */
export function overallFromCategories(
  scores: CategoryScore[],
  weights: CategoryWeights = DEFAULT_CATEGORY_WEIGHTS,
): number {
  let weighted = 0;
  let applied = 0;
  for (const s of scores) {
    if (s.subscore === null) continue;
    const w = weights[s.category] ?? 0;
    weighted += s.subscore * w;
    applied += w;
  }
  if (applied === 0) return 0;
  return Math.round(weighted / applied);
}

/**
 * Schema version stamped on every stored audit.
 *
 * Bump when the check set or category mapping changes in a way that would make
 * an older stored audit render wrongly. Reports keep their original version so
 * a cached audit still shows the grouping it was scored under.
 */
export const AUDIT_SCHEMA_VERSION = 4;
