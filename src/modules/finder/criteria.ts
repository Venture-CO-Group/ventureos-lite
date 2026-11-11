/**
 * Company Finder — the saved filter definition ("lista") and the local filter
 * that applies it.
 *
 * ── WHY EVERYTHING HERE IS LOCAL ───────────────────────────────────────────
 *
 * Cégadat's `/v1/search` takes a name, a tax or registry number, a business
 * type, a status and paging — nothing else. It cannot filter on activity
 * code, size, revenue, region, legal form or founding date. So a list
 * harvests candidates by NAME (each segment fragment and each free-text
 * keyword is one harvest), and every other criterion is checked here, on a
 * datasheet we already hold. That is the whole cost model: the harvest is
 * free, a cached datasheet is free, and only a new datasheet costs quota.
 *
 * Pure and dependency-light on purpose: the server evaluates results with it,
 * and the results table runs the very same function in the browser so the
 * "refine" filters there cannot disagree with the run.
 */
import { z } from "zod";
import { SIZE_BANDS, checkSize, type SizeBand } from "@/modules/outbound/size-band";
import { normalizeTeaor, teaorMatches } from "@/modules/outbound/segments-seed";

export const FINDER_STATUSES = ["Aktív", "Eljárás alatt", "Szüneteltetett", "any"] as const;
export const FINDER_BUSINESS_TYPES = ["company", "individualEntrepreneur", "both"] as const;
export const CONTACT_REQUIREMENTS = ["none", "any", "email", "phone", "website"] as const;

export type FinderStatus = (typeof FINDER_STATUSES)[number];
export type FinderBusinessType = (typeof FINDER_BUSINESS_TYPES)[number];
export type ContactRequirement = (typeof CONTACT_REQUIREMENTS)[number];

/** The legal forms a list may ask for — the abbreviations the provider maps to. */
export const LEGAL_FORMS = ["Kft.", "Zrt.", "Nyrt.", "Bt.", "Kkt.", "e.v.", "e.c.", "Szöv."] as const;

export const HU_COUNTIES = [
  "Budapest",
  "Bács-Kiskun",
  "Baranya",
  "Békés",
  "Borsod-Abaúj-Zemplén",
  "Csongrád-Csanád",
  "Fejér",
  "Győr-Moson-Sopron",
  "Hajdú-Bihar",
  "Heves",
  "Jász-Nagykun-Szolnok",
  "Komárom-Esztergom",
  "Nógrád",
  "Pest",
  "Somogy",
  "Szabolcs-Szatmár-Bereg",
  "Tolna",
  "Vas",
  "Veszprém",
  "Zala",
] as const;

const cleanList = (max: number, each: number) =>
  z
    .array(z.string().trim().max(each))
    .max(max)
    .default([])
    .transform((xs) => [...new Set(xs.filter((x) => x.length > 0))]);

const teaorList = z
  .array(z.string().trim().max(10))
  .max(200)
  .default([])
  .transform((xs) => [...new Set(xs.map(normalizeTeaor).filter((x) => x.length >= 2))]);

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, "Use YYYY, YYYY-MM or YYYY-MM-DD")
  .nullish()
  .transform((v) => v || null);

const forints = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .nullish()
  .transform((v) => (v === undefined ? null : v));

export const finderCriteriaSchema = z
  .object({
    /** Segment keys from the outbound taxonomy: their fragments are harvested, their TEÁOR codes match. */
    segmentKeys: cleanList(50, 80),
    /** Free-text name keywords; each one becomes a harvesting fragment (four characters at least). */
    keywords: cleanList(50, 60).refine((ks) => ks.every((k) => k.length >= 4), {
      message: "Each keyword needs at least four characters — the registry refuses shorter searches.",
    }),
    teaorInclude: teaorList,
    teaorExclude: teaorList,
    /** Match TEÁOR codes against every registered activity, not only the principal one. */
    teaorAllActivities: z.boolean().default(false),
    sizeBands: z.array(z.enum(SIZE_BANDS)).max(4).default([]),
    includeUnknownSize: z.boolean().default(false),
    revenueMin: forints,
    revenueMax: forints,
    counties: cleanList(25, 60),
    cities: cleanList(100, 80),
    legalForms: cleanList(12, 30),
    foundedFrom: isoDate,
    foundedTo: isoDate,
    status: z.enum(FINDER_STATUSES).default("Aktív"),
    businessType: z.enum(FINDER_BUSINESS_TYPES).default("company"),
    contactRequirement: z.enum(CONTACT_REQUIREMENTS).default("none"),
    excludeInCrm: z.boolean().default(true),
    excludeSuppressed: z.boolean().default(true),
  })
  .refine((c) => c.revenueMin === null || c.revenueMax === null || c.revenueMin <= c.revenueMax, {
    message: "The revenue minimum is above the maximum.",
    path: ["revenueMin"],
  })
  .refine((c) => !c.foundedFrom || !c.foundedTo || c.foundedFrom <= c.foundedTo, {
    message: "The founding range ends before it starts.",
    path: ["foundedFrom"],
  });

