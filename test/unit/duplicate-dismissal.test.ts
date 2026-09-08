import { describe, it, expect } from "vitest";
import {
  pairKey,
  sortedPair,
  withoutDismissed,
  type DuplicateCandidate,
} from "../../src/modules/merge/detect";

/**
 * The scanner's weakest signal is a fuzzy name match, which is suggestive
 * rather than certain: "Alfa Bt" and "Alfa Kft" quite possibly are two
 * different companies. There was no way to say so, so a legitimate false
 * positive sat in the review list for ever — and after a few of those the
 * whole panel gets ignored, which costs more than the duplicates it catches.
 */
const pair = (aId: string, bId: string): DuplicateCandidate => ({
  aId,
  bId,
  reason: "name",
  confidence: 90,
  detail: `${aId} ↔ ${bId}`,
});

describe("a pair has one key, whichever way round it arrives", () => {
  it("keys the same pair identically in both orders", () => {
    // The scanner may offer (a,b) on one run and (b,a) on the next depending
    // on row order. A dismissal keyed on the pair AS GIVEN would be forgotten
    // half the time.
    expect(pairKey("aaa", "bbb")).toBe(pairKey("bbb", "aaa"));
  });

  it("stores the two columns in the same order for both", () => {
    expect(sortedPair("bbb", "aaa")).toEqual({ aId: "aaa", bId: "bbb" });
    expect(sortedPair("aaa", "bbb")).toEqual({ aId: "aaa", bId: "bbb" });
  });

  it("keeps different pairs distinct", () => {
    expect(pairKey("aaa", "bbb")).not.toBe(pairKey("aaa", "ccc"));
    // Not a concatenation that could collide: "ab"+"c" must not equal "a"+"bc".
    expect(pairKey("ab", "c")).not.toBe(pairKey("a", "bc"));
  });

  it("handles a pair of one id without crashing", () => {
    // Should never happen, but a self-pair must not produce a key that
    // silently suppresses a real pair.
    expect(sortedPair("x", "x")).toEqual({ aId: "x", bId: "x" });
  });
});

describe("dismissed pairs leave the review list", () => {
  const candidates = [pair("a", "b"), pair("c", "d"), pair("e", "f")];

  it("removes exactly the dismissed pair", () => {
    const out = withoutDismissed(candidates, new Set([pairKey("a", "b")]));
    expect(out.map((c) => c.aId)).toEqual(["c", "e"]);
  });

  it("removes it however the candidate is ordered", () => {
    const flipped = [pair("b", "a")];
    expect(withoutDismissed(flipped, new Set([pairKey("a", "b")]))).toEqual([]);
  });

  it("leaves everything alone when nothing is dismissed", () => {
    expect(withoutDismissed(candidates, new Set())).toHaveLength(3);
  });

  it("ignores a dismissal for a pair that is no longer offered", () => {
    // Records get merged or deleted; a stale dismissal must not remove
    // something else.
    const out = withoutDismissed(candidates, new Set([pairKey("x", "y")]));
    expect(out).toHaveLength(3);
  });

  it("can empty the list entirely", () => {
    const all = new Set(candidates.map((c) => pairKey(c.aId, c.bId)));
    expect(withoutDismissed(candidates, all)).toEqual([]);
  });
});
