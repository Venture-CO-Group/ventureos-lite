import { describe, it, expect } from "vitest";
import {
  GRANTS,
  DOCUMENT_GRANTS,
  denyToken,
  grantAllowed,
  grantIsImplicit,
  isDenyToken,
  isTrustedMember,
} from "../../src/lib/grants";

/**
 * Who may do what (spec §3, CLAUDE.md hard rule #7).
 *
 * The rule changed deliberately: a BDR now carries everything an Admin does,
 * with two exceptions. Documents — quotes, contracts, certificates, the
 * templates they are rendered from, and sending any of them — still need the
 * grant handed over one by one. User management is not a grant at all: it sits
 * behind `requireOwner`, so no role short of Owner reaches it.
 */
describe("grantAllowed (server-side grant denial)", () => {
  it("Owner and Admin carry every grant implicitly", () => {
    for (const grant of GRANTS) {
      expect(grantAllowed("OWNER", [], grant), grant).toBe(true);
      expect(grantAllowed("ADMIN", [], grant), grant).toBe(true);
    }
  });

  /**
   * The widening. A BDR needed an explicit grant to run an export, approve a
   * signal, add a workspace field or merge two obvious duplicates — daily work,
   * gated as though it were a legal document.
   */
  it("a BDR carries the everyday capabilities without being granted them", () => {
    for (const grant of GRANTS.filter((g) => !DOCUMENT_GRANTS.includes(g))) {
      expect(grantAllowed("BDR", [], grant), grant).toBe(true);
    }
    expect(grantAllowed("BDR", [], "exports.run")).toBe(true);
    expect(grantAllowed("BDR", [], "signal_engine.approve")).toBe(true);
    expect(grantAllowed("BDR", [], "fields.manage")).toBe(true);
    expect(grantAllowed("BDR", [], "data.merge")).toBe(true);
  });

  it("a BDR is still refused every document capability until it is granted", () => {
    for (const grant of DOCUMENT_GRANTS) {
      expect(grantAllowed("BDR", [], grant), grant).toBe(false);
    }
    expect(grantAllowed("BDR", [], "documents.send")).toBe(false);
    // Templates decide what every future document SAYS, so they are on the
    // document side of the line rather than the everyday side.
    expect(grantAllowed("BDR", [], "templates.edit")).toBe(false);
  });

  it("a granted document capability is allowed, and only that one", () => {
    expect(grantAllowed("BDR", ["documents.quote.create"], "documents.quote.create")).toBe(true);
    expect(grantAllowed("BDR", ["documents.quote.create"], "documents.contract.create")).toBe(
      false,
    );
    expect(grantAllowed("BDR", ["documents.quote.create"], "documents.send")).toBe(false);
  });

  it("a role nobody recognises is refused everything it was not handed", () => {
    expect(grantAllowed("GUEST", [], "exports.run")).toBe(false);
    expect(grantAllowed("", [], "data.merge")).toBe(false);
    expect(grantAllowed("GUEST", ["exports.run"], "exports.run")).toBe(true);
  });

  it("every document grant is a real grant, so a typo cannot widen the set", () => {
    for (const grant of DOCUMENT_GRANTS) {
      expect(GRANTS, grant).toContain(grant);
    }
  });
});

/**
 * A capability nobody can take away is not a capability.
 *
 * The grants array has always meant "additionally allowed", which was the
 * whole story while every grant was opt-in. Once a BDR carries most of them by
 * default, removing an entry that was never there does nothing — so the
 * settings screen rendered those boxes ticked AND DISABLED, and an Owner who
 * wanted to stop one person deleting leads had no way to say so.
 */
describe("withdrawing a capability the role carries by default", () => {
  it("an explicit withdrawal beats the role", () => {
    expect(grantAllowed("BDR", [], "leads.delete")).toBe(true);
    expect(grantAllowed("BDR", [denyToken("leads.delete")], "leads.delete")).toBe(false);
  });

  it("withdraws exactly one capability and leaves the rest alone", () => {
    const grants = [denyToken("leads.delete")];
    expect(grantAllowed("BDR", grants, "leads.delete")).toBe(false);
    expect(grantAllowed("BDR", grants, "exports.run")).toBe(true);
    expect(grantAllowed("BDR", grants, "data.merge")).toBe(true);
  });

  it("beats a positive entry too, so the two cannot both be true", () => {
    // Belt and braces: if both somehow end up stored, the refusal wins. A
    // permission system that resolves a contradiction in favour of access is
    // not a permission system.
    expect(grantAllowed("BDR", ["exports.run", denyToken("exports.run")], "exports.run")).toBe(
      false,
    );
  });

  it("does not let a withdrawal reach an Owner or an Admin", () => {
    // An Owner who could be locked out of their own workspace by an edit to a
    // JSON column is a support call waiting to happen.
    expect(grantAllowed("OWNER", [denyToken("leads.delete")], "leads.delete")).toBe(true);
    expect(grantAllowed("ADMIN", [denyToken("exports.run")], "exports.run")).toBe(true);
  });

  it("cannot be spelled by accident", () => {
    // Every real grant is a lower-case dotted identifier, so the marker can
    // never collide with one.
    for (const grant of GRANTS) {
      expect(isDenyToken(grant), grant).toBe(false);
      expect(isDenyToken(denyToken(grant)), grant).toBe(true);
    }
  });
});

describe("grantIsImplicit (what the settings screen shows as a default)", () => {
  it("matches what grantAllowed actually does for an ungranted member", () => {
    // These two must not drift: the screen renders a tick from one and the
    // server decides from the other.
    for (const grant of GRANTS) {
      for (const role of ["OWNER", "ADMIN", "BDR"]) {
        expect(grantIsImplicit(role, grant), `${role}/${grant}`).toBe(
          grantAllowed(role, [], grant),
        );
      }
    }
  });

  it("says a document capability is never a default for a BDR", () => {
    for (const grant of DOCUMENT_GRANTS) {
      expect(grantIsImplicit("BDR", grant), grant).toBe(false);
    }
  });
});

describe("what a BDR can now do that they could not", () => {
  /**
   * "a bdr is minden funkcióval rendelkezzen pl. lead törlés teljes körüen."
   *
   * Lead deletion was `requireOwner` — not a grant, so not even grantable.
   * These are the capabilities that moved, listed by name so a future edit
   * that quietly narrows one of them fails here.
   */
  it("carries every capability the daily job needs", () => {
    for (const grant of [
      "leads.delete",
      "settings.manage",
      "public_pages.manage",
      "sector_reports.manage",
      "audit_log.read",
      "exports.run",
      "data.merge",
      "fields.manage",
      "signal_engine.approve",
    ]) {
      expect(GRANTS as readonly string[], grant).toContain(grant);
      expect(grantAllowed("BDR", [], grant), grant).toBe(true);
    }
  });
});

describe("isTrustedMember", () => {
  it("admits every seated role and nobody else", () => {
    expect(isTrustedMember("OWNER")).toBe(true);
    expect(isTrustedMember("ADMIN")).toBe(true);
    expect(isTrustedMember("BDR")).toBe(true);
    expect(isTrustedMember(null)).toBe(false);
    expect(isTrustedMember(undefined)).toBe(false);
    expect(isTrustedMember("GUEST")).toBe(false);
  });
});
