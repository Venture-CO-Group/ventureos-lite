import { describe, it, expect } from "vitest";
import { validateDraft, stillGrounded, highlightRanges } from "@/modules/outbound/draft";
import { outboundIcpBreakdown } from "@/modules/outbound/approval";
import { linkedInOpener } from "@/modules/outbound/queue-view";
import { composeMessage, signatureFor } from "@/modules/outbound/compose";
import { buildOutboundDraftMessage } from "@/lib/ai/prompts/outbound-draft";
import type { CandidateFact } from "@/modules/outbound/facts";

/** Playbook-v6 F4: the pure half of drafting and review. */
const facts: CandidateFact[] = [
  { id: "audit:viewport", kind: "audit", label: "Mobile layout", value: "no viewport tag" },
  { id: "registry:founded", kind: "registry", label: "Founded", value: "2011 (15 years)" },
];
const refs = [
  { companyName: "Dentalia Kft.", taxNumber: null, isClient: true, note: null },
  { companyName: "KPMG Hungária Kft.", taxNumber: null, isClient: false, note: null },
];

describe("validateDraft", () => {
  const ok = { subject: "Mobilon szétesik az oldal", body: "Az oldaluk mobilon szétesik: no viewport tag. 15 perc?", personalisationPoints: [{ factId: "audit:viewport", quote: "no viewport tag" }] };
  it("accepts a grounded draft", () => {
    expect(validateDraft(ok, facts, refs).ok).toBe(true);
  });
  it("refuses an unknown fact id, a missing quote, an empty citation list", () => {
    expect(validateDraft({ ...ok, personalisationPoints: [{ factId: "registry:revenue", quote: "no viewport tag" }] }, facts, refs).ok).toBe(false);
    expect(validateDraft({ ...ok, personalisationPoints: [{ factId: "audit:viewport", quote: "lassú" }] }, facts, refs).ok).toBe(false);
    expect(validateDraft({ ...ok, personalisationPoints: [] }, facts, refs).ok).toBe(false);
  });
  it("refuses a pattern reference's name and an unfilled placeholder, but allows a client's", () => {
    expect(validateDraft({ ...ok, body: `${ok.body} Mint a KPMG.` }, facts, refs).ok).toBe(false);
    expect(validateDraft({ ...ok, body: `${ok.body} Mint a Dentalia.` }, facts, refs).ok).toBe(true);
    expect(validateDraft({ ...ok, body: `Tisztelt {{name}}! ${ok.body}` }, facts, refs).ok).toBe(false);
  });
  it("knows when an edit has removed every cited fact", () => {
    expect(stillGrounded({ subject: "x", body: "no viewport tag here" }, ok.personalisationPoints)).toBe(true);
    expect(stillGrounded({ subject: "x", body: "Weboldalakat készítünk." }, ok.personalisationPoints)).toBe(false);
  });
  it("finds the quotes to highlight", () => {
    expect(highlightRanges("Az oldal: no viewport tag.", ok.personalisationPoints)).toEqual([{ start: 10, end: 25, factId: "audit:viewport" }]);
  });
});

describe("the outbound lead's ICP score is computed, never guessed", () => {
  it("scores segment, trigger, decision maker, activity and hook", () => {
    const b = outboundIcpBreakdown({
      matchedSegment: "private_clinics",
      facts,
      contact: { kind: "named_generic" } as never,
      registryStatus: "Aktív",
    });
    expect(b).toEqual({ segment_fit: 1, trigger_signal: 1, decision_maker: 1, active_profile: 1, personal_hook: 1 });
  });
});

describe("what leaves", () => {
  it("is body, signature, then the unsubscribe line", () => {
    const sig = signatureFor({ cachedSignature: null, fallbackSignature: "" }, { senderName: "Virágh Fanni", company: "Venture" });
    const out = composeMessage({ body: "Szöveg.", signature: sig, language: "HU", unsubscribeUrl: "https://x/u/t" });
    expect(out).toBe("Szöveg.\n\n--\nVirágh Fanni\nVenture\n\nHa nem szeretne több levelet kapni tőlünk, itt leiratkozhat: https://x/u/t");
  });
  it("prefers the account's own signature", () => {
    expect(signatureFor({ cachedSignature: "Fanni\n+36", fallbackSignature: "x" }, { senderName: "a", company: "b" })).toBe("Fanni\n+36");
  });
});

describe("prompt and LinkedIn opener", () => {
  it("lists only what it is given as nameable, and the facts by id", () => {
    const m = buildOutboundDraftMessage({
      language: "HU",
      variant: "generic",
      contactName: null,
      company: { name: "X Kft.", city: null, segment: null },
      sender: { name: "F", company: "V" },
      product: { name: "Web", problemSolved: "p", valueProps: [], proofPoints: [], assets: [] },
      nameableReferences: [],
      facts: facts.map(({ id, label, value }) => ({ id, label, value })),
    });
    expect(m).toContain("NAMEABLE REFERENCES (true clients — the only companies you may name):\n(none)");
    expect(m).toContain("[audit:viewport] Mobile layout: no viewport tag");
  });
  it("opens with the strongest fact and no AI", () => {
    expect(linkedInOpener("X Kft.", "Kovács Anna", facts)).toContain("no viewport tag");
  });
});
