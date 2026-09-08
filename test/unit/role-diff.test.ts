import { describe, it, expect } from "vitest";
import { grantSource, roleDiff } from "../../src/modules/members/role-diff";
import { DOCUMENT_GRANTS, GRANTS, grantAllowed, denyToken } from "../../src/lib/grants";

/**
 * "What changes if I make this person an Admin?" (§4, §6).
 *
 * The spec's qualifier is the whole requirement: computed from the grants
 * model, not hardcoded prose. A hand-written sentence is true on the day it is
 * typed and becomes a lie the first time the model changes — with nothing to
 * catch it, because the sentence still reads perfectly well.
 */
describe("promoting a BDR to Admin", () => {
  const diff = roleDiff({ fromRole: "BDR", toRole: "ADMIN", grants: [] });

  it("gains exactly the document and template capabilities", () => {
    // A BDR carries everything EXCEPT those five; an Admin carries all.
    expect(diff.gains.sort()).toEqual([...DOCUMENT_GRANTS].sort());
    expect(diff.loses).toEqual([]);
  });

  it("leaves the rest unchanged", () => {
    expect(diff.unchanged.length).toBe(GRANTS.length - DOCUMENT_GRANTS.length);
  });
});

describe("demoting an Admin to BDR", () => {
  it("loses exactly what the promotion gained", () => {
    const down = roleDiff({ fromRole: "ADMIN", toRole: "BDR", grants: [] });
    expect(down.loses.sort()).toEqual([...DOCUMENT_GRANTS].sort());
    expect(down.gains).toEqual([]);
  });
});

describe("the membership's own grants are carried through", () => {
  it("does not claim a loss of something explicitly granted", () => {
    /**
     * A BDR with `templates.edit` granted explicitly does not lose it by
     * becoming an Admin and back. Diffing role-against-role while ignoring
     * the membership would tell them they are about to lose a capability they
     * will in fact keep.
     */
    const diff = roleDiff({
      fromRole: "ADMIN",
      toRole: "BDR",
      grants: ["templates.edit"],
    });
    expect(diff.loses).not.toContain("templates.edit");
    expect(diff.unchanged).toContain("templates.edit");
  });

  it("keeps an explicit withdrawal across a promotion", () => {
    // An Admin whose exports.run was explicitly withdrawn keeps that as a BDR.
    const withdrawn = [denyToken("exports.run")];
    expect(grantAllowed("BDR", withdrawn, "exports.run")).toBe(false);
    const diff = roleDiff({ fromRole: "BDR", toRole: "ADMIN", grants: withdrawn });
    // ADMIN overrides a deny token, so this IS a gain — and saying so is right.
    expect(diff.gains).toContain("exports.run");
  });
});

describe("a role change that changes nothing", () => {
  it("says so, so the button can", () => {
    const same = roleDiff({ fromRole: "ADMIN", toRole: "ADMIN", grants: [] });
    expect(same.identical).toBe(true);
    expect(same.gains).toEqual([]);
    expect(same.loses).toEqual([]);
  });

  it("is also true between Owner and Admin, which both carry everything", () => {
    // The difference between them is NOT in the grant model — it is
    // `requireOwner`, which no grant reaches. Claiming a capability change
    // would be describing something that does not exist.
    const diff = roleDiff({ fromRole: "OWNER", toRole: "ADMIN", grants: [] });
    expect(diff.identical).toBe(true);
  });
});

describe("demoting to a read-only client", () => {
  it("loses everything", () => {
    const diff = roleDiff({ fromRole: "ADMIN", toRole: "CLIENT", grants: [] });
    expect(diff.gains).toEqual([]);
    expect(diff.loses.length).toBe(GRANTS.length);
  });
});

describe("the diff agrees with the resolver, on every pair", () => {
  /**
   * The property that keeps the preview honest.
   *
   * Every role pair, with and without explicit grants: the diff must be
   * exactly the set of capabilities whose `grantAllowed` answer flips. If the
   * preview and the enforcement ever disagree, this is what says so.
   */
  const roles = ["OWNER", "ADMIN", "BDR", "CLIENT"];
  const grantSets = [[], ["templates.edit"], [denyToken("exports.run")], [...GRANTS]];

  for (const from of roles) {
    for (const to of roles) {
      for (const [i, grants] of grantSets.entries()) {
        it(`${from} → ${to} with grant set ${i}`, () => {
          const diff = roleDiff({ fromRole: from, toRole: to, grants });
          for (const g of GRANTS) {
            const before = grantAllowed(from, grants, g);
            const after = grantAllowed(to, grants, g);
            if (before === after) expect(diff.unchanged, g).toContain(g);
            else if (after) expect(diff.gains, g).toContain(g);
            else expect(diff.loses, g).toContain(g);
          }
          // And every capability lands in exactly one bucket.
          expect(diff.gains.length + diff.loses.length + diff.unchanged.length).toBe(
            GRANTS.length,
          );
        });
      }
    }
  }
});

describe("why a capability is held", () => {
  it("names the role when the role carries it", () => {
    expect(grantSource("BDR", [], "exports.run")).toBe("role");
    expect(grantSource("ADMIN", [], "templates.edit")).toBe("role");
  });

  it("names an explicit grant", () => {
    expect(grantSource("BDR", ["templates.edit"], "templates.edit")).toBe("explicit");
  });

  it("names an explicit withdrawal, which beats the role", () => {
    expect(grantSource("BDR", [denyToken("exports.run")], "exports.run")).toBe("withdrawn");
  });

  it("says nothing granted when nothing is", () => {
    expect(grantSource("BDR", [], "templates.edit")).toBe("none");
  });
});