export type FinderCriteria = z.output<typeof finderCriteriaSchema>;
export type FinderCriteriaInput = z.input<typeof finderCriteriaSchema>;

export const DEFAULT_CRITERIA: FinderCriteria = finderCriteriaSchema.parse({});

/** A stored criteria blob → criteria, falling back to the defaults rather than throwing. */
export function parseCriteria(raw: unknown): FinderCriteria {
  const r = finderCriteriaSchema.safeParse(raw ?? {});
  return r.success ? r.data : DEFAULT_CRITERIA;
}

/** Does the list harvest anything at all? A list with neither cannot find candidates. */
export function hasSource(c: Pick<FinderCriteria, "segmentKeys" | "keywords">): boolean {
  return c.segmentKeys.length > 0 || c.keywords.length > 0;
}

// ---- hashing ---------------------------------------------------------------

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/**
 * FNV-1a over the canonical JSON. Not cryptographic and does not need to be:
 * it only answers "were these the same criteria", within one workspace.
 * Order-insensitive for every list field, so re-ordering counties is not a
 * new filter.
 */
export function criteriaHash(c: FinderCriteria): string {
  const canon = stable({
    ...c,
    segmentKeys: [...c.segmentKeys].sort(),
    keywords: c.keywords.map((k) => k.toLowerCase()).sort(),
    teaorInclude: [...c.teaorInclude].sort(),
    teaorExclude: [...c.teaorExclude].sort(),
    sizeBands: [...c.sizeBands].sort(),
    counties: c.counties.map(fold).sort(),
    cities: c.cities.map(fold).sort(),
    legalForms: c.legalForms.map((f) => f.toLowerCase()).sort(),
  });
  const s = JSON.stringify(canon);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ch, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// ---- the subject a filter reads -----------------------------------------------

/**
 * What the filter needs to know about one company. A datasheet produces it
 * on the server; a result row produces it in the browser. Money is a plain
 * number of forints here — exact up to 9 quadrillion, which no Hungarian
 * company's revenue approaches — so the same object crosses to the client.
 */
export interface FilterSubject {
  name: string;
  status: string | null;
  legalForm: string | null;
  principalCode: string | null;
  activityCodes: string[];
  employeeCount: number | null;
  netRevenue: number | null;
  county: string | null;
  city: string | null;
  foundedAt: string | null;
  hasEmail: boolean;
  hasPhone: boolean;
  hasWebsite: boolean;
  /** Harvested by one of the list's keywords (or, cached-only, the name contains one). */
  foundByKeyword: boolean;
}

export interface FilterSegment {
  key: string;
  teaorInclude: readonly string[];
  teaorExclude: readonly string[];
}

export type FinderReason =
  | "IN_CRM"
  | "SUPPRESSED"
  | "PREVIOUSLY_FILTERED"
  | "LEGAL_FORM"
  | "STATUS"
  | "BUSINESS_TYPE"
  | "SEGMENT"
  | "TEAOR"
  | "SIZE"
  | "REVENUE"
  | "REGION"
  | "FOUNDED"
  | "CONTACT";

export const REASON_LABEL: Record<FinderReason, string> = {
  IN_CRM: "already in the CRM",
  SUPPRESSED: "on the suppression list",
  PREVIOUSLY_FILTERED: "filtered out before for the same criteria",
  LEGAL_FORM: "legal form",
  STATUS: "registry status",
  BUSINESS_TYPE: "business type",
  SEGMENT: "segment / keyword",
  TEAOR: "activity code (TEÁOR)",
  SIZE: "size band",
  REVENUE: "revenue",
  REGION: "county / city",
  FOUNDED: "founding date",
  CONTACT: "contact requirement",
};

export type FinderVerdict =
  | { ok: true; sizeBand: SizeBand | null; unknownSize: boolean }
  | { ok: false; reason: FinderReason; detail: string };

export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+megye$/, "")
    .trim();
}

/** A sole trader, by the legal form the provider maps ("Egyéni vállalkozás" → "e.v."). */
export function isIndividualEntrepreneur(legalForm: string | null): boolean {
  const f = (legalForm ?? "").toLowerCase();
  return f === "e.v." || f.includes("egyéni vállalkozás") || f.includes("egyéni vállalkozó");
}

function fmtFt(n: number): string {
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2).replace(/\.?0+$/, "")} Mrd Ft`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")} M Ft`;
  return `${Math.round(n).toLocaleString("hu-HU")} Ft`;
}

