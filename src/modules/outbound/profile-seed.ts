/**
 * "Find companies like these" (spec §4.43.2c, playbook-v6 F1/4).
 *
 * Given the datasheets of one to five reference companies, propose a profile:
 * the segments their activity codes fall in, the size bands they occupy, their
 * legal forms and their counties. Every suggestion carries the references that
 * produced it, so the person editing can see that "LARGE" came from PwC and
 * KPMG and not from the small firm they also listed.
 *
 * A convenience, not an oracle: the result is a DRAFT the UI pre-fills and the
 * person edits. Nothing here saves anything.
 */
import type { CompanyDatasheet } from "@/modules/registry/datasheet";
import { activityCodes } from "@/modules/registry/datasheet";
import { resolveSizeBand, type SizeBand } from "./size-band";
import { teaorMatches } from "./segments-seed";

export interface Suggested<T> {
  value: T;
  /** Reference company names that produced this suggestion. */
  from: string[];
}

export interface ProfileSuggestion {
  segments: Suggested<string>[];
  /** Principal activity codes that matched no known segment — worth a look. */
  unmatchedActivities: Suggested<string>[];
  sizeBands: Suggested<SizeBand>[];
  legalForms: Suggested<string>[];
  counties: Suggested<string>[];
  /** References whose datasheet could not be fetched. */
  missing: string[];
}

export interface SegmentLike {
  key: string;
  teaorInclude: readonly string[];
  teaorExclude: readonly string[];
}

function add<T>(list: Suggested<T>[], value: T, from: string): void {
  const hit = list.find((s) => s.value === value);
  if (hit) {
    if (!hit.from.includes(from)) hit.from.push(from);
  } else {
    list.push({ value, from: [from] });
  }
}

/** Most-shared first: what all the references agree on is the strongest hint. */
function byStrength<T>(list: Suggested<T>[]): Suggested<T>[] {
  return [...list].sort((a, b) => b.from.length - a.from.length);
}

export function suggestProfile(
  references: Array<{ name: string; sheet: CompanyDatasheet | null }>,
  segments: readonly SegmentLike[],
): ProfileSuggestion {
  const out: ProfileSuggestion = {
    segments: [],
    unmatchedActivities: [],
    sizeBands: [],
    legalForms: [],
    counties: [],
    missing: [],
  };

  for (const ref of references) {
    const sheet = ref.sheet;
    if (!sheet) {
      out.missing.push(ref.name);
      continue;
    }
    // Principal activity first; the full list only widens the net when the
    // principal says nothing we recognise.
    const principal = sheet.principalActivity?.code ? [sheet.principalActivity.code] : [];
    let matchedAny = false;
    for (const seg of segments) {
      if (teaorMatches(principal, seg)) {
        add(out.segments, seg.key, ref.name);
        matchedAny = true;
      }
    }
    if (!matchedAny) {
      const all = activityCodes(sheet);
      for (const seg of segments) {
        if (teaorMatches(all, seg)) {
          add(out.segments, seg.key, ref.name);
          matchedAny = true;
        }
      }
    }
    if (!matchedAny && sheet.principalActivity?.code) {
      add(out.unmatchedActivities, sheet.principalActivity.code, ref.name);
    }

    const size = resolveSizeBand({ employeeCount: sheet.employeeCount, netRevenue: sheet.netRevenue });
    if (size.band) add(out.sizeBands, size.band, ref.name);
    if (sheet.legalForm) add(out.legalForms, sheet.legalForm, ref.name);
    if (sheet.seat.county) add(out.counties, sheet.seat.county, ref.name);
  }

  return {
    segments: byStrength(out.segments),
    unmatchedActivities: byStrength(out.unmatchedActivities),
    sizeBands: byStrength(out.sizeBands),
    legalForms: byStrength(out.legalForms),
    counties: byStrength(out.counties),
    missing: out.missing,
  };
}
