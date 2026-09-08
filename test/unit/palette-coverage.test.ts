import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PALETTE_ACTIONS, GOTO_MAP } from "../../src/modules/search/palette";
import { TOUR_STEPS, CHECKLIST } from "../../src/modules/onboarding/tour";
import {
  ADMIN_SECTIONS,
  PERSONAL_SECTIONS,
} from "../../src/modules/settings/sections";

/**
 * The in-app help, checked against the app it describes.
 *
 * Help text is the first thing to go stale and the last thing anyone re-reads:
 * a shortcut overlay that lists a renamed page, a tour that sends someone to a
 * settings screen the feature moved off, a palette that cannot reach half the
 * nav. Each of those was true here until this file existed.
 */
const shell = readFileSync(join(__dirname, "..", "..", "src", "components", "app-shell.tsx"), "utf8");

/** Every href the sidebar offers, as the source of truth for "a page exists". */
const navHrefs = [...shell.matchAll(/href:\s*"(\/[a-z0-9/-]*)"/g)].map((m) => m[1]!);

describe("the command palette reaches the whole app", () => {
  it("finds the nav it means to check", () => {
    expect(navHrefs.length).toBeGreaterThanOrEqual(12);
    expect(navHrefs).toContain("/projects");
  });

  for (const href of [...new Set(navHrefs)]) {
    it(`can navigate to ${href}`, () => {
      const reachable = PALETTE_ACTIONS.some(
        (a) => a.href === href || a.href?.startsWith(`${href}?`),
      );
      expect(reachable, `${href} is in the nav but not in the palette`).toBe(true);
    });
  }
});

describe("the keyboard map", () => {
  it("binds no letter twice", () => {
    const hints = PALETTE_ACTIONS.map((a) => a.hint).filter((h): h is string => !!h);
    expect(new Set(hints).size).toBe(hints.length);
  });

  it("derives every g-binding from an action that has somewhere to go", () => {
    for (const [key, href] of Object.entries(GOTO_MAP)) {
      expect(key).toMatch(/^[a-z]$/);
      expect(href.startsWith("/"), `${key} → ${href}`).toBe(true);
    }
  });

  it("still binds the boards somebody opens every day", () => {
    expect(GOTO_MAP.d).toBe("/");
    expect(GOTO_MAP.l).toBe("/leads");
    expect(GOTO_MAP.p).toBe("/pipeline");
    expect(GOTO_MAP.r).toBe("/projects");
  });
});

describe("the onboarding tour and checklist point at real places", () => {
  const hrefs = [
    ...TOUR_STEPS.map((s) => s.href).filter((h): h is string => !!h),
    ...CHECKLIST.map((c) => c.href),
  ];

  /**
   * Reachable through a MENU, not necessarily through the sidebar.
   *
   * The sidebar used to be the whole route table. Since settings was split
   * into sections (P8/3) a legitimate destination can live in the settings
   * menu instead — "connect your mailbox" now points at /settings/email,
   * which is a real page reachable in one click and will never be a sidebar
   * entry. The guarantee that matters is unchanged: the tour must not send
   * somebody to a page nothing links to.
   */
  const reachable = new Set([
    ...navHrefs,
    ...PERSONAL_SECTIONS.map((s) => s.href),
    ...ADMIN_SECTIONS.map((s) => s.href),
  ]);

  for (const href of [...new Set(hrefs)]) {
    it(`${href} is reachable from a menu`, () => {
      expect(reachable.has(href), `${href} is in no menu`).toBe(true);
    });
  }

  /**
   * The settings split (item 10) moved letterhead, custom fields, grants and
   * the Claude budget to /settings/admin. The tour still described the old,
   * single Settings page — which is the kind of wrong that teaches a new user
   * the product works differently than it does.
   */
  it("describes the settings SPLIT rather than the page that used to exist", () => {
    const step = TOUR_STEPS.find((s) => s.id === "settings")!;
    expect(step.body).toMatch(/admin/i);
    expect(step.body).toMatch(/mailbox|postafi/i);
  });
});
