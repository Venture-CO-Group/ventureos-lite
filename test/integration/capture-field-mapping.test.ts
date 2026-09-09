import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { createCaptureToken } from "../../src/modules/capture/tokens";

/**
 * Every captured field lands in its OWN column (capture item 2b).
 *
 * ── THE BUG THIS IS ABOUT ───────────────────────────────────────────────────
 *
 * The capture wrote `title: input.jobTitle ?? input.headline`. The Experience
 * section is lazy-rendered, so `jobTitle` is absent on most captures and the
 * headline silently took its place — and the lead form renders `title` in its
 * job-title input. On /in/mgoldberger the headline was itself the person's NAME
 * (a separate bug, item 1/2a), so the operator saw an empty Name field with
 * "Mark Goldberger" sitting in the job-title slot beside it.
 *
 * Two facts, two columns, and NEITHER substitutes for the other. A job title is
 * "VP Sales". A headline is "VP Sales @ Metaview | Startup Advisor and Investor |
 * Ramp and Navan Alum". A field with nothing captured stays empty.
 */
const { POST } = await import("../../src/app/api/capture/route");

const EMAIL = "capture-mapping-user@ventureco.test";
const WORKSPACE = "Capture Mapping Test WS";

let workspaceId = "";
let userId = "";
let token = "";

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("https://app.test/api/capture", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  await prismaUnsafe.workspace.deleteMany({ where: { name: { startsWith: WORKSPACE } } });
  workspaceId = (await prismaUnsafe.workspace.create({ data: { name: WORKSPACE } })).id;
  const user = await prismaUnsafe.user.upsert({
    where: { email: EMAIL },
    update: {},
    create: { email: EMAIL, name: "Mapping Tester", passwordHash: "x" },
  });
  userId = user.id;
  await prismaUnsafe.membership.upsert({
    where: { userId_workspaceId: { userId, workspaceId } },
    update: {},
    create: { userId, workspaceId, role: "OWNER" },
  });
  token = (await createCaptureToken(userId, workspaceId, "mapping")).token;
});

async function wipe() {
  await prismaUnsafe.activity.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.company.deleteMany({ where: { workspaceId } });
}
beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await prismaUnsafe.captureToken.deleteMany({ where: { userId } });
  await prismaUnsafe.membership.deleteMany({ where: { userId } });
  await prismaUnsafe.user.deleteMany({ where: { email: EMAIL } });
  await prismaUnsafe.workspace.deleteMany({ where: { id: workspaceId } });
});

const HEADLINE = "VP Sales @ Metaview | Startup Advisor and Investor | Ramp and Navan Alum";

async function leadFor(url: string) {
  return prismaUnsafe.lead.findFirst({
    where: { workspaceId, linkedinUrl: url },
    include: { company: true },
  });
}

describe("the headline never becomes the job title", () => {
  /** THE SPECIFIED CASE: only a headline and a location were captured. */
  it("leaves title EMPTY when only a headline was captured", async () => {
    const url = "https://www.linkedin.com/in/mapping-headline-only";
    const res = await post({ url, headline: HEADLINE, location: "San Francisco Bay Area" });
    // 201 for a new lead, 200 for an update to an existing one.
    expect([200, 201]).toContain(res.status);

    const lead = await leadFor(url);
    expect(lead).not.toBeNull();
    // The two assertions the screenshot was about.
    expect(lead!.title, "the headline leaked into the job-title column").toBeNull();
    expect(lead!.headline).toBe(HEADLINE);
    // And nothing was shifted into the name either.
    expect(lead!.contactName).toBeNull();
  });

  it("keeps both when both were captured, in their own columns", async () => {
    const url = "https://www.linkedin.com/in/mapping-both";
    await post({ url, name: "Mark Goldberger", jobTitle: "VP Sales", headline: HEADLINE });
    const lead = await leadFor(url);
    expect(lead!.contactName).toBe("Mark Goldberger");
    expect(lead!.title).toBe("VP Sales");
    expect(lead!.headline).toBe(HEADLINE);
  });

  it("never writes the name into any other column", async () => {
    const url = "https://www.linkedin.com/in/mapping-name-only";
    await post({ url, name: "Mark Goldberger" });
    const lead = await leadFor(url);
    expect(lead!.contactName).toBe("Mark Goldberger");
    for (const other of [lead!.title, lead!.headline, lead!.bio]) {
      expect(other).not.toBe("Mark Goldberger");
    }
  });

  it("does not overwrite a job title a human typed", async () => {
    const url = "https://www.linkedin.com/in/mapping-existing";
    await post({ url, name: "Mark Goldberger", jobTitle: "VP Sales" });
    const first = await leadFor(url);
    await prismaUnsafe.lead.update({
      where: { id: first!.id },
      data: { title: "Chief Revenue Officer" },
    });
    // A second capture arrives with only a headline.
    await post({ url, headline: HEADLINE });
    const second = await leadFor(url);
    expect(second!.title).toBe("Chief Revenue Officer");
    expect(second!.headline).toBe(HEADLINE);
  });

  it("puts the location's city on the company, not into a contact field", async () => {
    const url = "https://www.linkedin.com/in/mapping-city";
    await post({
      url,
      name: "Mark Goldberger",
      companyName: "Metaview",
      location: "Budapest, Hungary",
    });
    const lead = await leadFor(url);
    expect(lead!.company?.name).toBe("Metaview");
    expect(lead!.company?.city).toBe("Budapest");
    expect(lead!.title).toBeNull();
    expect(lead!.headline).toBeNull();
  });
});

