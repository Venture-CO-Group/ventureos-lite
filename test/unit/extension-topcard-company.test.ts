import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

/**
 * The Hungarian profile that reported four problems at once (fixture h).
 *
 * A real capture came back with a headline, a location, a name and a photo URL —
 * and no company, no job title, no visible location and no avatar. Four separate
 * causes, none of which was the DOM extractor being wrong about the page:
 *
 *   COMPANY — the current employer IS in the top card, as PLAIN TEXT. All 45 of
 *   the page's `/company/` anchors sit outside the card, so looking for one inside
 *   it found nothing on every profile.
 *
 *   JOB TITLE — genuinely absent. The headline is "Data-driven Fan-engagement &
 *   Sponsorship Activation": no separator, no role vocabulary, and no Experience
 *   section mounted. Nothing to read, so nothing is claimed.
 *
 *   LOCATION — read correctly and then invisible: the form's only City input
 *   belongs to the company, so a lead with no company showed no location at all.
 *
 *   AVATAR — read correctly and rejected by the server: the app container could
 *   not write /data/files at all (root-owned volume, app runs as uid 1001).
 */
const EXT = join(process.cwd(), "extension");
const FIXTURES = join(process.cwd(), "test/fixtures/linkedin");
const FILES = {
  selectors: readFileSync(join(EXT, "selectors.js"), "utf8"),
  names: readFileSync(join(EXT, "names.js"), "utf8"),
  content: readFileSync(join(EXT, "content.js"), "utf8"),
};

interface Extracted {
  name?: string;
  headline?: string;
  location?: string;
  companyName?: string;
  jobTitle?: string;
  photoUrl?: string;
  provenance: Record<string, { source: string; confidence: string; via?: string }>;
  _attempts: Record<string, string[]>;
  boundary: { ok: boolean; identitiesInCard: number | null };
}

function extract(fixture: string, slug: string): Extracted {
  const dom = new JSDOM(readFileSync(join(FIXTURES, fixture), "utf8"), {
    url: `https://www.linkedin.com/in/${slug}/`,
  });
  const g: Record<string, unknown> = {};
  for (const src of [FILES.selectors, FILES.names]) {
    new Function("globalThis", "window", "document", src)(g, dom.window, dom.window.document);
  }
  return new Function(
    "document",
    "window",
    "location",
    "URL",
    "globalThis",
    `return (${FILES.content.trim().replace(/;\s*$/, "")})`,
  )(dom.window.document, dom.window, dom.window.location, dom.window.URL, g) as Extracted;
}

const H = "h-hungarian-topcard-company.html";
const SLUG = "odon-anonimizalt";

