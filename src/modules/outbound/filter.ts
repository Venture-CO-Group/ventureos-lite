/**
 * The local ICP filter (spec §4.43.5): the profile's rules applied to a
 * datasheet we have already paid for.
 *
 * Every refusal names the rule AND the measured value — "net revenue 42 M Ft
 * < profile minimum 300 M Ft" — because the distribution of these is how
 * anyone learns whether the source or the profile is wrong. Pure.
 */
import type { CandidateReason } from "@prisma/client";
import type { CompanyDatasheet } from "@/modules/registry/datasheet";
import { activityCodes, foundedYear } from "@/modules/registry/datasheet";
import { checkSize, type SizeBand } from "./size-band";
import { teaorMatches } from "./segments-seed";

export interface FilterProfile {
  segmentKeys: readonly string[];
  sizeBands: readonly SizeBand[];
  includeUnknownSize: boolean;
  revenueMin: number | null;
  revenueMax: number | null;
  counties: readonly string[];
  cities: readonly string[];
  legalForms: readonly string[];
  foundedAfter: number | null;
  foundedBefore: number | null;
  statusRequired: string;
  requiresWebsite: boolean;
  auditScoreMin: number | null;
  auditScoreMax: number | null;
  requiredSignals: readonly string[];
}

export interface FilterSegment {
  key: string;
  teaorInclude: readonly string[];
  teaorExclude: readonly string[];
}

export type FilterVerdict =
  | { ok: true; matchedSegment: string | null; sizeBand: SizeBand | null; unknownSize: boolean }
  | { ok: false; reason: CandidateReason; detail: string };

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+megye$/, "")
    .trim();

export function formatFt(n: bigint | number): string {
  const v = typeof n === "bigint" ? Number(n) : n;
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2).replace(/\.?0+$/, "")} Mrd Ft`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, "")} M Ft`;
  return `${Math.round(v).toLocaleString("hu-HU")} Ft`;
}

