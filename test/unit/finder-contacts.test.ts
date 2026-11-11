import { describe, it, expect } from "vitest";
import { pickEmail, siteFor } from "@/modules/finder/contacts";
import { mergeContacts } from "@/modules/finder/evaluate";

describe("finder contact helpers", () => {
  it("locates a site from the registry website, else a non-free-mail email domain", () => {
    expect(siteFor({ website: { value: "https://a.hu", source: "registry" } })).toBe("https://a.hu");
    expect(siteFor({ email: { value: "info@ceg.hu", source: "registry" } })).toBe("https://ceg.hu");
    expect(siteFor({ email: { value: "kovacs@gmail.com", source: "registry" } })).toBeNull();
    expect(siteFor({})).toBeNull();
  });

  it("prefers the company's own shared inbox", () => {
    expect(pickEmail(["anna@ceg.hu", "info@ceg.hu", "x@gmail.com"], "ceg.hu")).toBe("info@ceg.hu");
    expect(pickEmail(["anna@ceg.hu", "x@gmail.com"], "ceg.hu")).toBe("anna@ceg.hu");
    expect(pickEmail(["x@gmail.com"], "ceg.hu")).toBeNull();
  });

  it("merges by filling blanks only — an earlier source is never overwritten", () => {
    expect(
      mergeContacts(
        { email: { value: "a@r.hu", source: "registry" } },
        { email: { value: "b@r.hu", source: "impresszum" }, phone: { value: "1", source: "impresszum" } },
        { phone: { value: "2", source: "crm" }, website: { value: "w", source: "crm" } },
      ),
    ).toEqual({
      email: { value: "a@r.hu", source: "registry" },
      phone: { value: "1", source: "impresszum" },
      website: { value: "w", source: "crm" },
    });
  });
});