describe("the form's shape matches the columns", () => {
  /**
   * The mapping is only as good as the inputs it lands in, and the form used to
   * have no headline input at all — which is why sharing the job-title one looked
   * acceptable. Asserted against the component source: one labelled input per
   * field, each with its own test id.
   */
  it("has a distinct input for each captured field", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/components/lead-detail-modal.tsx"),
      "utf8",
    );
    for (const testid of [
      "lead-name",
      "lead-title",
      "lead-headline",
      "lead-city",
      "lead-company",
      "lead-language",
    ]) {
      expect(src, `no input carries data-testid="${testid}"`).toContain(`data-testid="${testid}"`);
    }
    /**
     * Each control is bound to ITS OWN field — the bug being pinned is the
     * headline sharing the job title's input.
     *
     * The window is 300 characters rather than 120 because these are inline
     * controls now (playbook-v5 P16/1) and an <InlineField> spans more lines
     * than the bare <input> it replaced. The assertion is the same one: the
     * testid and the binding have to belong together.
     */
    expect(src).toMatch(/data-testid="lead-headline"[\s\S]{0,300}value=\{form\.headline\}/);
    expect(src).toMatch(/data-testid="lead-title"[\s\S]{0,300}value=\{form\.title\}/);
  });

  it("no longer collapses the headline into the title anywhere in the capture route", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const raw = readFileSync(join(process.cwd(), "src/app/api/capture/route.ts"), "utf8");
    // Comments stripped: the note explaining the bug quotes the old expression,
    // and a check that its own documentation trips is a check nobody keeps.
    const { stripComments } = await import("../helpers/strip-comments");
    const src = stripComments(raw);
    // The exact expression that caused it.
    expect(src).not.toMatch(/title:\s*[^\n]*input\.headline/);
    // And the two fields really are written separately.
    expect(src).toMatch(/headline:\s*(existing\.headline \?\? )?input\.headline/);
  });
});

describe("a captured location always reaches the lead", () => {
  /** THE REPORTED CASE: a US metro region, absent from the gazetteer. */
  it("resolves 'San Francisco Bay Area' to a City and keeps the raw string", async () => {
    const url = "https://www.linkedin.com/in/mapping-metro";
    await post({
      url,
      name: "Mark Goldberger",
      companyName: "Metaview",
      location: "San Francisco Bay Area",
    });
    const lead = await leadFor(url);
    // Was blank before: unknown_place, so the city was dropped.
    expect(lead!.company?.city).toBe("San Francisco");
    // And the string the operator saw on the profile is stored verbatim.
    expect(lead!.locationRaw).toBe("San Francisco Bay Area");
  });

  it("keeps the raw string even when no city can be resolved at all", async () => {
    const url = "https://www.linkedin.com/in/mapping-unresolvable";
    await post({ url, name: "Mark Goldberger", companyName: "Metaview", location: "Hungary" });
    const lead = await leadFor(url);
    // "Hungary" is a country with no city — correctly no City…
    expect(lead!.company?.city).toBeNull();
    // …but the location line is not thrown away.
    expect(lead!.locationRaw).toBe("Hungary");
  });

  it("never lets a person's name become the City, however real the country tail", async () => {
    const url = "https://www.linkedin.com/in/mapping-person-location";
    await post({
      url,
      name: "Mark Goldberger",
      companyName: "Metaview",
      location: "Dana Whitfield, Hungary",
    });
    const lead = await leadFor(url);
    expect(lead!.company?.city).toBeNull();
    expect(lead!.locationRaw).toBe("Dana Whitfield, Hungary");
  });
});