describe("the current employer, named in the top card as plain text", () => {
  const out = extract(H, SLUG);

  /** THE REPORTED MISS. */
  it("reads the company nobody could find", () => {
    expect(out.companyName).toBe("'Seyu - Together for victory!'");
    expect(out.provenance.companyName).toMatchObject({ source: "derived", confidence: "medium" });
  });

  it("identifies it POSITIVELY, by cross-referencing the page's company links", () => {
    // Not "the line after the location" — a line that is also the text of a
    // /company/ anchor somewhere on the page. Two independent places agreeing.
    // The trail names WHICH link of the five-source chain answered, which
    // "derived:accepted" on its own could never tell you.
    expect(out._attempts.companyName?.join(" ")).toContain("topcard-company:accepted");
    expect(out._attempts.companyName?.join(" ")).toContain("section:experience:absent");
  });

  /**
   * The school sits directly beside the company in the same card, and has no
   * company anchor anywhere. That is exactly what keeps it out.
   */
  it("does not mistake the university beside it for the employer", () => {
    expect(out.companyName).not.toMatch(/university|egyetem|corvinus/i);
  });

  it("strips the zero-width character LinkedIn puts in company names", () => {
    // "'Seyu - Together for victory!'​" — invisible, survives every trim,
    // and would have made a second company row for the same business.
    expect(out.companyName).not.toMatch(/[​-‏⁠﻿]/);
  });

  it("still reads the headline, the location and the photo", () => {
    expect(out.headline).toBe("Data-driven Fan-engagement & Sponsorship Activation");
    expect(out.location).toBe("Budapest, Hungary");
    expect(out.photoUrl).toMatch(/^https:\/\/media\.licdn\.com\//);
  });

  /**
   * The job title is NOT on this top card — the headline is a positioning phrase
   * with no separator and no role word, and no Experience section is mounted. It
   * comes from the byline above the person's own posts, which is the fifth and
   * last link in the chain, and is labelled `derived` at medium confidence
   * because a byline is what they wrote about themselves rather than a field
   * LinkedIn labelled.
   */
  it("falls all the way through to the post byline for the job title", () => {
    expect(out.jobTitle).toBe("Sports Innovation Leader");
    expect(out.provenance.jobTitle).toMatchObject({ source: "derived", confidence: "medium" });
    const trail = out._attempts.jobTitle?.join(" ") ?? "";
    expect(trail).toContain("section:experience:absent");
    expect(trail).toContain("post-byline:accepted");
  });

  it("leaves nothing unexplained on this profile", () => {
    // Every field either has a value or a reason. On this one, all of them have
    // values — which is the whole point of the four fixes.
    expect(out.name).toBeTruthy();
    expect(out.headline).toBeTruthy();
    expect(out.location).toBeTruthy();
    expect(out.companyName).toBeTruthy();
    expect(out.jobTitle).toBeTruthy();
    expect(out.photoUrl).toBeTruthy();
  });

  it("keeps its bounded card to one identity, on a page with 54 other people", () => {
    expect(out.boundary.ok).toBe(true);
    expect(out.boundary.identitiesInCard).toBe(1);
  });
});

describe("the location reaches the form", () => {
  it("is exposed on the lead itself, not only through a company", async () => {
    const detail = readFileSync(join(process.cwd(), "src/modules/leads/detail.ts"), "utf8");
    const modal = readFileSync(
      join(process.cwd(), "src/components/lead-detail-modal.tsx"),
      "utf8",
    );
    // The lead carries the raw line…
    expect(detail).toMatch(/locationRaw:\s*string/);
    expect(detail).toMatch(/locationRaw:\s*lead\.locationRaw/);
    /**
     * …and the form has a control of its own for it, in the Contact block,
     * bound to the LEAD's location rather than to the company's city.
     *
     * 300 characters rather than 140: it is an inline control now
     * (playbook-v5 P16/1), which spans more lines than the bare <input> it
     * replaced. What is being pinned is unchanged — the testid and the binding
     * belong together.
     */
    expect(modal).toContain('data-testid="lead-location"');
    expect(modal).toMatch(/data-testid="lead-location"[\s\S]{0,300}value=\{form\.locationRaw\}/);
    // Sent back on save, so an edit sticks.
    expect(modal).toMatch(/locationRaw:\s*form\.locationRaw/);
  });
});

/**
 * ── THE LEAK I PUT IN THE REPOSITORY ────────────────────────────────────────
 *
 * The DOM scrubber replaced names and slugs and never touched member ids, so the
 * fixtures committed two days ago carried six real `ACoAA…` identifiers each —
 * inside urns and tracking attributes. It also missed accented slugs entirely:
 * `/in/dávid-bózsik` is written `d%c3%a1vid-b%c3%b3zsik` in the markup, and the
 * replacement was built from the decoded form, so it matched none of the 73
 * occurrences.
 *
 * Both are fixed in the scrubber and both are cleaned out of the committed files.
 * This test is what stops either coming back.
 */
describe("no fixture carries a real identity", () => {
  const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith(".html"));

  it("checks a meaningful number of fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of fixtures) {
    it(`${file} has no member id and no percent-encoded slug`, () => {
      const html = readFileSync(join(FIXTURES, file), "utf8");
      const ids = [...new Set(html.match(/ACoAA[A-Za-z0-9_-]{6,}/g) ?? [])].filter(
        (id) => !id.startsWith("ACoAASCRUBBED"),
      );
      expect(ids, `${file} contains real member ids`).toEqual([]);
      // A percent-encoded slug decodes straight back to somebody's name.
      const encoded = [...new Set(html.match(/\/in\/[A-Za-z0-9_-]*%[0-9a-f]{2}[^"'\s/]*/gi) ?? [])];
      expect(encoded, `${file} contains an encoded slug`).toEqual([]);
    });
  }
});
