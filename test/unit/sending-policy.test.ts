import { describe, it, expect } from "vitest";
import {
  assertColdBulkDomain,
  assertOutboundFrom,
  ColdSenderError,
  registrableDomain,
  validateOutboundAddress,
  type SendingPolicy,
} from "../../src/modules/mail/sending-policy";

/** Per-workspace sending domains (CLAUDE.md hard rule 11, generalised). */
const SEYU: SendingPolicy = {
  workspaceId: "seyu",
  outboundAddress: "hello@seyu-outreach.com",
  transactionalDomain: "mg.seyuselfies.com",
  coldDomain: "cold.seyu-outreach.com",
  foreignDomains: new Set(["ventureco.agency", "ventureco.group"]),
};

describe("registrable domains", () => {
  it("strips subdomains, respecting two-label suffixes", () => {
    expect(registrableDomain("mg.ventureco.group")).toBe("ventureco.group");
    expect(registrableDomain("ventureco.agency")).toBe("ventureco.agency");
    expect(registrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("localhost")).toBeNull();
  });
});

describe("another company's workspace", () => {
  it("sends from its own configured address", () => {
    expect(assertOutboundFrom("hello@seyu-outreach.com", SEYU)).toBe("hello@seyu-outreach.com");
  });

  it("can never send through the Venture domains", () => {
    expect(() => assertOutboundFrom("fanni.viragh@ventureco.group", { ...SEYU, outboundAddress: "fanni.viragh@ventureco.group" })).toThrow(ColdSenderError);
    expect(validateOutboundAddress("x@ventureco.agency", SEYU)).toMatch(/another workspace/);
    expect(() => assertColdBulkDomain("cold.ventureco.agency", SEYU)).toThrow(/another workspace/);
  });

  it("1:1 outbound may use the company's main domain, but never the transactional sending domain", () => {
    expect(validateOutboundAddress("sales@seyuselfies.com", SEYU)).toBeNull();
    expect(validateOutboundAddress("sales@mg.seyuselfies.com", SEYU)).toMatch(/transactional/);
  });

  it("cold BULK may not share even the registrable domain with transactional mail", () => {
    expect(() => assertColdBulkDomain("news.seyuselfies.com", SEYU)).toThrow(/transactional/);
  });

  it("refuses a send from a domain it did not configure", () => {
    expect(() => assertOutboundFrom("hello@unconfigured.example", SEYU)).toThrow(ColdSenderError);
  });

  it("accepts a clean configuration", () => {
    expect(validateOutboundAddress("outreach@seyu-outreach.com", SEYU)).toBeNull();
    expect(assertColdBulkDomain("cold.seyu-outreach.com", SEYU)).toBe("cold.seyu-outreach.com");
  });
});