/** "2019" ≤ "2019-09-16" ≤ "2019-12": compares on the precision the bound was given in. */
function dateWithin(value: string, from: string | null, to: string | null): boolean {
  if (from && value.slice(0, from.length) < from) return false;
  if (to && value.slice(0, to.length) > to) return false;
  return true;
}

/**
 * Apply a list's criteria to one company. CRM and suppression are not here:
 * they need the workspace's records and are checked by the caller, before
 * any quota is spent. `skipContact` lets phase 2 tell a contact-only failure
 * apart, so the optional imprint step knows which companies it could rescue.
 *
 * Every refusal names the rule and the measured value.
 */
export function finderFilter(
  c: FinderCriteria,
  s: FilterSubject,
  segments: readonly FilterSegment[],
  opts: { skipContact?: boolean } = {},
): FinderVerdict {
  // 1. Alive (or whatever status the list asks for).
  if (c.status !== "any" && fold(s.status ?? "") !== fold(c.status)) {
    return { ok: false, reason: "STATUS", detail: `registry status "${s.status ?? "unknown"}", list wants "${c.status}"` };
  }

  // 2. Company vs sole trader.
  const individual = isIndividualEntrepreneur(s.legalForm);
  if (c.businessType === "company" && individual) {
    return { ok: false, reason: "BUSINESS_TYPE", detail: "an individual entrepreneur, and the list wants companies" };
  }
  if (c.businessType === "individualEntrepreneur" && !individual) {
    return { ok: false, reason: "BUSINESS_TYPE", detail: `legal form ${s.legalForm ?? "unknown"}, the list wants individual entrepreneurs` };
  }

  // 3. Legal form.
  if (c.legalForms.length > 0) {
    const form = (s.legalForm ?? "").toLowerCase();
    if (!c.legalForms.some((f) => f.toLowerCase() === form)) {
      return { ok: false, reason: "LEGAL_FORM", detail: `legal form ${s.legalForm ?? "unknown"}, list wants ${c.legalForms.join("/")}` };
    }
  }

  const codes = c.teaorAllActivities
    ? [...(s.principalCode ? [s.principalCode] : []), ...s.activityCodes.filter((x) => x !== s.principalCode)]
    : s.principalCode
      ? [s.principalCode]
      : [];

  // 4. Segment or keyword. A company found by one of the list's keywords
  //    qualifies by name; otherwise it must sit in one of the segments.
  if (c.segmentKeys.length > 0 && !(c.keywords.length > 0 && s.foundByKeyword)) {
    const all = [...(s.principalCode ? [s.principalCode] : []), ...s.activityCodes];
    const inSegment = c.segmentKeys.some((k) => {
      const seg = segments.find((x) => x.key === k);
      return seg ? teaorMatches(c.teaorAllActivities ? all : codes, seg) !== null : false;
    });
    if (!inSegment) {
      return {
        ok: false,
        reason: "SEGMENT",
        detail: `activity ${s.principalCode ?? "none"} is in none of ${c.segmentKeys.join(", ")}${c.keywords.length ? ", and no keyword found it" : ""}`,
      };
    }
  } else if (c.segmentKeys.length === 0 && c.keywords.length > 0 && !s.foundByKeyword) {
    return { ok: false, reason: "SEGMENT", detail: `the name matches none of the keywords ${c.keywords.join(", ")}` };
  }

  // 5. Explicit TEÁOR include / exclude.
  if (c.teaorExclude.length > 0) {
    const hit = codes.find((code) => c.teaorExclude.some((p) => normalizeTeaor(code).startsWith(p)));
    if (hit) return { ok: false, reason: "TEAOR", detail: `activity ${hit} is excluded` };
  }
  if (c.teaorInclude.length > 0) {
    const hit = codes.find((code) => c.teaorInclude.some((p) => normalizeTeaor(code).startsWith(p)));
    if (!hit) {
      return {
        ok: false,
        reason: "TEAOR",
        detail: `${c.teaorAllActivities ? "no activity" : `principal activity ${s.principalCode ?? "none"}`} in ${c.teaorInclude.join(", ")}`,
      };
    }
  }

  // 6. Size, through the motor's own resolver.
  const size = checkSize(
    { sizeBands: c.sizeBands, includeUnknownSize: c.includeUnknownSize },
    { employeeCount: s.employeeCount, netRevenue: s.netRevenue },
  );
  if (!size.ok) return { ok: false, reason: "SIZE", detail: size.reason.replace("profile", "list") };

  // 7. Revenue range — a missing revenue does not meet a revenue rule.
  if (c.revenueMin !== null || c.revenueMax !== null) {
    if (s.netRevenue === null) return { ok: false, reason: "REVENUE", detail: "no net revenue on the datasheet, and the list has a revenue rule" };
    if (c.revenueMin !== null && s.netRevenue < c.revenueMin) {
      return { ok: false, reason: "REVENUE", detail: `net revenue ${fmtFt(s.netRevenue)} < minimum ${fmtFt(c.revenueMin)}` };
    }
    if (c.revenueMax !== null && s.netRevenue > c.revenueMax) {
      return { ok: false, reason: "REVENUE", detail: `net revenue ${fmtFt(s.netRevenue)} > maximum ${fmtFt(c.revenueMax)}` };
    }
  }

  // 8. Region: in any listed county OR any listed city.
  if (c.counties.length > 0 || c.cities.length > 0) {
    const county = fold(s.county ?? "");
    const city = fold(s.city ?? "");
    const ok = c.counties.some((x) => fold(x) === county) || c.cities.some((x) => fold(x) === city);
    if (!ok) {
      return {
        ok: false,
        reason: "REGION",
        detail: `seat ${s.city ?? "?"} (${s.county ?? "?"}) is outside ${[...c.counties, ...c.cities].join(", ")}`,
      };
    }
  }

  // 9. Founded.
  if (c.foundedFrom || c.foundedTo) {
    if (!s.foundedAt) return { ok: false, reason: "FOUNDED", detail: "no founding date on the datasheet" };
    if (!dateWithin(s.foundedAt, c.foundedFrom, c.foundedTo)) {
      return { ok: false, reason: "FOUNDED", detail: `founded ${s.foundedAt}, list wants ${c.foundedFrom ?? "…"} – ${c.foundedTo ?? "…"}` };
    }
  }

  // 10. Contacts.
  if (!opts.skipContact) {
    const v = contactVerdict(c.contactRequirement, s);
    if (v) return { ok: false, reason: "CONTACT", detail: v };
  }

  return { ok: true, sizeBand: size.band, unknownSize: size.unknownSize };
}

