import { describe, it, expect } from "vitest";
import { localFilter, auditFilter, type FilterProfile } from "@/modules/outbound/filter";
import { resolveContact, addressMatchesName, isRoleAddress, extractRepresentedBy } from "@/modules/outbound/contact";
import { buildFacts, hasHook } from "@/modules/outbound/facts";
import { dedupeKeyFor, legalFormFromName, scorePoolRow, fragmentsInName } from "@/modules/outbound/pool";
import { ALLOWED, canTransition } from "@/modules/outbound/state";
import { poolRowsFromCsv } from "@/modules/outbound/sources";
import { DEFAULT_SEGMENTS } from "@/modules/outbound/segments-seed";
import { isRecipientSuppressed, isCompanySuppressed } from "@/modules/mail/suppression";
import type { CompanyDatasheet } from "@/modules/registry/datasheet";
import type { VerifyResult } from "@/modules/verification/types";

/** Playbook-v6 F3: the pure parts of the sourcing pipeline. */

const base: FilterProfile = {
  segmentKeys: ["private_clinics"],
  sizeBands: ["SMALL", "MEDIUM"],
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
  auditScoreMin: null,
  auditScoreMax: null,
  requiredSignals: [],
};

function sheet(over: Partial<CompanyDatasheet> = {}): CompanyDatasheet {
  return {
    taxNumber: "12345678-2-42",
    legalName: "Minta Fogászati Kft.",
    shortName: "Minta Fogászati Kft.",
    legalForm: "Kft.",
    registryNumber: null,
    statisticalCode: null,
    status: "Aktív",
    foundedAt: "2010-01-01",
    seat: { county: "Pest", city: "Budaörs", zip: null, oneLine: null },
    principalActivity: { code: "8623", label: "Fogorvosi járóbeteg-ellátás" },
    activities: [],
    financialYear: 2025,
    netRevenue: 42_000_000n,
    equity: null,
    operatingResult: null,
    preTaxResult: null,
    afterTaxResult: null,
    balanceSheetTotal: null,
    employeeCount: 20,
    owners: [],
    managers: [],
    website: null,
    phone: null,
    email: null,
    ...over,
  };
}

describe("local ICP filter — every refusal names the measured value", () => {
  it("passes a matching company and says which segment matched", () => {
    expect(localFilter(base, sheet(), DEFAULT_SEGMENTS)).toMatchObject({ ok: true, matchedSegment: "private_clinics", sizeBand: "SMALL" });
  });
  it("refuses a dead company with its status", () => {
    const v = localFilter(base, sheet({ status: "Eljárás alatt" }), DEFAULT_SEGMENTS);
    expect(v).toMatchObject({ ok: false, reason: "STATUS" });
    if (!v.ok) expect(v.detail).toContain("Eljárás alatt");
  });
  it("refuses the wrong activity with the code it found", () => {
    const v = localFilter(base, sheet({ principalActivity: { code: "4520", label: "Gépjárműjavítás" } }), DEFAULT_SEGMENTS);
    expect(v).toMatchObject({ ok: false, reason: "SEGMENT" });
    if (!v.ok) expect(v.detail).toContain("4520");
  });
  it("refuses revenue below the minimum with both numbers", () => {
    const v = localFilter({ ...base, revenueMin: 300_000_000 }, sheet(), DEFAULT_SEGMENTS);
    expect(v).toMatchObject({ ok: false, reason: "REVENUE" });
    if (!v.ok) expect(v.detail).toBe("net revenue 42 M Ft < profile minimum 300 M Ft");
  });
  it("refuses a seat outside the region, matching counties without accents", () => {
    expect(localFilter({ ...base, counties: ["Pest"] }, sheet(), DEFAULT_SEGMENTS).ok).toBe(true);
    const v = localFilter({ ...base, counties: ["Győr-Moson-Sopron"] }, sheet(), DEFAULT_SEGMENTS);
    expect(v).toMatchObject({ ok: false, reason: "REGION" });
  });
  it("refuses a founding year out of range, and a missing site when one is required", () => {
    expect(localFilter({ ...base, foundedAfter: 2015 }, sheet(), DEFAULT_SEGMENTS)).toMatchObject({ ok: false, reason: "FOUNDED" });
    expect(localFilter({ ...base, requiresWebsite: true }, sheet(), DEFAULT_SEGMENTS)).toMatchObject({ ok: false, reason: "NO_WEBSITE" });
    expect(localFilter({ ...base, requiresWebsite: true }, sheet(), DEFAULT_SEGMENTS, { website: "https://x.hu" }).ok).toBe(true);
  });
  it("applies the audit score range and the required signals after the audit", () => {
    expect(auditFilter({ ...base, auditScoreMin: 60 }, { score: 40, flags: [] })).toMatchObject({ ok: false, reason: "AUDIT_SCORE" });
    expect(auditFilter({ ...base, requiredSignals: ["no mobile"] }, { score: 70, flags: ["slow site"] })).toMatchObject({ ok: false, reason: "SIGNALS" });
    expect(auditFilter({ ...base, auditScoreMin: 60 }, null).ok).toBe(true);
  });
});

