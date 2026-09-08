import {
  AUDIT_CATEGORIES,
  DEFAULT_CATEGORY_WEIGHTS,
  type CategoryWeights,
} from "./categories";

/**
 * Audit scoring config — verdict thresholds and category weights,
 * Owner-configurable in Settings (spec §4.4: "thresholds set in Settings, not
 * by AI").
 *
 * ── WHY THIS SHRANK ─────────────────────────────────────────────────────────
 *
 * It used to carry a flat `weights: Record<checkKey, points>` table with
 * THIRTEEN entries, and `analyzeAudit` scored by summing the points of failed
 * checks. Meanwhile `categories.ts` grew a complete, weighted mapping of all
 * thirty-three checks into eight categories, with an `overallFromCategories`
 * function that scored exactly the right thing — and which nothing ever
 * called.
 *
 * So the product had two scoring systems, and the headline number used the
 * impoverished one. Twenty checks contributed nothing: a site five days from
 * an expired certificate, with no CSP, no SPF, no impresszum, no privacy
 * notice and twenty-one serious accessibility violations scored exactly the
 * same for all of them as a site that passed every one.
 *
 * There is one system now, and the knob an Owner turns is the CATEGORY weight
 * — which is the level people actually think at ("this list cares about legal
 * compliance more than about speed"), rather than the individual check.
 */
export interface AuditThresholds {
  verdict: { strong: number; possible: number };
  /** How much each category counts toward the headline score. */
  categoryWeights: CategoryWeights;
  /** Bytes past which the page-weight check fails. */
  heavyPageBytes: number;
}

export const DEFAULT_AUDIT_THRESHOLDS: AuditThresholds = {
  verdict: { strong: 45, possible: 33 },
  categoryWeights: DEFAULT_CATEGORY_WEIGHTS,
  heavyPageBytes: 3_000_000,
};

/**
 * The verdict bands moved with the scoring, and they had to.
 *
 * The old flat sum reached 100 only by failing nearly everything, so `strong:
 * 70` sat near the top of a range nothing real occupied — under it, a
 * one-person accountancy with no HTTPS and no impresszum scored 28 and came
 * back SKIP, same as telex.hu. The number could not discriminate, which is
 * what made the whole defect invisible: nobody misses a signal they never had.
 *
 * A category-weighted score is a weighted average of per-category failure
 * shares, so it uses the whole range. Calibrated against fourteen live sites
 * probed while making this change:
 *
 *   20-28   rdmethod, telex, OTP Bank, Libri        — professional builds
 *   36-44   drszeiler, emag, index, shefitness,
 *           pomodorobudapest, vargakonyveloiroda    — mixed
 *   45-50   csulokbar, unicontplusz, konyvelesed    — genuinely weak
 *
 * So SKIP below 33, POSSIBLE to 44, STRONG at 45 and above. Fourteen samples
 * is a judgement call rather than a statistic, which is precisely why these
 * are Owner-tunable in Settings — a HoReCa list and a clinic list will not
 * agree about where the line sits, and now they do not have to.
 */

export function auditThresholdsFromConfig(cfg: unknown): AuditThresholds {
  if (!cfg || typeof cfg !== "object") return DEFAULT_AUDIT_THRESHOLDS;
  const c = cfg as {
    verdict?: Partial<AuditThresholds["verdict"]>;
    categoryWeights?: unknown;
    heavyPageBytes?: unknown;
  };

  const categoryWeights = { ...DEFAULT_CATEGORY_WEIGHTS };
  if (c.categoryWeights && typeof c.categoryWeights === "object") {
    for (const key of AUDIT_CATEGORIES) {
      const v = (c.categoryWeights as Record<string, unknown>)[key];
      // Zero is a legitimate answer — "this list does not care about email
      // hygiene" — so only a non-number or a negative is rejected.
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) categoryWeights[key] = v;
    }
  }

  return {
    verdict: { ...DEFAULT_AUDIT_THRESHOLDS.verdict, ...c.verdict },
    categoryWeights,
    heavyPageBytes:
      typeof c.heavyPageBytes === "number" && c.heavyPageBytes > 0
        ? c.heavyPageBytes
        : DEFAULT_AUDIT_THRESHOLDS.heavyPageBytes,
  };
}
