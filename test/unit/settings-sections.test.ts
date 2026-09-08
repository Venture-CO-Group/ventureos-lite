import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN_SECTIONS,
  PERSONAL_SECTIONS,
  activeSection,
  sectionsFor,
} from "../../src/modules/settings/sections";

const ROOT = join(__dirname, "../..");

/**
 * The settings menu, checked against the routes it points at (P8/3).
 *
 * Both settings pages had grown into one scroll — twenty panels in a column on
 * the admin page — and finding any one of them meant knowing roughly how far
 * down it lived. Splitting them introduces the failure mode every split menu
 * has: an entry pointing at a route nobody built, or a route nobody can reach.
 * This file is what stops both.
 */
function pageFileFor(href: string): string {
  return join(ROOT, "src/app", href === "/" ? "" : href, "page.tsx");
}

describe("every menu entry has a page", () => {
  for (const s of [...PERSONAL_SECTIONS, ...ADMIN_SECTIONS]) {
    it(`${s.href} exists`, () => {
      expect(existsSync(pageFileFor(s.href)), `no page.tsx for ${s.href}`).toBe(true);
    });
  }
});

describe("every settings page is in the menu", () => {
  /**
   * The other direction, which is the one that actually goes wrong.
   *
   * A page added under /settings with no menu entry is a page reachable only
   * by typing its URL — which is how a feature gets built, shipped and then
   * reported as missing.
   */
  const known = new Set([...PERSONAL_SECTIONS, ...ADMIN_SECTIONS].map((s) => s.href));

  it("has no orphan routes", () => {
    // Every page.tsx under src/app/settings, as an href.
    const walk = (dir: string, prefix: string): string[] => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full, `${prefix}/${entry}`));
        else if (entry === "page.tsx") out.push(prefix);
      }
      return out;
    };
    const routes = walk(join(ROOT, "src/app/settings"), "/settings");
    const orphans = routes.filter((r) => !known.has(r));
    expect(orphans).toEqual([]);
  });
});

describe("every admin page runs the gate", () => {
  /**
   * The gate is a named helper called by each page rather than a layout, so
   * that it is visible where it matters. The cost of that choice is that
   * somebody can forget it — and this is the test that makes the choice safe.
   */
  const adminPages = ADMIN_SECTIONS.filter((s) => s.href.startsWith("/settings/admin"));

  for (const s of adminPages) {
    it(`${s.href} calls requireSuperAdminPage`, () => {
      const src = readFileSync(pageFileFor(s.href), "utf8");
      expect(src, `${s.href} is not gated`).toContain("requireSuperAdminPage()");
    });
  }

  it("checks more than one page, so a shrinking list cannot pass vacuously", () => {
    expect(adminPages.length).toBeGreaterThanOrEqual(6);
  });
});

describe("the menu itself", () => {
  it("has unique slugs and hrefs per group", () => {
    for (const group of ["personal", "admin"] as const) {
      const sections = sectionsFor(group);
      expect(new Set(sections.map((s) => s.slug)).size).toBe(sections.length);
      expect(new Set(sections.map((s) => s.href)).size).toBe(sections.length);
    }
  });

  it("describes every entry", () => {
    // The hint is the difference between a menu and a list of words.
    for (const s of [...PERSONAL_SECTIONS, ...ADMIN_SECTIONS]) {
      expect(s.label.length, s.href).toBeGreaterThan(3);
      expect(s.hint.length, s.href).toBeGreaterThan(15);
    }
  });

  it("opens each group on an index whose slug is empty", () => {
    expect(PERSONAL_SECTIONS[0]!.slug).toBe("");
    expect(ADMIN_SECTIONS[0]!.slug).toBe("");
  });
});

describe("which entry is highlighted", () => {
  it("picks the longest match, not the first", () => {
    // `/settings` and `/settings/admin` are both index pages, so a naive
    // prefix match would highlight the index on every sub-page.
    expect(activeSection("admin", "/settings/admin")?.slug).toBe("");
    expect(activeSection("admin", "/settings/admin/members")?.slug).toBe("members");
    expect(activeSection("personal", "/settings")?.slug).toBe("");
    expect(activeSection("personal", "/settings/security")?.slug).toBe("security");
  });

  it("matches a sub-route of a section", () => {
    // The member detail drawer will live under the members route.
    expect(activeSection("admin", "/settings/admin/members/abc123")?.slug).toBe("members");
  });

  it("does not match a path that merely starts with the same letters", () => {
    expect(activeSection("personal", "/settings-other")).toBeNull();
    expect(activeSection("personal", "/settings/securityx")?.slug).not.toBe("security");
  });

  it("returns null for a path in the other group", () => {
    expect(activeSection("personal", "/leads")).toBeNull();
  });

  it("puts Workspaces in the admin menu even though it is not under /admin", () => {
    // It is Owner-gated rather than super-admin gated — an Owner must be able
    // to reach their own workspaces — but it belongs in the same menu.
    expect(activeSection("admin", "/settings/workspaces")?.slug).toBe("workspaces");
  });
});
