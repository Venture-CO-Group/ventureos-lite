import { describe, it, expect } from "vitest";
import {
  DEFAULT_CRITERIA,
  criteriaHash,
  describeCriteria,
  finderCriteriaSchema,
  finderFilter,
  nameHasKeyword,
  type FilterSubject,
  type FinderCriteria,
} from "@/modules/finder/criteria";

/** Company Finder item 1: the list definition and the local filter that applies it. */

const crit = (over: Partial<FinderCriteria> = {}): FinderCriteria => finderCriteriaSchema.parse({ ...over });

const subject = (over: Partial<FilterSubject> = {}): FilterSubject => ({
  name: "Minta Szoftver Kft.",
  status: "Aktív",
  legalForm: "Kft.",
  principalCode: "6201",
  activityCodes: ["6201", "7022"],
  employeeCount: 4,
  netRevenue: 42_000_000,
  county: "Budapest",
  city: "Budapest",
  foundedAt: "2019-09-16",
  hasEmail: true,
  hasPhone: false,
  hasWebsite: false,
  foundByKeyword: false,
  ...over,
});

const SEGMENTS = [
  { key: "it", teaorInclude: ["62", "631"], teaorExclude: ["6209"] },
  { key: "dental", teaorInclude: ["8623"], teaorExclude: [] },
];

describe("criteria schema", () => {
  it("defaults to active companies, CRM and suppression excluded", () => {
    expect(DEFAULT_CRITERIA).toMatchObject({
      status: "Aktív",
      businessType: "company",
      excludeInCrm: true,
      excludeSuppressed: true,
      contactRequirement: "none",
      includeUnknownSize: false,
    });
  });

  it("refuses keywords the registry would refuse (under four characters)", () => {
    const r = finderCriteriaSchema.safeParse({ keywords: ["it"] });
    expect(r.success).toBe(false);
  });

  it("normalises TEÁOR codes and dedupes lists", () => {
    const c = crit({ teaorInclude: ["62.01", "6201", "62"], counties: ["Pest", "Pest"] });
    expect(c.teaorInclude).toEqual(["6201", "62"]);
    expect(c.counties).toEqual(["Pest"]);
  });

  it("refuses an inverted revenue or founding range", () => {
    expect(finderCriteriaSchema.safeParse({ revenueMin: 10, revenueMax: 5 }).success).toBe(false);
    expect(finderCriteriaSchema.safeParse({ foundedFrom: "2020", foundedTo: "2019" }).success).toBe(false);
  });

  it("hashes order-insensitively, and differently for different criteria", () => {
    const a = crit({ counties: ["Pest", "Budapest"], keywords: ["Szoftver", "informatika"] });
    const b = crit({ counties: ["Budapest", "Pest"], keywords: ["informatika", "szoftver"] });
    expect(criteriaHash(a)).toBe(criteriaHash(b));
    expect(criteriaHash(a)).not.toBe(criteriaHash(crit({ counties: ["Pest"] })));
  });

  it("describes a list in one line", () => {
    expect(describeCriteria(crit({ sizeBands: ["MICRO"], counties: ["Budapest"], contactRequirement: "email" }))).toBe(
      "micro · in Budapest · must have email",
    );
  });
});

