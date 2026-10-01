import { describe, it, expect } from "vitest";
import {
  CONTENT_STATUSES,
  allowedTransitions,
  canTransition,
  isChannel,
  maxCharsFor,
  isOverLimit,
  validateForStatus,
} from "../../src/modules/content/board";
import { USE_CASE_MODEL } from "../../src/lib/ai/models";

describe("board shape", () => {
  it("is Draft → In review → Approved → Published", () => {
    expect([...CONTENT_STATUSES]).toEqual(["DRAFT", "IN_REVIEW", "APPROVED", "PUBLISHED"]);
  });
});

describe("transitions", () => {
  it("walks the happy path forward", () => {
    expect(canTransition("DRAFT", "IN_REVIEW", false)).toEqual({ allowed: true });
    expect(canTransition("IN_REVIEW", "APPROVED", true)).toEqual({ allowed: true });
    expect(canTransition("APPROVED", "PUBLISHED", false)).toEqual({ allowed: true });
  });

  it("refuses to skip a step", () => {
    const jump = canTransition("DRAFT", "APPROVED", true);
    expect(jump.allowed).toBe(false);
    if (!jump.allowed) expect(jump.reason).toBe("illegal");
    expect(canTransition("DRAFT", "PUBLISHED", true).allowed).toBe(false);
    expect(canTransition("IN_REVIEW", "PUBLISHED", true).allowed).toBe(false);
  });

  it("lets only an approver approve", () => {
    const denied = canTransition("IN_REVIEW", "APPROVED", false);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.reason).toBe("forbidden");
      expect(denied.message).toMatch(/member of this workspace/);
    }
  });

  it("lets anyone send a post back to draft, but only an approver reopen a signed-off one", () => {
    // Rejecting during review is ordinary editing.
    expect(canTransition("IN_REVIEW", "DRAFT", false).allowed).toBe(true);
    // Undoing an approval or a publish is not.
    expect(canTransition("APPROVED", "DRAFT", false).allowed).toBe(false);
    expect(canTransition("APPROVED", "DRAFT", true).allowed).toBe(true);
    expect(canTransition("PUBLISHED", "DRAFT", false).allowed).toBe(false);
    expect(canTransition("PUBLISHED", "DRAFT", true).allowed).toBe(true);
  });

  it("offers a BDR fewer moves than an approver", () => {
    expect(allowedTransitions("IN_REVIEW", false).map((t) => t.to)).toEqual(["DRAFT"]);
    expect(allowedTransitions("IN_REVIEW", true).map((t) => t.to)).toEqual(["APPROVED", "DRAFT"]);
    expect(allowedTransitions("PUBLISHED", false)).toEqual([]);
  });
});

describe("channels", () => {
  it("knows its channels and their limits", () => {
    expect(isChannel("linkedin")).toBe(true);
    expect(isChannel("tiktok")).toBe(false);
    expect(maxCharsFor("linkedin")).toBe(3000);
    expect(maxCharsFor("blog")).toBeNull();
  });

  it("only enforces a limit where one exists", () => {
    expect(isOverLimit("linkedin", "x".repeat(3001))).toBe(true);
    expect(isOverLimit("linkedin", "x".repeat(3000))).toBe(false);
    expect(isOverLimit("blog", "x".repeat(50_000))).toBe(false);
  });
});

describe("validation on the way out of Draft", () => {
  const one = (body: string, channel = "linkedin") => [{ channel, body }];
  const base = { title: "T", variants: one("Some words.") };

  it("lets a draft be anything, including empty", () => {
    expect(
      validateForStatus({ title: "", variants: one(""), status: "DRAFT" }),
    ).toEqual({ ok: true });
  });

  it("requires a title and a body to leave Draft", () => {
    expect(validateForStatus({ ...base, title: "", status: "IN_REVIEW" }).ok).toBe(false);
    expect(validateForStatus({ ...base, variants: one("   "), status: "IN_REVIEW" }).ok).toBe(false);
    expect(validateForStatus({ ...base, status: "IN_REVIEW" })).toEqual({ ok: true });
  });

  it("blocks an over-length LinkedIn post and says how much to cut", () => {
    const res = validateForStatus({
      ...base,
      variants: one("x".repeat(3120)),
      status: "IN_REVIEW",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("120");
  });

  /**
   * The topic moves as ONE. Three renderings of a subject are one editorial
   * decision, so every channel has to be ready — an over-limit LinkedIn version
   * cannot ride along on a blog version that happens to be fine.
   */
  it("judges every channel, not just the first", () => {
    const res = validateForStatus({
      title: "T",
      variants: [
        { channel: "blog", body: "A perfectly good article." },
        { channel: "linkedin", body: "x".repeat(3050) },
      ],
      status: "IN_REVIEW",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("LinkedIn");
      expect(res.message).toContain("50");
    }
  });

  it("names the channel whose version is still empty", () => {
    const res = validateForStatus({
      title: "T",
      variants: [
        { channel: "linkedin", body: "Written." },
        { channel: "newsletter", body: "" },
      ],
      status: "IN_REVIEW",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("Newsletter");
  });

  it("refuses a topic with no channel at all", () => {
    const res = validateForStatus({ title: "T", variants: [], status: "IN_REVIEW" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/at least one channel/i);
  });
});

describe("model routing (CLAUDE.md hard rule #3)", () => {
  /**
   * The list stays EXPLICIT rather than becoming a rule about categories.
   * CLAUDE.md names four kinds — research cards, outreach drafts, meeting
   * briefs, weekly analysis — and every entry below has to be defensible as one
   * of them. Adding a row here should feel like a decision, which is the whole
   * point of pinning it.
   *
   *   campaign_frame     — an outreach draft, written once per campaign
   *   meeting_followup   — an outreach draft: the first message after a
   *                        conversation, where the wrong register costs the
   *                        deal (playbook-v4 P13/2 allows it by name)
   *   sector_report      — published writing that carries the company's name
   *                        in public; one call per report, Owner-triggered and
   *                        Owner-edited (playbook-v4 P12/2b allows it by name)
   */
  it("drafts content on Haiku — Sonnet is reserved for the named use cases", () => {
    expect(USE_CASE_MODEL.content_draft).toBe("claude-haiku-4-5");
    const sonnet = Object.entries(USE_CASE_MODEL)
      .filter(([, m]) => m === "claude-sonnet-4-6")
      .map(([k]) => k)
      .sort();
    expect(sonnet).toEqual([
      "campaign_frame",
      "lead_research",
      "meeting_brief",
      "meeting_followup",
      // The outbound motor's draft (playbook-v6 F4) — an outreach draft,
      // which rule #3 names as a Sonnet use case.
      "outbound_draft",
      "outreach_draft",
      "sector_report",
      "signal_engine",
    ]);
  });
});