const ok = (address: string): VerifyResult => ({ status: "valid", reason: "ok", address, checkedAt: new Date() }) as VerifyResult;
const bad = (address: string): VerifyResult => ({ status: "invalid", reason: "no_mx", address, checkedAt: new Date() }) as VerifyResult;

describe("contact waterfall (spec §4.43.6)", () => {
  it("takes a registry address that belongs to a named manager", async () => {
    const c = await resolveContact({ registry: { email: "kovacs.anna@ceg.hu", phone: null, managers: ["Kovács Anna"] }, site: null, crm: [] }, async (e) => ok(e));
    expect(c).toMatchObject({ kind: "named", source: "registry", name: "Kovács Anna" });
  });
  it("pairs a known manager with a generic address", async () => {
    const c = await resolveContact({ registry: { email: "info@ceg.hu", phone: null, managers: ["Kovács Anna"] }, site: null, crm: [] }, async (e) => ok(e));
    expect(c).toMatchObject({ kind: "named_generic", email: "info@ceg.hu", name: "Kovács Anna", source: "registry+generic" });
  });
  it("falls to the next step when an address is invalid instead of failing", async () => {
    const c = await resolveContact(
      {
        registry: { email: "kovacs.anna@ceg.hu", phone: null, managers: ["Kovács Anna"] },
        site: { emails: ["iroda@ceg.hu"], phones: [], representedBy: [] },
        crm: [],
      },
      async (e) => (e.startsWith("kovacs") ? bad(e) : ok(e)),
    );
    expect(c).toMatchObject({ kind: "named_generic", email: "iroda@ceg.hu" });
    expect(c.trail.join(" ")).toContain("invalid");
  });
  it("uses the impresszum's represented-by name", async () => {
    const c = await resolveContact(
      { registry: null, site: { emails: ["nagy.peter@ceg.hu"], phones: [], representedBy: ["Dr. Nagy Péter"] }, crm: [] },
      async (e) => ok(e),
    );
    expect(c).toMatchObject({ kind: "named", source: "impresszum", name: "Dr. Nagy Péter" });
  });
  it("sends a generic-only company to the forwarding variant and a bare one to LinkedIn", async () => {
    expect(await resolveContact({ registry: { email: "info@ceg.hu", phone: null, managers: [] }, site: null, crm: [] }, async (e) => ok(e))).toMatchObject({ kind: "generic" });
    expect(await resolveContact({ registry: { email: null, phone: null, managers: ["Fí Ferenc"] }, site: null, crm: [] }, async (e) => ok(e))).toMatchObject({
      kind: "none",
      managerName: "Fí Ferenc",
    });
  });
  it("recognises role addresses and name-bearing ones", () => {
    expect(isRoleAddress("info@x.hu")).toBe(true);
    expect(isRoleAddress("iroda2@x.hu")).toBe(true);
    expect(isRoleAddress("anna@x.hu")).toBe(false);
    expect(addressMatchesName("akovacs@x.hu", "Kovács Anna")).toBe(true);
    expect(addressMatchesName("titkar@x.hu", "Kovács Anna")).toBe(false);
  });
  it("reads the represented-by line of an impresszum", () => {
    expect(extractRepresentedBy("Cégjegyzékszám: 01-09-1 Képviseli: Kovács Anna ügyvezető Adószám: 1")).toEqual(["Kovács Anna"]);
    expect(extractRepresentedBy("Ügyvezető: Dr. Nagy Péter")).toEqual(["Dr. Nagy Péter"]);
  });
});