/**
 * END TO END, on the /in/mgoldberger fixture (all six items).
 *
 * The extension reads the committed fixture in jsdom, the payload goes through the
 * real capture route, and the lead is checked. This is the assertion the brief
 * asks for, and it is the one that would have caught every reported symptom at
 * once: an empty Name, the name in the job-title slot, a blank City, no role or
 * employer, and a Hungarian lead in California.
 */
describe("the mgoldberger fixture, from page to lead", () => {
  it("produces a correct lead", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { JSDOM } = await import("jsdom");

    const EXT = join(process.cwd(), "extension");
    const read = (n: string) => readFileSync(join(EXT, n), "utf8");
    const dom = new JSDOM(
      readFileSync(join(process.cwd(), "test/fixtures/linkedin/g-abbreviated-slug-us-metro.html"), "utf8"),
      { url: "https://www.linkedin.com/in/mgoldberger/" },
    );
    let scrollY = 0;
    Object.defineProperty(dom.window, "scrollY", { get: () => scrollY, configurable: true });
    dom.window.scrollTo = ((_x: number, y: number) => {
      scrollY = typeof y === "number" ? y : 0;
    }) as typeof dom.window.scrollTo;

    const g: Record<string, unknown> = {};
    for (const f of ["selectors.js", "names.js"]) {
      new Function("globalThis", "window", "document", read(f))(g, dom.window, dom.window.document);
    }
    const payload = new Function(
      "document",
      "window",
      "location",
      "URL",
      "globalThis",
      `return (${read("content.js").trim().replace(/;\s*$/, "")})`,
    )(dom.window.document, dom.window, dom.window.location, dom.window.URL, g) as Record<
      string,
      unknown
    >;

    // ---- what the reader found -------------------------------------------
    expect(payload.name).toBe("Mark Goldberger");
    expect(payload.headline).toBe(
      "VP Sales @ Metaview | Startup Advisor and Investor | Ramp and Navan Alum",
    );
    expect(payload.jobTitle).toBe("VP Sales");
    expect(payload.companyName).toBe("Metaview");
    expect(payload.location).toBe("San Francisco Bay Area");
    expect(payload.photoUrl).toMatch(/^https:\/\/media\.licdn\.com\//);

    // ---- through the real route ------------------------------------------
    const { _from, _attempts, provenance, skipped, boundary, route, refused, flags, photoUrl, ...body } =
      payload as Record<string, unknown>;
    void _from; void _attempts; void provenance; void skipped; void boundary;
    void route; void refused; void flags; void photoUrl;

    const url = "https://www.linkedin.com/in/mgoldberger";
    const res = await post({ ...body, url });
    expect([200, 201]).toContain(res.status);

    const lead = await leadFor(url);
    expect(lead).not.toBeNull();

    // Name in the Name field — the reported symptom was an empty one.
    expect(lead!.contactName).toBe("Mark Goldberger");
    // Job title in the job-title field, headline in the headline field.
    expect(lead!.title).toBe("VP Sales");
    expect(lead!.headline).toBe(
      "VP Sales @ Metaview | Startup Advisor and Investor | Ramp and Navan Alum",
    );
    // The name is in exactly one place.
    for (const other of [lead!.title, lead!.headline, lead!.bio]) {
      expect(other).not.toBe("Mark Goldberger");
    }
    // City resolved out of a US metro region, raw string kept.
    expect(lead!.company?.name).toBe("Metaview");
    expect(lead!.company?.city).toBe("San Francisco");
    expect(lead!.locationRaw).toBe("San Francisco Bay Area");
    // English, from the person's own words, not the HU default.
    expect(lead!.language).toBe("EN");
    expect(lead!.languageConfidence).toBe("high");
    // The photo URL was read; the avatar itself is attached by its own request,
    // which `capture-avatar-chain` covers leg by leg.
    expect(lead!.avatarPath).toBeNull();
  });
});
