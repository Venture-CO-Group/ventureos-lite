import { describe, it, expect } from "vitest";
import { planNight, nightlyDue, type PlanProduct } from "@/modules/outbound/schedule";
import { parseOutboundConfig } from "@/modules/outbound/config";
import { funnelFor } from "@/modules/outbound/metrics";
import { exhaustionSuggestion, briefingDigestLines, type Briefing } from "@/modules/outbound/briefing";

/** Playbook-v6 F6: the scheduler's arithmetic and the measures. */
const product = (id: string, priority: number, profiles: PlanProduct["profiles"]): PlanProduct => ({ id, priority, profiles });
const profile = (id: string, quota: number, eligible = 100, weight = 1) => ({ id, quota, weight, active: true, eligible });

describe("planning the night (spec §4.43.10)", () => {
  it("tops up to target: 12 unreviewed against 15 produces exactly 3", () => {
    const plan = planNight({ products: [product("web", 1, [profile("p1", 15)])], pendingByProduct: new Map([["web", 12]]), cap: 25 });
    expect(plan.allocations).toEqual([{ productId: "web", profileId: "p1", requested: 3 }]);
  });

  it("never fills the queue past the workspace cap, and serves priority first", () => {
    const plan = planNight({
      products: [product("health", 1, [profile("h", 8)]), product("web", 5, [profile("w", 12)])],
      pendingByProduct: new Map(),
      cap: 15,
    });
    expect(plan.allocations.find((a) => a.productId === "web")!.requested).toBe(12);
    expect(plan.allocations.find((a) => a.productId === "health")!.requested).toBe(3);
  });

  it("splits a product's share between its profiles by weight, within each quota", () => {
    const plan = planNight({ products: [product("web", 1, [profile("a", 10, 100, 3), profile("b", 10, 100, 1)])], pendingByProduct: new Map(), cap: 8 });
    const by = Object.fromEntries(plan.allocations.map((a) => [a.profileId, a.requested]));
    expect(by).toEqual({ a: 6, b: 2 });
  });

  it("reallocates an exhausted product's share to the next product with need", () => {
    const plan = planNight({
      products: [product("bank", 9, [profile("b", 5, 0)]), product("web", 1, [profile("w", 20)])],
      pendingByProduct: new Map(),
      cap: 10,
    });
    expect(plan.exhausted).toEqual(["b"]);
    expect(plan.allocations).toEqual([{ productId: "web", profileId: "w", requested: 10 }]);
  });

  it("does nothing when the queue is already full", () => {
    const plan = planNight({ products: [product("web", 1, [profile("w", 15)])], pendingByProduct: new Map([["web", 30]]), cap: 25 });
    expect(plan.allocations).toEqual([]);
  });
});

describe("when the night runs", () => {
  const cfg = (over: object = {}) => parseOutboundConfig({ schedule: { enabled: true, hour: 3, minute: 0, days: [1, 2, 3, 4, 5], ...over } });
  it("runs after 03:00 Budapest time on a weekday, once per date", () => {
    // Thursday 22 Oct 2026, 03:10 in Budapest (01:10 UTC, CEST).
    expect(nightlyDue(cfg(), new Date("2026-10-22T01:10:00Z"))).toEqual({ due: true, localDate: "2026-10-22" });
    expect(nightlyDue(cfg({ lastRunDate: "2026-10-22" }), new Date("2026-10-22T01:10:00Z")).due).toBe(false);
  });
  it("does not run before the hour, on a weekend, or when switched off", () => {
    expect(nightlyDue(cfg(), new Date("2026-10-22T00:30:00Z")).due).toBe(false);
    expect(nightlyDue(cfg(), new Date("2026-10-24T02:00:00Z")).due).toBe(false);
    expect(nightlyDue(cfg({ enabled: false }), new Date("2026-10-22T01:10:00Z")).due).toBe(false);
  });
});

describe("measures", () => {
  it("computes the approval rate and the rejection distribution", () => {
    const c = (state: string, reason: string | null = null) => ({ id: Math.random().toString(), productId: "p", profileId: "x", state, reason, leadId: null }) as never;
    const f = funnelFor(
      [c("APPROVED"), c("SENT"), c("REPLIED"), c("REJECTED", "WRONG_TARGETING"), c("REJECTED", "WRONG_TARGETING"), c("REJECTED", "WEAK_COPY"), c("FILTERED_OUT", "IN_CRM"), c("FILTERED_OUT", "SIZE")],
      new Set(),
      new Set(),
    );
    expect(f.approvalRate).toBe(0.5);
    expect(f.rejectionReasons).toEqual({ WRONG_TARGETING: 2, WEAK_COPY: 1 });
    expect(f.prefiltered).toBe(1);
    expect(f.sent).toBe(2);
    expect(f.replied).toBe(1);
  });
  it("suggests a different source for a fantasy-named segment that ran dry", () => {
    expect(exhaustionSuggestion(["NAME_HARVEST_WEAK"])).toContain("seed list");
    expect(exhaustionSuggestion(["NAME_HARVEST_STRONG"])).toContain("fragments");
  });
  it("puts the briefing at the top of the Monday digest, and nothing when the motor is unused", () => {
    const b: Briefing = {
      active: true,
      pending: { total: 23, byProduct: [{ name: "web", n: 12 }, { name: "health", n: 11 }] },
      linkedIn: 0,
      lastNight: null,
      dropped: { total: 0, byReason: [] },
      quota: { used: 1240, limit: 5000, month: "2026-10" },
      exhausted: [],
      missed: [],
    };
    expect(briefingDigestLines(b)[0]).toEqual({ key: "outbound_pending", label: "Outbound waiting for approval", value: "23 (web 12, health 11)" });
    expect(briefingDigestLines({ ...b, active: false })).toEqual([]);
  });
});
