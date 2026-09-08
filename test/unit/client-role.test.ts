import { describe, it, expect } from "vitest";
import {
  CLIENT_ALLOWED_EXACT,
  GRANTS,
  clientMayVisit,
  denyToken,
  grantAllowed,
  grantIsImplicit,
  isClientRole,
  isTrustedMember,
} from "../../src/lib/grants";

/**
 * Read-only client access (P6/6.3).
 *
 * A CLIENT is not a smaller BDR. It sees ONE company's delivery and nothing
 * else in the workspace, and the guarantee rests on three independent checks —
 * no capability, no write, no page outside the portal. These cover the first
 * and the third; the second is enforced in the Prisma tenant guard and tested
 * against a real database.
 */
describe("a client carries no capability", () => {
  it("is refused every grant that exists", () => {
    for (const g of GRANTS) {
      expect(grantAllowed("CLIENT", [], g), g).toBe(false);
    }
  });

  it("is refused even when the grant is written on the membership", () => {
    /**
     * The check runs FIRST, before the explicit list is read.
     *
     * A stray entry left behind by a role change — or set by hand — must not
     * hand a read-only account a capability. This is the assertion that makes
     * that true rather than incidental.
     */
    for (const g of GRANTS) {
      expect(grantAllowed("CLIENT", [...GRANTS], g), g).toBe(false);
    }
  });

  it("carries nothing implicitly, so the grants panel shows no ticks", () => {
    for (const g of GRANTS) expect(grantIsImplicit("CLIENT", g), g).toBe(false);
  });

  it("does not accidentally widen the other roles", () => {
    expect(grantAllowed("OWNER", [], "exports.run")).toBe(true);
    expect(grantAllowed("ADMIN", [], "templates.edit")).toBe(true);
    expect(grantAllowed("BDR", [], "exports.run")).toBe(true);
    expect(grantAllowed("BDR", [], "templates.edit")).toBe(false);
    // And a deny token still beats a BDR's implicit capability.
    expect(grantAllowed("BDR", [denyToken("exports.run")], "exports.run")).toBe(false);
  });
});

describe("a client is not a seated member", () => {
  it("does not qualify as trusted", () => {
    // The comment on isTrustedMember promised a read-only role could be
    // introduced with a single edit. This is that edit, asserted.
    expect(isTrustedMember("CLIENT")).toBe(false);
    expect(isTrustedMember("OWNER")).toBe(true);
    expect(isTrustedMember("ADMIN")).toBe(true);
    expect(isTrustedMember("BDR")).toBe(true);
  });

  it("recognises the role, and only that role", () => {
    expect(isClientRole("CLIENT")).toBe(true);
    for (const r of ["OWNER", "ADMIN", "BDR", "client", "", null, undefined]) {
      expect(isClientRole(r), String(r)).toBe(false);
    }
  });
});

describe("which pages a client may render", () => {
  it("allows the portal and its sub-routes", () => {
    expect(clientMayVisit("/portal")).toBe(true);
    expect(clientMayVisit("/portal/documents")).toBe(true);
    expect(clientMayVisit("/portal/anything/deeper")).toBe(true);
  });

  it("allows their own settings and enrolment, exactly", () => {
    for (const p of CLIENT_ALLOWED_EXACT) expect(clientMayVisit(p), p).toBe(true);
  });

  it("refuses the settings sub-pages that are somebody else's business", () => {
    // /settings is their profile; /settings/admin and /settings/workspaces are
    // not, and a prefix match would have handed both over.
    expect(clientMayVisit("/settings/admin")).toBe(false);
    expect(clientMayVisit("/settings/workspaces")).toBe(false);
  });

  it("refuses every working screen", () => {
    for (const p of [
      "/",
      "/leads",
      "/pipeline",
      "/deals",
      "/documents",
      "/inbox",
      "/prospector",
      "/analytics",
      "/tasks",
      "/projects",
      "/templates",
    ]) {
      expect(clientMayVisit(p), p).toBe(false);
    }
  });

  it("refuses a path that merely starts with an allowed word", () => {
    // "/portalx" is not under "/portal", and a naive startsWith would say so.
    expect(clientMayVisit("/portalx")).toBe(false);
    expect(clientMayVisit("/settings-admin")).toBe(false);
  });

  it("refuses an unknown path rather than allowing it", () => {
    expect(clientMayVisit(undefined)).toBe(false);
    expect(clientMayVisit("")).toBe(false);
    // A page that forgets to pass its activePath sends a client to the portal,
    // which is the safe direction to be wrong in.
    expect(clientMayVisit("/some/new/screen")).toBe(false);
  });
});