/** Null when the requirement is met; otherwise what is missing. */
export function contactVerdict(req: ContactRequirement, s: Pick<FilterSubject, "hasEmail" | "hasPhone" | "hasWebsite">): string | null {
  switch (req) {
    case "none":
      return null;
    case "any":
      return s.hasEmail || s.hasPhone || s.hasWebsite ? null : "no email, phone or website, and the list requires one";
    case "email":
      return s.hasEmail ? null : "no email address, and the list requires one";
    case "phone":
      return s.hasPhone ? null : "no phone number, and the list requires one";
    case "website":
      return s.hasWebsite ? null : "no website, and the list requires one";
  }
}

/** Do any of the keywords occur in a company name (accent- and case-insensitive)? */
export function nameHasKeyword(name: string, keywords: readonly string[]): boolean {
  const hay = fold(name);
  return keywords.some((k) => hay.includes(fold(k)));
}

/** A one-line, human summary of a list — for the audit log and the list index. */
export function describeCriteria(c: FinderCriteria, segmentNames: Record<string, string> = {}): string {
  const parts: string[] = [];
  if (c.segmentKeys.length) parts.push(`segments ${c.segmentKeys.map((k) => segmentNames[k] ?? k).join(", ")}`);
  if (c.keywords.length) parts.push(`keywords ${c.keywords.join(", ")}`);
  if (c.teaorInclude.length) parts.push(`TEÁOR ${c.teaorInclude.join(", ")}${c.teaorAllActivities ? " (any activity)" : ""}`);
  if (c.teaorExclude.length) parts.push(`not TEÁOR ${c.teaorExclude.join(", ")}`);
  if (c.sizeBands.length) parts.push(`${c.sizeBands.map((b) => b.toLowerCase()).join("/")}${c.includeUnknownSize ? " (+unknown size)" : ""}`);
  if (c.revenueMin !== null || c.revenueMax !== null) parts.push(`revenue ${c.revenueMin !== null ? fmtFt(c.revenueMin) : "0"}–${c.revenueMax !== null ? fmtFt(c.revenueMax) : "∞"}`);
  if (c.counties.length || c.cities.length) parts.push(`in ${[...c.counties, ...c.cities].join(", ")}`);
  if (c.legalForms.length) parts.push(c.legalForms.join("/"));
  if (c.foundedFrom || c.foundedTo) parts.push(`founded ${c.foundedFrom ?? "…"}–${c.foundedTo ?? "…"}`);
  if (c.status !== "Aktív") parts.push(`status ${c.status}`);
  if (c.businessType !== "company") parts.push(c.businessType === "both" ? "companies + sole traders" : "sole traders");
  if (c.contactRequirement !== "none") parts.push(`must have ${c.contactRequirement === "any" ? "a contact" : c.contactRequirement}`);
  if (!c.excludeInCrm) parts.push("CRM included");
  if (!c.excludeSuppressed) parts.push("suppressed included");
  return parts.join(" · ") || "no criteria";
}