describe("the local filter", () => {
  it("passes a micro Budapest company with an email", () => {
    const v = finderFilter(crit({ sizeBands: ["MICRO"], counties: ["Budapest"], contactRequirement: "email" }), subject(), SEGMENTS);
    expect(v).toEqual({ ok: true, sizeBand: "MICRO", unknownSize: false });
  });

  it("names the rule and the measured value on refusal", () => {
    const v = finderFilter(crit({ sizeBands: ["MEDIUM"] }), subject(), SEGMENTS);
    expect(v).toMatchObject({ ok: false, reason: "SIZE" });
    expect(!v.ok && v.detail).toContain("employeeCount 4 → MICRO");
  });

  it("matches TEÁOR on the principal activity, or on every activity when asked", () => {
    expect(finderFilter(crit({ teaorInclude: ["7022"] }), subject(), SEGMENTS)).toMatchObject({ ok: false, reason: "TEAOR" });
    expect(finderFilter(crit({ teaorInclude: ["7022"], teaorAllActivities: true }), subject(), SEGMENTS).ok).toBe(true);
    expect(finderFilter(crit({ teaorExclude: ["62"] }), subject(), SEGMENTS)).toMatchObject({ ok: false, reason: "TEAOR" });
  });

  it("requires a segment's activity, unless a keyword found the company", () => {
    expect(finderFilter(crit({ segmentKeys: ["dental"] }), subject(), SEGMENTS)).toMatchObject({ ok: false, reason: "SEGMENT" });
    expect(finderFilter(crit({ segmentKeys: ["it"] }), subject(), SEGMENTS).ok).toBe(true);
    const both = crit({ segmentKeys: ["dental"], keywords: ["szoftver"] });
    expect(finderFilter(both, subject({ foundByKeyword: true }), SEGMENTS).ok).toBe(true);
    expect(finderFilter(crit({ keywords: ["szoftver"] }), subject({ foundByKeyword: false }), SEGMENTS)).toMatchObject({ reason: "SEGMENT" });
  });

  it("falls back to revenue for size, and honours include-unknown", () => {
    const noHead = subject({ employeeCount: null, netRevenue: 2_000_000_000 });
    expect(finderFilter(crit({ sizeBands: ["SMALL"] }), noHead, SEGMENTS).ok).toBe(true);
    const unknown = subject({ employeeCount: null, netRevenue: null });
    expect(finderFilter(crit({ sizeBands: ["MICRO"] }), unknown, SEGMENTS)).toMatchObject({ reason: "SIZE" });
    expect(finderFilter(crit({ sizeBands: ["MICRO"], includeUnknownSize: true }), unknown, SEGMENTS)).toEqual({
      ok: true,
      sizeBand: null,
      unknownSize: true,
    });
  });

  it("applies revenue, region, legal form, founding date and status", () => {
    expect(finderFilter(crit({ revenueMin: 50_000_000 }), subject(), SEGMENTS)).toMatchObject({ reason: "REVENUE" });
    expect(finderFilter(crit({ revenueMax: 50_000_000 }), subject(), SEGMENTS).ok).toBe(true);
    expect(finderFilter(crit({ counties: ["Pest"], cities: ["Budapest"] }), subject(), SEGMENTS).ok).toBe(true);
    expect(finderFilter(crit({ counties: ["Pest megye"] }), subject({ county: "Pest" }), SEGMENTS).ok).toBe(true);
    expect(finderFilter(crit({ legalForms: ["Zrt."] }), subject(), SEGMENTS)).toMatchObject({ reason: "LEGAL_FORM" });
    expect(finderFilter(crit({ foundedFrom: "2019-10" }), subject(), SEGMENTS)).toMatchObject({ reason: "FOUNDED" });
    expect(finderFilter(crit({ foundedFrom: "2019", foundedTo: "2019" }), subject(), SEGMENTS).ok).toBe(true);
    expect(finderFilter(crit(), subject({ status: "Szüneteltetett" }), SEGMENTS)).toMatchObject({ reason: "STATUS" });
    expect(finderFilter(crit({ status: "any" }), subject({ status: "Szüneteltetett" }), SEGMENTS).ok).toBe(true);
  });

  it("keeps sole traders out by default and in on request", () => {
    const ev = subject({ legalForm: "e.v." });
    expect(finderFilter(crit(), ev, SEGMENTS)).toMatchObject({ reason: "BUSINESS_TYPE" });
    expect(finderFilter(crit({ businessType: "both" }), ev, SEGMENTS).ok).toBe(true);
    expect(finderFilter(crit({ businessType: "individualEntrepreneur" }), subject(), SEGMENTS)).toMatchObject({ reason: "BUSINESS_TYPE" });
  });

  it("checks contacts last, and can skip them to tell a contact-only failure apart", () => {
    const c = crit({ contactRequirement: "phone" });
    expect(finderFilter(c, subject(), SEGMENTS)).toMatchObject({ reason: "CONTACT" });
    expect(finderFilter(c, subject(), SEGMENTS, { skipContact: true }).ok).toBe(true);
    expect(finderFilter(crit({ contactRequirement: "any" }), subject({ hasEmail: false }), SEGMENTS)).toMatchObject({ reason: "CONTACT" });
  });

  it("matches keywords accent- and case-insensitively", () => {
    expect(nameHasKeyword("Árvíztűrő, Tükörfúró és Társa Kft.", ["tukorfuro"])).toBe(true);
    expect(nameHasKeyword("Minta Kft.", ["szoftver"])).toBe(false);
  });
});
