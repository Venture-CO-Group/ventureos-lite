import { describe, it, expect } from "vitest";
import {
  BULK_BATCH_SIZE,
  addSignals,
  buildLeadsCsv,
  chunk,
  mergeBulkResults,
  planStageChange,
  removeSignals,
} from "../../src/modules/leads/bulk";

/**
 * Bulk actions (playbook-v2 P3/2). The parts that decide WHAT happens are pure
 * and live here; the server actions only carry them out. The score gate in
 * particular has to be provable per lead, because the playbook requires a bulk
 * stage change to skip the leads that fail it and report which.
 */

describe("batching", () => {
  it("splits a list into batches of the given size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns nothing for an empty list", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it("keeps a short list in one batch", () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it("has a batch size that keeps a progress bar meaningful", () => {
    expect(BULK_BATCH_SIZE).toBeGreaterThan(0);
    expect(BULK_BATCH_SIZE).toBeLessThanOrEqual(100);
  });
});

describe("the score gate on a bulk stage change", () => {
  const rows = [
    { id: "a", icpScore: 5, stage: "RESEARCHED" },
    { id: "b", icpScore: 1, stage: "RESEARCHED" },
    { id: "c", icpScore: null, stage: "RESEARCHED" },
    { id: "d", icpScore: 3, stage: "RESEARCHED" },
  ];

  it("moves only the leads at or above the threshold into Contacted", () => {
    const plan = planStageChange(rows, "CONTACTED", 3);
    expect(plan.allowed).toEqual(["a", "d"]);
  });

  it("reports each skipped lead with a reason rather than failing silently", () => {
    const plan = planStageChange(rows, "CONTACTED", 3);
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skipped.map((s) => s.id).sort()).toEqual(["b", "c"]);
    for (const s of plan.skipped) expect(s.reason).toMatch(/score|gate/i);
  });

  it("does not gate stages other than Contacted", () => {
    const plan = planStageChange(rows, "NOT_NOW", 3);
    expect(plan.allowed).toHaveLength(4);
    expect(plan.skipped).toHaveLength(0);
  });

  it("skips a lead already in the target stage instead of counting it as moved", () => {
    // Reporting "12 leads moved" when four were already there is a lie the
    // user cannot check.
    const plan = planStageChange(
      [
        { id: "a", icpScore: 5, stage: "CONTACTED" },
        { id: "b", icpScore: 5, stage: "RESEARCHED" },
      ],
      "CONTACTED",
      3,
    );
    expect(plan.allowed).toEqual(["b"]);
    expect(plan.skipped[0]).toMatchObject({ id: "a" });
    expect(plan.skipped[0]!.reason).toMatch(/already/i);
  });
});

describe("signal tags", () => {
  it("adds a signal a lead does not have", () => {
    expect(addSignals(["hiring"], ["outdated website"])).toEqual(["hiring", "outdated website"]);
  });

  it("does not duplicate one it already has", () => {
    expect(addSignals(["hiring"], ["hiring"])).toEqual(["hiring"]);
  });

  it("treats a differently-cased or accented duplicate as the same tag", () => {
    // Otherwise a bulk add quietly creates "Régi weboldal" beside "régi
    // weboldal" and every filter over signals starts missing half the leads.
    expect(addSignals(["régi weboldal"], ["Regi Weboldal"])).toEqual(["régi weboldal"]);
  });

  it("keeps the spelling the lead already had, not the one just typed", () => {
    expect(addSignals(["Régi weboldal"], ["regi weboldal"])).toEqual(["Régi weboldal"]);
  });

  it("removes a signal, matching loosely the same way", () => {
    expect(removeSignals(["Régi weboldal", "hiring"], ["regi weboldal"])).toEqual(["hiring"]);
  });

  it("leaves a lead alone when the signal to remove is not there", () => {
    expect(removeSignals(["hiring"], ["funding"])).toEqual(["hiring"]);
  });

  it("ignores blank tags rather than storing empty strings", () => {
    expect(addSignals(["hiring"], ["  ", ""])).toEqual(["hiring"]);
  });
});

describe("combining batch results", () => {
  it("sums what happened and concatenates what was skipped", () => {
    const merged = mergeBulkResults([
      { applied: 50, skipped: [{ id: "a", reason: "below the score gate" }] },
      { applied: 12, skipped: [{ id: "b", reason: "already there" }] },
    ]);
    expect(merged.applied).toBe(62);
    expect(merged.skipped.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("handles no batches at all", () => {
    /**
     * The undo keys are explicitly null rather than absent since the merge
     * moved to lib/bulk (playbook-v5 P17/1): the bar reads `undoId` to decide
     * whether to offer an Undo, and `undefined` vs `null` is a distinction
     * nothing downstream should have to care about.
     */
    expect(mergeBulkResults([])).toEqual({
      applied: 0,
      skipped: [],
      undoId: null,
      undoLabel: null,
    });
  });
});

describe("CSV export", () => {
  const rows = [
    {
      id: "1",
      contactName: "Nagy Anna",
      company: "Danubia Kft",
      email: "anna@danubia.hu",
      icpScore: 4,
      stage: "RESEARCHED",
      signals: ["hiring", "outdated website"],
    },
  ];

  it("writes a header row from the chosen columns, in that order", () => {
    const csv = buildLeadsCsv(rows, ["contact", "icpScore", "stage"]);
    expect(csv.split("\n")[0]).toBe("Lead,ICP score,Stage");
  });

  it("exports only the chosen columns", () => {
    const csv = buildLeadsCsv(rows, ["contact"]);
    expect(csv).not.toContain("anna@danubia.hu");
  });

  it("joins multi-valued cells readably rather than as JSON", () => {
    const csv = buildLeadsCsv(rows, ["signals"]);
    expect(csv).toContain("hiring; outdated website");
    expect(csv).not.toContain("[");
  });

  it("quotes a value containing the delimiter", () => {
    const csv = buildLeadsCsv(
      [{ ...rows[0], company: "Danubia, Kft" }],
      ["company"],
    );
    expect(csv).toContain('"Danubia, Kft"');
  });

  it("escapes embedded quotes by doubling them", () => {
    const csv = buildLeadsCsv([{ ...rows[0], company: 'The "Big" Co' }], ["company"]);
    expect(csv).toContain('"The ""Big"" Co"');
  });

  it("keeps a value with a newline inside one quoted field", () => {
    const csv = buildLeadsCsv([{ ...rows[0], company: "Line1\nLine2" }], ["company"]);
    expect(csv).toContain('"Line1\nLine2"');
  });

  it("writes an empty cell for a missing value, not the word null", () => {
    const csv = buildLeadsCsv([{ ...rows[0], email: null }], ["email"]);
    expect(csv.split("\n")[1]).toBe("");
    expect(csv).not.toContain("null");
  });
});
