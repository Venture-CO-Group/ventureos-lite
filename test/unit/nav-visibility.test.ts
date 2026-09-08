import { describe, it, expect } from "vitest";
import {
  FEATURE_BY_HREF,
  HIDEABLE_FEATURES,
  NAV_FEATURES,
  hiddenFeatures,
  isHrefHidden,
  sanitizeHidden,
} from "../../src/modules/workspaces/nav-visibility";

/**
 * "az admin settingsben tudjak funkciókat (menüpontokat) elrejteni".
 *
 * Decluttering, not permission — and the tests say so, because the failure mode
 * of blurring that line is severe: an Owner who reads "hidden" as "denied"
 * would hand somebody a role believing a capability had been removed.
 */
describe("the hidden set", () => {
  it("is empty when nothing has been configured", () => {
    expect(hiddenFeatures(null)).toEqual(new Set());
    expect(hiddenFeatures(undefined)).toEqual(new Set());
    expect(hiddenFeatures({})).toEqual(new Set());
    expect(hiddenFeatures({ retention: { days: 30 } })).toEqual(new Set());
  });

  it("reads the keys a workspace switched off", () => {
    expect(hiddenFeatures({ hiddenNav: ["campaigns", "content"] })).toEqual(
      new Set(["campaigns", "content"]),
    );
  });

  it("survives a column holding something other than a list", () => {
    // featureFlags is a shared bag written by several features; a bad shape
    // must degrade to "hide nothing" rather than throw on every page render.
    expect(hiddenFeatures({ hiddenNav: "campaigns" })).toEqual(new Set());
    expect(hiddenFeatures({ hiddenNav: 42 })).toEqual(new Set());
    expect(hiddenFeatures([1, 2, 3])).toEqual(new Set());
    expect(hiddenFeatures({ hiddenNav: [null, 7, "campaigns"] })).toEqual(new Set(["campaigns"]));
  });

  it("drops keys for features that no longer exist", () => {
    // Otherwise a key left over from a removed feature sits in the column for
    // ever, and nothing would ever clear it.
    expect(hiddenFeatures({ hiddenNav: ["campaigns", "some-old-screen"] })).toEqual(
      new Set(["campaigns"]),
    );
  });

  it("refuses to hide an essential screen, however it got into the column", () => {
    // Hand-edited JSON, an older build, a bug. None of them may leave a
    // workspace with no way back to its own leads.
    const hidden = hiddenFeatures({ hiddenNav: ["leads", "pipeline", "settings", "dashboard"] });
    expect(hidden).toEqual(new Set());
  });
});

describe("sanitizing what the settings screen submits", () => {
  it("keeps only real, hideable keys and de-duplicates them", () => {
    expect(sanitizeHidden(["campaigns", "campaigns", "leads", "nonsense"])).toEqual(["campaigns"]);
  });

  it("treats anything that is not a list as nothing hidden", () => {
    expect(sanitizeHidden(null)).toEqual([]);
    expect(sanitizeHidden("campaigns")).toEqual([]);
  });

  it("round-trips: what it stores is what the resolver reads back", () => {
    const submitted = ["campaigns", "content", "referrers"];
    expect(hiddenFeatures({ hiddenNav: sanitizeHidden(submitted) })).toEqual(new Set(submitted));
  });
});

describe("matching a route to its feature", () => {
  it("hides the row for a switched-off route", () => {
    const hidden = new Set(["campaigns"]);
    expect(isHrefHidden("/campaigns", hidden)).toBe(true);
    expect(isHrefHidden("/leads", hidden)).toBe(false);
  });

  it("leaves routes it does not know about alone", () => {
    // The palette carries actions that are not nav items ("New lead"), and a
    // route with no feature key must never be filtered out by accident.
    expect(isHrefHidden("/settings/admin", new Set(["campaigns"]))).toBe(false);
    expect(isHrefHidden(undefined, new Set(["campaigns"]))).toBe(false);
  });
});

describe("the registry itself", () => {
  it("has a unique key and a unique route for every entry", () => {
    const keys = NAV_FEATURES.map((f) => f.key);
    const hrefs = NAV_FEATURES.map((f) => f.href);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(Object.keys(FEATURE_BY_HREF).length).toBe(NAV_FEATURES.length);
  });

  it("explains what each switchable item costs", () => {
    // The settings screen renders these; a checkbox with no explanation is a
    // checkbox people leave alone.
    for (const f of HIDEABLE_FEATURES) expect(f.hint, f.key).toBeTruthy();
  });

  it("keeps the four screens nobody may be locked out of", () => {
    const essential = NAV_FEATURES.filter((f) => f.essential).map((f) => f.key);
    expect(essential).toContain("leads");
    expect(essential).toContain("settings");
    expect(essential).toContain("dashboard");
    expect(HIDEABLE_FEATURES.some((f) => essential.includes(f.key))).toBe(false);
  });
});
