import { describe, it, expect } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  LIVE_STATES,
  MEMBERSHIP_STATES,
  MEMBERSHIP_STATE_DEFS,
  canSignIn,
  canTransition,
  isAssignable,
  isSeated,
} from "../../src/modules/members/lifecycle";
import {
  MEMBERSHIP_EVENT_KINDS,
  eventLabel,
  isMembershipEventKind,
  requiresReason,
} from "../../src/modules/members/events";
import {
  OWNED_CATEGORIES,
  OWNED_CATEGORY_KEYS,
  categoryFor,
  validatePlan,
} from "../../src/modules/members/reassignment";

/**
 * The member lifecycle (§1).
 *
 * Membership used to be binary: a row existed, and `suspendedAt` was either
 * null or not. Every check in the codebase was written against that, which
 * means every one of them became INCOMPLETE the moment INVITED and REMOVED
 * existed — both have a null suspension, and both would have let somebody in.
 * These tests are what make the three questions have one answer each.
 */
describe("what each state may do", () => {
  it("defines all four, and only those", () => {
    expect(MEMBERSHIP_STATES).toEqual(["INVITED", "ACTIVE", "SUSPENDED", "REMOVED"]);
    // A new state cannot be added without deciding what it means.
    for (const s of MEMBERSHIP_STATES) {
      expect(MEMBERSHIP_STATE_DEFS[s], s).toBeDefined();
      expect(MEMBERSHIP_STATE_DEFS[s].hint.length, s).toBeGreaterThan(15);
    }
  });

  it("lets only an ACTIVE membership sign in", () => {
    expect(canSignIn("ACTIVE")).toBe(true);
    for (const s of ["INVITED", "SUSPENDED", "REMOVED"]) {
      expect(canSignIn(s), s).toBe(false);
    }
  });

  it("lets only an ACTIVE membership be assigned work", () => {
    expect(isAssignable("ACTIVE")).toBe(true);
    for (const s of ["INVITED", "SUSPENDED", "REMOVED"]) {
      expect(isAssignable(s), s).toBe(false);
    }
  });

  it("counts a suspended person as still seated", () => {
    /**
     * The distinction that is the whole point of suspension: they cannot work,
     * and everything they own is still theirs and still attributed. A members
     * screen that hid them would hide the rows somebody came to act on.
     */
    expect(isSeated("SUSPENDED")).toBe(true);
    expect(isAssignable("SUSPENDED")).toBe(false);
    expect(isSeated("INVITED")).toBe(false);
    expect(isSeated("REMOVED")).toBe(false);
  });

  it("says no to a state that does not exist rather than throwing", () => {
    // A hand-edited row must fail closed, not crash the login path.
    for (const s of ["", "active", "GUEST", "null"]) {
      expect(canSignIn(s), s).toBe(false);
      expect(isAssignable(s), s).toBe(false);
      expect(isSeated(s), s).toBe(false);
    }
  });

  it("lists the states a member list shows by default", () => {
    expect(LIVE_STATES).toEqual(["INVITED", "ACTIVE", "SUSPENDED"]);
    // A list that grows for ever with people who left is a list nobody reads.
    expect(LIVE_STATES).not.toContain("REMOVED");
  });
});

describe("which transitions are legal", () => {
  it("covers every state", () => {
    for (const s of MEMBERSHIP_STATES) expect(ALLOWED_TRANSITIONS[s], s).toBeDefined();
  });

  it("refuses to suspend a pending invitation", () => {
    // There is nothing to suspend. Revoke the invitation instead.
    expect(canTransition("INVITED", "SUSPENDED")).toBe(false);
    expect(canTransition("INVITED", "ACTIVE")).toBe(true);
    expect(canTransition("INVITED", "REMOVED")).toBe(true);
  });

  it("refuses to reinstate somebody who was removed", () => {
    /**
     * Bringing them back is a fresh invitation: they accept the terms again,
     * and the timeline shows a return rather than an edit.
     */
    expect(canTransition("REMOVED", "ACTIVE")).toBe(false);
    expect(canTransition("REMOVED", "INVITED")).toBe(true);
  });

  it("allows the ordinary suspend and reinstate", () => {
    expect(canTransition("ACTIVE", "SUSPENDED")).toBe(true);
    expect(canTransition("SUSPENDED", "ACTIVE")).toBe(true);
  });

  it("never allows a state to transition to itself", () => {
    // A no-op that writes a timeline entry is a timeline nobody trusts.
    for (const s of MEMBERSHIP_STATES) expect(canTransition(s, s), s).toBe(false);
  });

  it("refuses an unknown state in either position", () => {
    expect(canTransition("GUEST", "ACTIVE")).toBe(false);
    expect(canTransition("ACTIVE", "GUEST")).toBe(false);
  });
});