export function localFilter(
  profile: FilterProfile,
  sheet: CompanyDatasheet,
  segments: readonly FilterSegment[],
  extra: { website?: string | null } = {},
): FilterVerdict {
  // 1. Alive at all.
  if (profile.statusRequired && fold(sheet.status ?? "") !== fold(profile.statusRequired)) {
    return { ok: false, reason: "STATUS", detail: `registry status "${sheet.status ?? "unknown"}", profile wants "${profile.statusRequired}"` };
  }

  // 2. Segment by activity code.
  let matchedSegment: string | null = null;
  if (profile.segmentKeys.length > 0) {
    const codes = activityCodes(sheet);
    for (const key of profile.segmentKeys) {
      const seg = segments.find((s) => s.key === key);
      if (seg && teaorMatches(codes, seg)) {
        matchedSegment = key;
        break;
      }
    }
    if (!matchedSegment) {
      const principal = sheet.principalActivity
        ? `${sheet.principalActivity.code}${sheet.principalActivity.label ? ` ${sheet.principalActivity.label}` : ""}`
        : "no activity code";
      return { ok: false, reason: "SEGMENT", detail: `activity ${principal} is in none of ${profile.segmentKeys.join(", ")}` };
    }
  }

  // 3. Size.
  const size = checkSize(profile, { employeeCount: sheet.employeeCount, netRevenue: sheet.netRevenue });
  if (!size.ok) return { ok: false, reason: "SIZE", detail: size.reason };

  // 4. Revenue range. A missing revenue fails a revenue rule: the rule is a
  //    requirement, and "unknown" does not meet it.
  if (profile.revenueMin !== null || profile.revenueMax !== null) {
    if (sheet.netRevenue === null) {
      return { ok: false, reason: "REVENUE", detail: "no net revenue on the datasheet, and the profile has a revenue rule" };
    }
    if (profile.revenueMin !== null && sheet.netRevenue < BigInt(profile.revenueMin)) {
      return { ok: false, reason: "REVENUE", detail: `net revenue ${formatFt(sheet.netRevenue)} < profile minimum ${formatFt(profile.revenueMin)}` };
    }
    if (profile.revenueMax !== null && sheet.netRevenue > BigInt(profile.revenueMax)) {
      return { ok: false, reason: "REVENUE", detail: `net revenue ${formatFt(sheet.netRevenue)} > profile maximum ${formatFt(profile.revenueMax)}` };
    }
  }

  // 5. Region.
  if (profile.counties.length > 0 || profile.cities.length > 0) {
    const county = fold(sheet.seat.county ?? "");
    const city = fold(sheet.seat.city ?? "");
    const inCounty = profile.counties.some((c) => fold(c) === county);
    const inCity = profile.cities.some((c) => fold(c) === city);
    if (!inCounty && !inCity) {
      return {
        ok: false,
        reason: "REGION",
        detail: `seat ${sheet.seat.city ?? "?"} (${sheet.seat.county ?? "?"}) is outside ${[...profile.counties, ...profile.cities].join(", ")}`,
      };
    }
  }

  // 6. Legal form.
  if (profile.legalForms.length > 0) {
    const form = (sheet.legalForm ?? "").toLowerCase();
    if (!profile.legalForms.some((f) => f.toLowerCase() === form)) {
      return { ok: false, reason: "LEGAL_FORM", detail: `legal form ${sheet.legalForm ?? "unknown"}, profile wants ${profile.legalForms.join("/")}` };
    }
  }

  // 7. Founded.
  if (profile.foundedAfter !== null || profile.foundedBefore !== null) {
    const y = foundedYear(sheet);
    if (y === null) return { ok: false, reason: "FOUNDED", detail: "no founding date on the datasheet" };
    if (profile.foundedAfter !== null && y < profile.foundedAfter) {
      return { ok: false, reason: "FOUNDED", detail: `founded ${y}, profile wants ${profile.foundedAfter} or later` };
    }
    if (profile.foundedBefore !== null && y > profile.foundedBefore) {
      return { ok: false, reason: "FOUNDED", detail: `founded ${y}, profile wants ${profile.foundedBefore} or earlier` };
    }
  }

  // 8. Website, when the profile insists on one.
  if (profile.requiresWebsite && !sheet.website && !extra.website) {
    return { ok: false, reason: "NO_WEBSITE", detail: "no website on the datasheet or in the pool, and the profile requires one" };
  }

  return { ok: true, matchedSegment, sizeBand: size.band, unknownSize: size.unknownSize };
}

/** After the audit: the profile's score range and required signals. */
export function auditFilter(
  profile: Pick<FilterProfile, "auditScoreMin" | "auditScoreMax" | "requiredSignals">,
  audit: { score: number; flags: readonly string[] } | null,
): { ok: true } | { ok: false; reason: CandidateReason; detail: string } {
  if (!audit) {
    // No site: the score rules cannot be met, but the absence is itself the
    // hook — so only a profile that names signals refuses it.
    if (profile.requiredSignals.length > 0) {
      return { ok: false, reason: "SIGNALS", detail: `no website to audit, profile requires ${profile.requiredSignals.join(", ")}` };
    }
    return { ok: true };
  }
  if (profile.auditScoreMin !== null && audit.score < profile.auditScoreMin) {
    return { ok: false, reason: "AUDIT_SCORE", detail: `audit score ${audit.score} < profile minimum ${profile.auditScoreMin}` };
  }
  if (profile.auditScoreMax !== null && audit.score > profile.auditScoreMax) {
    return { ok: false, reason: "AUDIT_SCORE", detail: `audit score ${audit.score} > profile maximum ${profile.auditScoreMax}` };
  }
  const flags = audit.flags.map((f) => f.toLowerCase());
  const missing = profile.requiredSignals.filter((s) => !flags.includes(s.toLowerCase()));
  if (missing.length > 0) {
    return { ok: false, reason: "SIGNALS", detail: `audit lacks required signal${missing.length > 1 ? "s" : ""} ${missing.join(", ")}` };
  }
  return { ok: true };
}
