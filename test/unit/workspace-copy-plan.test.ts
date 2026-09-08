import { describe, it, expect } from "vitest";
import {
  COPY_GROUPS,
  COPY_GROUP_KEYS,
  NEVER_COPIED,
  describeCopy,
  sanitizeGroups,
} from "../../src/modules/workspaces/copy-plan";

/**
 * `provisionWorkspace` gives a new workspace the DEFAULTS. That is the right
 * floor and the wrong ceiling — an agency that spent a year tuning its quote
 * rules, custom fields and letterhead should not do it again for the second
 * company it runs.
 *
 * The dangerous version of the feature is "copy the workspace", because a
 * workspace contains other people's personal data. These tests hold the line
 * on the closed list.
 */
describe("the list of what can be copied", () => {
  it("names only configuration, never records about people", () => {
    /**
     * The one assertion that matters. If somebody adds "leads" to COPY_GROUPS,
     * this is what tells them what they broke.
     *
     * Compared as whole keys rather than substrings, because
     * `documentTemplates` legitimately contains "document" — the TEMPLATE for a
     * quote is configuration; a quote is not.
     */
    const forbidden = [
      "leads",
      "companies",
      "documents",
      "invoices",
      "auditLogs",
      "members",
      "users",
      "savedViews",
      "apiKeys",
      "webhooks",
    ];
    for (const key of forbidden) expect(COPY_GROUP_KEYS, key).not.toContain(key);
  });

  it("has unique keys and describes every group", () => {
    expect(new Set(COPY_GROUP_KEYS).size).toBe(COPY_GROUP_KEYS.length);
    for (const g of COPY_GROUPS) {
      expect(g.label.length).toBeGreaterThan(3);
      // The hint is the documentation — it is the only place the exclusions
      // ("values nélkül", "deal-ek nélkül") are stated to the person choosing.
      expect(g.hint.length).toBeGreaterThan(10);
    }
  });

  it("writes down what is never copied, with a reason for each", () => {
    const named = NEVER_COPIED.map((n) => n.what);
    for (const what of [
      "leads",
      "companies",
      "documents",
      "invoices",
      "auditLogs",
      "members",
      "apiKeys",
      "webhooks",
    ]) {
      expect(named, what).toContain(what);
    }
    for (const n of NEVER_COPIED) expect(n.why.length).toBeGreaterThan(15);
  });

  it("keeps the two lists disjoint", () => {
    const never = new Set(NEVER_COPIED.map((n) => n.what.toLowerCase()));
    for (const k of COPY_GROUP_KEYS) expect(never.has(k.toLowerCase()), k).toBe(false);
  });
});

describe("sanitising what the form asked for", () => {
  it("keeps only what the plan names", () => {
    expect(sanitizeGroups(["brand", "leads", "fields"])).toEqual(["brand", "fields"]);
  });

  it("returns declared order, so the copy runs in a predictable sequence", () => {
    // Pipelines before workflows: a copied rule's `toStage` refers to a stage
    // key, and the stages should exist by then.
    const out = sanitizeGroups(["workflows", "brand", "pipelines"]);
    expect(out).toEqual(["brand", "pipelines", "workflows"]);
  });

  it("de-duplicates", () => {
    expect(sanitizeGroups(["brand", "brand", "brand"])).toEqual(["brand"]);
  });

  it("refuses anything that is not a list of strings", () => {
    expect(sanitizeGroups(null)).toEqual([]);
    expect(sanitizeGroups("brand")).toEqual([]);
    expect(sanitizeGroups([1, 2, {}])).toEqual([]);
    expect(sanitizeGroups({ 0: "brand" })).toEqual([]);
  });
});

describe("saying what was copied", () => {
  it("lists only the groups that moved something", () => {
    const said = describeCopy({ brand: 1, fields: 3, targets: 0 });
    expect(said).toContain("egyedi mezők: 3");
    expect(said).not.toContain("célszámok");
  });

  it("says so plainly when nothing moved", () => {
    // A message that lists nothing reads as a silent failure.
    expect(describeCopy({})).toBe("semmi");
    expect(describeCopy({ brand: 0 })).toBe("semmi");
  });
});
