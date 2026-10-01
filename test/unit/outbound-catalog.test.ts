import { describe, it, expect } from "vitest";
import { resolveSizeBand, checkSize } from "@/modules/outbound/size-band";
import { nameableReferences, leakedPatternNames, type ReferenceRow } from "@/modules/outbound/references";
import { DEFAULT_SEGMENTS, teaorMatches } from "@/modules/outbound/segments-seed";
import { suggestProfile } from "@/modules/outbound/profile-seed";
import { profileInputSchema, productInputSchema, slugify, productDailyQuota } from "@/modules/outbound/catalog";
import type { CompanyDatasheet } from "@/modules/registry/datasheet";
import { serializeDatasheet, reviveDatasheet } from "@/modules/registry/datasheet";

/**
 * Playbook-v6 F1: the product/profile model's pure parts.
 */

describe("size-band resolver (spec §4.43.2b)", () => {
  const cases: Array<[string, { employeeCount?: number | null; netRevenue?: bigint | null }, string | null, string]> = [
    ["headcount 0 is a real answer", { employeeCount: 0 }, "MICRO", "employees"],
    ["9 is micro", { employeeCount: 9 }, "MICRO", "employees"],
    ["10 is small", { employeeCount: 10 }, "SMALL", "employees"],
    ["49 is small", { employeeCount: 49 }, "SMALL", "employees"],
    ["50 is medium", { employeeCount: 50 }, "MEDIUM", "employees"],
    ["249 is medium", { employeeCount: 249 }, "MEDIUM", "employees"],
    ["250 is large", { employeeCount: 250 }, "LARGE", "employees"],
    ["headcount beats revenue", { employeeCount: 5, netRevenue: 30_000_000_000n }, "MICRO", "employees"],
    ["revenue decides when headcount is missing", { employeeCount: null, netRevenue: 800_000_000n }, "MICRO", "revenue"],
    ["1 Mrd is not micro", { netRevenue: 1_000_000_000n }, "SMALL", "revenue"],
    ["4.9 Mrd is small", { netRevenue: 4_900_000_000n }, "SMALL", "revenue"],
    ["24 Mrd is medium", { netRevenue: 24_000_000_000n }, "MEDIUM", "revenue"],
    ["25 Mrd is large", { netRevenue: 25_000_000_000n }, "LARGE", "revenue"],
    ["nothing is unknown", {}, null, "unknown"],
    ["both null is unknown", { employeeCount: null, netRevenue: null }, null, "unknown"],
  ];
  for (const [label, input, band, basis] of cases) {
    it(label, () => {
      expect(resolveSizeBand(input)).toEqual({ band, basis });
    });
  }

  it("excludes unknown size unless the profile lets it in, and flags it when it does", () => {
    const strict = checkSize({ sizeBands: ["SMALL"], includeUnknownSize: false }, {});
    expect(strict.ok).toBe(false);
    const lenient = checkSize({ sizeBands: ["SMALL"], includeUnknownSize: true }, {});
    expect(lenient).toMatchObject({ ok: true, unknownSize: true });
  });

  it("names the measured value when it refuses", () => {
    const v = checkSize({ sizeBands: ["MEDIUM", "LARGE"], includeUnknownSize: false }, { employeeCount: 6 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("employeeCount 6");
  });

  it("treats no size bands as any size", () => {
    expect(checkSize({ sizeBands: [], includeUnknownSize: false }, { employeeCount: 3000 }).ok).toBe(true);
  });
});

describe("nameable references (CLAUDE.md hard rule 13)", () => {
  const rows: ReferenceRow[] = [
    { companyName: "Dentalia Kft.", taxNumber: null, isClient: true, note: "site rebuilt 2025" },
    { companyName: "PwC Magyarország Kft.", taxNumber: null, isClient: false, note: null },
    { companyName: "KPMG Hungária Kft.", taxNumber: null, isClient: false, note: null },
  ];

  it("returns only true clients", () => {
    expect(nameableReferences(rows).map((r) => r.companyName)).toEqual(["Dentalia Kft."]);
  });

  it("catches a pattern reference's name in generated text", () => {
    expect(leakedPatternNames("Companies like PwC already did this.", rows)).toEqual(["PwC Magyarország Kft."]);
    expect(leakedPatternNames("Like Dentalia, you could…", rows)).toEqual([]);
  });
});

describe("seeded segment taxonomy (spec §4.43.2a)", () => {
  it("has the 19 segments, each with fragments and a hint", () => {
    expect(DEFAULT_SEGMENTS).toHaveLength(19);
    expect(new Set(DEFAULT_SEGMENTS.map((s) => s.key)).size).toBe(19);
    for (const s of DEFAULT_SEGMENTS) {
      expect(s.fragments.length, s.key).toBeGreaterThanOrEqual(6);
      expect(s.teaorInclude.length, s.key).toBeGreaterThan(0);
    }
  });

  it("marks the fantasy-named sectors weak and the finite ones as seed lists", () => {
    const hint = (k: string) => DEFAULT_SEGMENTS.find((s) => s.key === k)!.sourcingHint;
    expect(hint("it_software")).toBe("NAME_HARVEST_WEAK");
    expect(hint("consulting_accounting")).toBe("NAME_HARVEST_WEAK");
    expect(hint("manufacturing")).toBe("NAME_HARVEST_WEAK");
    expect(hint("banks_financial")).toBe("SEED_LIST");
    expect(DEFAULT_SEGMENTS.find((s) => s.key === "banks_financial")!.seedList.length).toBeGreaterThan(5);
  });

  it("matches TEÁOR by prefix, with dots ignored and exclusions winning", () => {
    const clinics = DEFAULT_SEGMENTS.find((s) => s.key === "private_clinics")!;
    expect(teaorMatches(["86.23"], clinics)).toBe("86.23");
    expect(teaorMatches(["4773"], clinics)).toBeNull();
    const wholesale = DEFAULT_SEGMENTS.find((s) => s.key === "wholesale")!;
    expect(teaorMatches(["4646"], wholesale)).toBeNull();
    expect(teaorMatches(["4690"], wholesale)).toBe("4690");
  });
});

function sheet(over: Partial<CompanyDatasheet>): CompanyDatasheet {
  return {
    taxNumber: "12345678-2-42",
    legalName: "X Kft.",
    shortName: null,
    legalForm: "Kft.",
    registryNumber: null,
    statisticalCode: null,
    status: "Aktív",
    foundedAt: null,
    seat: { county: "Budapest", city: "Budapest", zip: null, oneLine: null },
    principalActivity: null,
    activities: [],
    financialYear: null,
    netRevenue: null,
    equity: null,
    operatingResult: null,
    preTaxResult: null,
    afterTaxResult: null,
    balanceSheetTotal: null,
    employeeCount: null,
    owners: [],
    managers: [],
    website: null,
    phone: null,
    email: null,
    ...over,
  };
}

describe("reference-based profile seeding (F1/4)", () => {
  it("derives segments, size and region, each with the references behind it", () => {
    const s = suggestProfile(
      [
        { name: "PwC", sheet: sheet({ principalActivity: { code: "6920", label: null }, employeeCount: 900, legalForm: "Kft." }) },
        { name: "KPMG", sheet: sheet({ principalActivity: { code: "6920", label: null }, employeeCount: 700, legalForm: "Kft." }) },
        { name: "Ghost", sheet: null },
      ],
      DEFAULT_SEGMENTS,
    );
    expect(s.segments[0]).toEqual({ value: "consulting_accounting", from: ["PwC", "KPMG"] });
    expect(s.sizeBands).toEqual([{ value: "LARGE", from: ["PwC", "KPMG"] }]);
    expect(s.counties[0]!.value).toBe("Budapest");
    expect(s.missing).toEqual(["Ghost"]);
  });

  it("reports an activity no segment covers instead of dropping it", () => {
    const s = suggestProfile([{ name: "Odd", sheet: sheet({ principalActivity: { code: "9999", label: null } }) }], DEFAULT_SEGMENTS);
    expect(s.segments).toEqual([]);
    expect(s.unmatchedActivities).toEqual([{ value: "9999", from: ["Odd"] }]);
  });
});

describe("product and profile inputs", () => {
  const product = {
    name: "Weboldal-fejlesztés",
    category: "OWN_SERVICE",
    partner: null,
    problemSolved: "Slow, outdated sites lose bookings.",
    valueProps: [{ claim: "Faster pages", evidence: "PSI 28 → 94 for Dentalia" }],
    proofPoints: [],
    priceBand: "1–3 M Ft",
    assets: [],
    status: "ACTIVE",
    language: "HU",
    priority: 10,
    references: [{ companyName: "Dentalia Kft.", taxNumber: null, isClient: true, note: null }],
  };

  it("accepts a well-formed product and slugs a Hungarian name", () => {
    expect(productInputSchema.safeParse(product).success).toBe(true);
    expect(slugify("Weboldal-fejlesztés")).toBe("weboldal-fejlesztes");
  });

  it("refuses a value prop with no evidence", () => {
    const r = productInputSchema.safeParse({ ...product, valueProps: [{ claim: "Fast", evidence: "" }] });
    expect(r.success).toBe(false);
  });

  const profile = {
    productId: "p1",
    name: "Dentists, small",
    segmentKeys: ["private_clinics"],
    sizeBands: ["MICRO", "SMALL"],
    includeUnknownSize: false,
    revenueMin: null,
    revenueMax: null,
    counties: [],
    cities: [],
    legalForms: [],
    foundedAfter: null,
    foundedBefore: null,
    statusRequired: "Aktív",
    requiresWebsite: false,
    auditScoreMin: 60,
    auditScoreMax: null,
    requiredSignals: [],
    contactRequirement: "GENERIC_OK",
    excludeExistingClients: true,
    mode: "VOLUME",
    dailyQuota: 12,
    weight: 1,
    active: true,
  };

  it("accepts a profile and refuses one with no targeting layer at all", () => {
    expect(profileInputSchema.safeParse(profile).success).toBe(true);
    expect(profileInputSchema.safeParse({ ...profile, segmentKeys: [], sizeBands: [] }).success).toBe(false);
  });

  it("refuses an inverted revenue range", () => {
    expect(profileInputSchema.safeParse({ ...profile, revenueMin: 500, revenueMax: 100 }).success).toBe(false);
  });

  it("gives each profile its own quota and sums only the active ones", () => {
    expect(productDailyQuota([{ active: true, dailyQuota: 8 }, { active: true, dailyQuota: 4 }, { active: false, dailyQuota: 9 }])).toBe(12);
  });
});

describe("datasheet storage", () => {
  it("round-trips bigint money through JSON", () => {
    const s = sheet({ netRevenue: 25_000_000_001n, employeeCount: 12 });
    const back = reviveDatasheet(serializeDatasheet(s))!;
    expect(back.netRevenue).toBe(25_000_000_001n);
    expect(back.employeeCount).toBe(12);
  });
});