describe("facts and the hook (CLAUDE.md hard rule 10)", () => {
  it("builds citable facts from the audit and the registry", () => {
    const facts = buildFacts({
      sheet: sheet(),
      audit: { score: 70, flags: ["slow site"], checks: [{ key: "viewport", label: "Mobile layout", pass: false }], url: "https://x" },
      noWebsite: false,
      now: new Date("2026-10-01T00:00:00Z"),
    });
    expect(facts.map((f) => f.id)).toEqual(
      expect.arrayContaining(["audit:viewport", "flag:slow_site", "registry:founded", "registry:employees", "registry:revenue"]),
    );
    expect(facts.find((f) => f.id === "registry:founded")!.value).toBe("2010 (16 years)");
    expect(hasHook(facts)).toBe(true);
  });
  it("does not count the seat or the activity alone as a hook", () => {
    const facts = buildFacts({
      sheet: sheet({ foundedAt: null, employeeCount: null, netRevenue: null }),
      audit: null,
      noWebsite: false,
    });
    expect(facts.map((f) => f.id).sort()).toEqual(["registry:activity", "registry:seat"]);
    expect(hasHook(facts)).toBe(false);
  });
  it("treats a missing website as a hook", () => {
    expect(hasHook(buildFacts({ sheet: null, audit: null, noWebsite: true }))).toBe(true);
  });
});

describe("pool", () => {
  it("dedupes on tax number, else domain + folded name", () => {
    expect(dedupeKeyFor({ taxNumber: "12345678-2-42", name: "X" })).toBe("tax:12345678242");
    expect(dedupeKeyFor({ website: "https://www.Mosoly.hu/x", name: "Mosoly Fogászat Kft." })).toBe(
      dedupeKeyFor({ website: "mosoly.hu", name: "MOSOLY FOGÁSZAT" }),
    );
  });
  it("reads a legal form off a name and finds fragments in it", () => {
    expect(legalFormFromName("Kis Gombóc Étterem Bt.")).toBe("Bt.");
    expect(fragmentsInName("Mosoly Fogászati Kft.", ["fogászati", "klinika"])).toEqual(["fogászati"]);
  });
  it("ranks a strong, plausible name above a false friend", () => {
    const ctx = {
      profileSegments: ["private_clinics"],
      profileFragments: ["fogászati", "klinika"],
      otherFragments: ["autószerviz"],
      sizeBands: ["MEDIUM" as const],
      fragmentApproval: new Map<string, number>(),
      now: new Date(),
    };
    const good = scorePoolRow({ name: "Mosoly Fogászati Klinika Kft.", source: "NAME_HARVEST", segmentKeys: [], hits: [], lastSeenAt: new Date() }, ctx);
    const bt = scorePoolRow({ name: "Mosoly Fogászati Bt.", source: "NAME_HARVEST", segmentKeys: [], hits: [], lastSeenAt: new Date() }, ctx);
    const wrong = scorePoolRow({ name: "Gyors Autószerviz Kft.", source: "NAME_HARVEST", segmentKeys: [], hits: [], lastSeenAt: new Date() }, ctx);
    expect(good).toBeGreaterThan(bt);
    expect(bt).toBeGreaterThan(wrong);
  });
  it("maps CSV rows and explains each skipped one", () => {
    const r = poolRowsFromCsv(
      [
        ["Alfa Kft.", "12345678-2-42", "alfa.hu"],
        ["", "", ""],
        ["Béta Kft.", "123", ""],
      ],
      { name: 0, taxNumber: 1, website: 2 },
      "private_clinics",
    );
    expect(r.rows).toHaveLength(1);
    expect(r.skipped.map((s) => s.reason)).toEqual(["no company name", '"123" is not an 11-digit tax number']);
  });
});

describe("state machine", () => {
  it("never leaves a terminal state", () => {
    for (const s of ["FILTERED_OUT", "REJECTED", "REPLIED", "LINKEDIN_QUEUE"] as const) expect(ALLOWED[s]).toEqual([]);
  });
  it("cannot be sent without being approved, or approved without being drafted", () => {
    expect(canTransition("CONTACT_RESOLVED", "SENT")).toBe(false);
    expect(canTransition("DRAFTED", "APPROVED")).toBe(false);
    expect(canTransition("PENDING_APPROVAL", "SENT")).toBe(false);
    expect(canTransition("APPROVED", "SENT")).toBe(true);
  });
});

describe("company-wide suppression (one list for every channel)", () => {
  it("suppresses everyone at a domain and the company by tax number", () => {
    expect(isRecipientSuppressed("anna@ceg.hu", ["@ceg.hu"])).toBe(true);
    expect(isRecipientSuppressed("anna@masik.hu", ["@ceg.hu"])).toBe(false);
    expect(isRecipientSuppressed("Anna@Ceg.hu", ["anna@ceg.hu"])).toBe(true);
    expect(isCompanySuppressed({ taxNumber: "12345678-2-42" }, ["tax:12345678242"])).toBe(true);
    expect(isCompanySuppressed({ domain: "www.ceg.hu" }, ["@ceg.hu"])).toBe(true);
  });
});