describe("the timeline's vocabulary", () => {
  it("has unique, snake_case kinds", () => {
    expect(new Set(MEMBERSHIP_EVENT_KINDS).size).toBe(MEMBERSHIP_EVENT_KINDS.length);
    for (const k of MEMBERSHIP_EVENT_KINDS) expect(k).toMatch(/^[a-z][a-z_]*$/);
  });

  it("reads every kind back as a sentence", () => {
    for (const k of MEMBERSHIP_EVENT_KINDS) {
      const label = eventLabel(k);
      expect(label.length, k).toBeGreaterThan(5);
      // Naming the thing that changed, not the table it changed in.
      expect(label, k).not.toMatch(/membership updated/i);
    }
  });

  it("falls back to the raw kind rather than throwing", () => {
    // An unknown kind reaching the column must not break the drawer.
    expect(eventLabel("something_new")).toBe("something_new");
    expect(isMembershipEventKind("something_new")).toBe(false);
    expect(isMembershipEventKind("totp_reset")).toBe(true);
    expect(isMembershipEventKind(7)).toBe(false);
  });

  it("demands a reason for the three actions nobody should take silently", () => {
    /**
     * A 2FA reset is the classic social-engineering target — "hi, it's Anna, I
     * lost my phone" — so whoever does it writes down who asked and how they
     * were satisfied it was really them.
     */
    expect(requiresReason("totp_reset")).toBe(true);
    expect(requiresReason("removed")).toBe(true);
    expect(requiresReason("ownership_transferred")).toBe(true);
    // And not for the ordinary ones, where a mandatory field is friction that
    // teaches people to type "x".
    expect(requiresReason("role_changed")).toBe(false);
    expect(requiresReason("profile_changed")).toBe(false);
  });
});

describe("what a departing member owns", () => {
  it("names a model and a column for each category", () => {
    expect(new Set(OWNED_CATEGORY_KEYS).size).toBe(OWNED_CATEGORIES.length);
    for (const c of OWNED_CATEGORIES) {
      expect(c.model.length, c.key).toBeGreaterThan(2);
      expect(["ownerId", "assigneeId", "hostUserId", "authorUserId"], c.key).toContain(c.column);
      expect(c.hint.length, c.key).toBeGreaterThan(20);
    }
  });

  it("refuses to leave an open deal or an open task unowned", () => {
    // An unowned open deal is money nobody is chasing; an unassigned open task
    // is work that has quietly become nobody's.
    expect(categoryFor("deals")!.mayUnassign).toBe(false);
    expect(categoryFor("tasks")!.mayUnassign).toBe(false);
  });

  it("refuses to leave a booking page or a saved view unowned", () => {
    // Their columns are NOT NULL: "nobody" is not a state the database holds.
    expect(categoryFor("bookingPages")!.mayUnassign).toBe(false);
    expect(categoryFor("savedViews")!.mayUnassign).toBe(false);
  });

  it("only moves what is still open, where that matters", () => {
    // A closed deal keeps whoever closed it — that is who won it — and a
    // published post keeps its author. Reassigning either falsifies a record.
    expect(categoryFor("deals")!.openOnly).toBe(true);
    expect(categoryFor("tasks")!.openOnly).toBe(true);
    expect(categoryFor("meetings")!.openOnly).toBe(true);
    expect(categoryFor("contentPosts")!.openOnly).toBe(true);
  });

  it("leaves historical attribution out of the list entirely", () => {
    /**
     * The safety argument, asserted. Removal ends somebody's access; it does
     * not rewrite what they did. A call record that changes who made it is a
     * falsified record.
     */
    const columns = OWNED_CATEGORIES.map((c) => c.column);
    expect(columns).not.toContain("byUserId");
    expect(columns).not.toContain("createdBy");
    const models = OWNED_CATEGORIES.map((c) => String(c.model));
    expect(models).not.toContain("activity");
    expect(models).not.toContain("call");
  });
});

describe("validating a reassignment plan before anything is written", () => {
  const counts = { leads: 12, deals: 3, tasks: 5, meetings: 0 };

  it("passes a complete plan", () => {
    expect(
      validatePlan(counts, {
        leads: { kind: "unassign" },
        deals: { kind: "user", userId: "u1" },
        tasks: { kind: "user", userId: "u1" },
      }),
    ).toEqual([]);
  });

  it("asks for a target for every category that has rows", () => {
    const problems = validatePlan(counts, { leads: { kind: "unassign" } });
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toContain("Open deals");
    expect(problems.join(" ")).toContain("Open tasks");
  });

  it("ignores a category with nothing in it", () => {
    // Meetings is zero here, so not choosing a target for it is not a problem.
    expect(validatePlan({ meetings: 0 }, {})).toEqual([]);
  });

  it("refuses unassigning where that is not legal, and says why", () => {
    const problems = validatePlan(counts, {
      leads: { kind: "unassign" },
      deals: { kind: "unassign" },
      tasks: { kind: "unassign" },
    });
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toMatch(/money nobody is chasing/);
    expect(problems.join(" ")).toMatch(/become nobody's/);
  });

  it("reports every problem, not the first", () => {
    // A removal flow that reports one refusal at a time is a form somebody
    // submits five times.
    const problems = validatePlan({ deals: 1, tasks: 1, bookingPages: 1, savedViews: 1 }, {});
    expect(problems.length).toBe(4);
  });

  it("accepts a team as a target", () => {
    expect(
      validatePlan({ deals: 2 }, { deals: { kind: "team", teamId: "t1" } }),
    ).toEqual([]);
  });
});
