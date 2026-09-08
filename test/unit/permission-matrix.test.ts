import { describe, it, expect } from "vitest";
import {
  MATRIX_ROLES,
  buildMatrix,
  moduleOf,
  roleSummary,
} from "../../src/modules/members/permission-matrix";
import {
  DOCUMENT_GRANTS,
  GRANTS,
  grantAllowed,
  grantIsImplicit,
  denyToken,
} from "../../src/lib/grants";

/**
 * The permission matrix (§6).
 *
 * The requirement is not "show a table" — it is that the table is COMPUTED
 * from the grants model. A matrix maintained by hand disagrees with the server
 * the first time somebody edits the model, with nothing to catch it, because a
 * stale matrix still renders perfectly.
 *
 * The property test at the bottom is the one that keeps the UI and the code
 * from drifting. It is the test the spec asked for by name.
 */
describe("grouping by module", () => {
  it("derives the module from the identifier", () => {
    expect(moduleOf("documents.quote.create")).toBe("documents");
    expect(moduleOf("exports.run")).toBe("exports");
    // A grant that does not follow the convention groups under itself, which
    // is visible rather than silent.
    expect(moduleOf("weird")).toBe("weird");
  });

  it("covers every capability exactly once", () => {
    const matrix = buildMatrix();
    const seen = matrix.flatMap((g) => g.rows.map((r) => r.grant));
    expect(seen.sort()).toEqual([...GRANTS].sort());
    expect(new Set(seen).size).toBe(GRANTS.length);
  });

  it("marks the five that stay behind an explicit grant", () => {
    const rows = buildMatrix().flatMap((g) => g.rows);
    const flagged = rows.filter((r) => r.documentGrant).map((r) => r.grant);
    expect(flagged.sort()).toEqual([...DOCUMENT_GRANTS].sort());
  });
});

describe("what each role carries", () => {
  it("says an Owner and an Admin carry everything", () => {
    expect(roleSummary("OWNER")).toBe(`all ${GRANTS.length}`);
    expect(roleSummary("ADMIN")).toBe(`all ${GRANTS.length}`);
  });

  it("says a BDR carries everything but the documents", () => {
    expect(roleSummary("BDR")).toBe(`${GRANTS.length - DOCUMENT_GRANTS.length} of ${GRANTS.length}`);
  });

  it("says a client carries none", () => {
    expect(roleSummary("CLIENT")).toBe("none");
  });
});

describe("the cells", () => {
  const rows = buildMatrix().flatMap((g) => g.rows);
  const cell = (grant: string, role: string) =>
    rows.find((r) => r.grant === grant)!.cells.find((c) => c.role === role)!;

  it("shows a BDR's document capabilities as grantable, not inherent", () => {
    const c = cell("templates.edit", "BDR");
    expect(c.inherent).toBe(false);
    expect(c.grantable).toBe(true);
  });

  it("shows a BDR's daily capabilities as inherent", () => {
    const c = cell("exports.run", "BDR");
    expect(c.inherent).toBe(true);
    // Nothing to hand over — it is already theirs.
    expect(c.grantable).toBe(false);
  });

  it("shows nothing grantable for a client, in any module", () => {
    /**
     * The resolver refuses a CLIENT every capability before it reads the
     * grants list at all, so handing one over changes nothing. Saying so beats
     * a column of empty boxes that look like an oversight.
     */
    for (const g of GRANTS) {
      const c = cell(g, "CLIENT");
      expect(c.inherent, g).toBe(false);
      expect(c.grantable, g).toBe(false);
    }
  });
});

/**
 * ── THE TEST THE SPEC ASKED FOR BY NAME ─────────────────────────────────────
 *
 * "the effective-permissions view matches what src/lib/grants.ts actually
 * resolves (property-based test across all role × grant combinations — this is
 * the test that keeps UI and code from drifting)."
 */
describe("every cell agrees with the resolver", () => {
  const rows = buildMatrix().flatMap((g) => g.rows);

  for (const role of MATRIX_ROLES) {
    it(`${role}: inherent matches grantIsImplicit for all ${GRANTS.length} capabilities`, () => {
      for (const row of rows) {
        const c = row.cells.find((x) => x.role === role)!;
        expect(c.inherent, `${role} × ${row.grant}`).toBe(grantIsImplicit(role, row.grant));
      }
    });

    it(`${role}: a cell claiming inherent is allowed with no grants at all`, () => {
      for (const row of rows) {
        const c = row.cells.find((x) => x.role === role)!;
        if (c.inherent) {
          expect(grantAllowed(role, [], row.grant), `${role} × ${row.grant}`).toBe(true);
        }
      }
    });

    it(`${role}: a cell claiming grantable becomes allowed once granted`, () => {
      for (const row of rows) {
        const c = row.cells.find((x) => x.role === role)!;
        if (c.grantable) {
          expect(grantAllowed(role, [], row.grant), `${role} × ${row.grant} before`).toBe(false);
          expect(grantAllowed(role, [row.grant], row.grant), `${role} × ${row.grant} after`).toBe(
            true,
          );
        }
      }
    });

    it(`${role}: a cell claiming neither cannot be granted into existence`, () => {
      for (const row of rows) {
        const c = row.cells.find((x) => x.role === role)!;
        if (!c.inherent && !c.grantable) {
          // The only role this is true for is CLIENT, and it must stay true.
          expect(grantAllowed(role, [row.grant], row.grant), `${role} × ${row.grant}`).toBe(false);
        }
      }
    });

    it(`${role}: an explicit withdrawal beats the matrix's inherent claim`, () => {
      for (const row of rows) {
        const withdrawn = [denyToken(row.grant)];
        const allowed = grantAllowed(role, withdrawn, row.grant);
        // OWNER and ADMIN override a deny token; the matrix does not claim
        // otherwise, and a member's resolved view is what shows the override.
        if (role === "OWNER" || role === "ADMIN") {
          expect(allowed, `${role} × ${row.grant}`).toBe(true);
        } else {
          expect(allowed, `${role} × ${row.grant}`).toBe(false);
        }
      }
    });
  }

  it("checks every combination, so a shrinking model cannot pass vacuously", () => {
    expect(rows.length).toBe(GRANTS.length);
    expect(MATRIX_ROLES.length).toBe(4);
    expect(rows.length * MATRIX_ROLES.length).toBeGreaterThanOrEqual(56);
  });
});
