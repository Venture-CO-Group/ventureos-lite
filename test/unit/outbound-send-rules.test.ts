import { describe, it, expect } from "vitest";
import {
  assertColdSender,
  ColdSenderError,
  encodeHeader,
  buildColdMime,
  inSendWindow,
  spacingSeconds,
  shouldTripBreaker,
  asksToStop,
  bouncedAddresses,
  isFreemail,
} from "@/modules/outbound/send-rules";
import type { SendingPolicy } from "@/modules/mail/sending-policy";
import { signatureHtmlToText } from "@/modules/outbound/compose";

/**
 * Playbook-v6 F5: the sender's rules (CLAUDE.md hard rule 11), per workspace.
 * The Venture workspace's configuration is the example: transactional mail on
 * mg.ventureco.group, cold outbound from Fanni's own fanni.viragh@ventureco.group.
 */
const VENTURE: SendingPolicy = {
  workspaceId: "venture",
  outboundAddress: "fanni.viragh@ventureco.group",
  transactionalDomain: "mg.ventureco.group",
  coldDomain: "cold.ventureco.agency",
  foreignDomains: new Set(["seyuselfies.com"]),
};

describe("the cold sender guard", () => {
  it("allows the workspace's configured address — Fanni's own .group mailbox", () => {
    expect(assertColdSender("Fanni.Viragh@ventureco.group", VENTURE)).toBe("fanni.viragh@ventureco.group");
  });
  it("refuses the transactional sending domain itself — a refusal, not a warning", () => {
    const misconfigured = { ...VENTURE, outboundAddress: "offers@mg.ventureco.group" };
    expect(() => assertColdSender("offers@mg.ventureco.group", misconfigured)).toThrow(ColdSenderError);
  });
  it("refuses any other address, including the old .agency one, and nothing at all", () => {
    expect(() => assertColdSender("fanni.viragh@ventureco.agency", VENTURE)).toThrow(ColdSenderError);
    expect(() => assertColdSender("tamas@ventureco.group", VENTURE)).toThrow(ColdSenderError);
    expect(() => assertColdSender("", VENTURE)).toThrow(ColdSenderError);
    expect(() => assertColdSender(null, VENTURE)).toThrow(ColdSenderError);
  });
  it("refuses everything when the workspace configured no address", () => {
    expect(() => assertColdSender("fanni.viragh@ventureco.group", { ...VENTURE, outboundAddress: null })).toThrow(ColdSenderError);
  });
  it("refuses a domain another workspace has configured, even if this one names it", () => {
    const thief = { ...VENTURE, outboundAddress: "anna@seyuselfies.com" };
    expect(() => assertColdSender("anna@seyuselfies.com", thief)).toThrow(/another workspace/);
  });
});

describe("the MIME", () => {
  it("encodes Hungarian headers and carries one-click unsubscribe", () => {
    expect(encodeHeader("Plain")).toBe("Plain");
    expect(encodeHeader("Árvíztűrő")).toMatch(/^=\?UTF-8\?B\?/);
    const mime = buildColdMime({ from: "a@b.hu", fromName: "Fanni", to: "c@d.hu", toName: null, subject: "Hi", text: "Body", unsubscribeUrl: "https://x/u/t", inReplyTo: "<m@x>" });
    expect(mime).toContain('From: "Fanni" <a@b.hu>');
    expect(mime).toContain("In-Reply-To: <m@x>");
    expect(mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(mime.endsWith("\r\n\r\nBody")).toBe(true);
  });
});

describe("pacing", () => {
  it("sends on weekdays in business hours, Budapest time", () => {
    expect(inSendWindow(new Date("2026-10-22T06:30:00Z"), "Europe/Budapest", 8, 17)).toBe(true); // 08:30 local
    expect(inSendWindow(new Date("2026-10-22T05:30:00Z"), "Europe/Budapest", 8, 17)).toBe(false); // 07:30
    expect(inSendWindow(new Date("2026-10-25T10:00:00Z"), "Europe/Budapest", 8, 17)).toBe(false); // Sunday
  });
  it("jitters the gap within bounds, the same way every time", () => {
    const a = spacingSeconds("draft-1", 90, 420);
    expect(a).toBeGreaterThanOrEqual(90);
    expect(a).toBeLessThanOrEqual(420);
    expect(spacingSeconds("draft-1", 90, 420)).toBe(a);
  });
  it("trips the breaker on the rate once there is a sample", () => {
    expect(shouldTripBreaker(50, 1, 0.03)).toBe(false);
    expect(shouldTripBreaker(50, 2, 0.03)).toBe(true);
    expect(shouldTripBreaker(5, 1, 0.03)).toBe(false);
    expect(shouldTripBreaker(8, 3, 0.03)).toBe(true);
  });
});

describe("reading what came back", () => {
  it("hears a request to stop, in Hungarian or English", () => {
    expect(asksToStop("Kérem, ne írjon többet.")).toBe(true);
    expect(asksToStop("Please unsubscribe me")).toBe(true);
    expect(asksToStop("Köszönöm, beszéljünk jövő héten.")).toBe(false);
  });
  it("pulls the failed recipient out of a bounce notice", () => {
    expect(bouncedAddresses("Address not found: anna@nincs.hu could not be delivered. From mailer-daemon@googlemail.com")).toEqual(["anna@nincs.hu"]);
  });
  it("knows a free-mail domain is not a company", () => {
    expect(isFreemail("gmail.com")).toBe(true);
    expect(isFreemail("mosoly.hu")).toBe(false);
  });
  it("keeps a signature's lines", () => {
    expect(signatureHtmlToText("<div>Virágh Fanni</div><div>Venture&nbsp;CO<br>+36 30</div>")).toBe("Virágh Fanni\nVenture CO\n+36 30");
  });
});
