import { describe, it, expect } from "vitest";
import { failureCode, googleErrorMessage, GOOGLE_PAGE_ERRORS } from "../../src/modules/google/errors";

/**
 * Google OAuth errors become sentences somebody can act on (item 4), and a
 * raw Google response never reaches the screen.
 */
describe("mapping Google's errors", () => {
  it("org_internal says which organisation and what to do", () => {
    expect(googleErrorMessage("org_internal").message).toBe(
      "This Google account is not part of the organisation that owns this workspace's Google client. Sign in with an account from that organisation, or configure the workspace's own Google client.",
    );
  });

  it("invalid_client and redirect_uri_mismatch point at the field to fix", () => {
    expect(googleErrorMessage("invalid_client").field).toBe("clientId");
    expect(googleErrorMessage("invalid_client").message).toMatch(/Client id and Client secret/);
    expect(googleErrorMessage("redirect_uri_mismatch").field).toBe("redirectUri");
    expect(googleErrorMessage("redirect_uri_mismatch").message).toMatch(/Authorised redirect URIs/);
  });

  it("access_denied covers both a cancel and an admin restriction", () => {
    const m = googleErrorMessage("access_denied").message;
    expect(m).toMatch(/cancelled/);
    expect(m).toMatch(/administrator/);
  });

  it("an unknown code gets a generic sentence, never Google's raw text", () => {
    const m = googleErrorMessage("some_new_google_error").message;
    expect(m).not.toContain("some_new_google_error");
    expect(m.length).toBeGreaterThan(20);
  });

  it("codes are URL-safe whatever Google sent", () => {
    expect(failureCode({ code: "google", error: "org_internal" })).toBe("org_internal");
    expect(failureCode({ code: "exchange", error: "<script>x</script>" })).toBe("scriptxscript");
    expect(failureCode({ code: "state", reason: "expired" })).toBe("state_expired");
  });

  it("explains the errors Google shows on its own page before the person goes there", () => {
    expect(GOOGLE_PAGE_ERRORS.map((e) => e.code)).toEqual(
      expect.arrayContaining(["org_internal", "redirect_uri_mismatch", "invalid_client"]),
    );
  });
});
