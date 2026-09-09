import { describe, it, expect } from "vitest";
import {
  CHECKLIST,
  TOUR_STEPS,
  checklistComplete,
  checklistProgress,
  type ChecklistState,
} from "../../src/modules/onboarding/tour";

/**
 * The tour and the getting-started checklist (playbook-v2 P7/4).
 *
 * Small surface, but two things are worth pinning: the checklist must be
 * DERIVED (so it cannot claim a lead exists after the last one is deleted), and
 * every tour step must point somewhere real.
 */
/**
 * Built from CHECKLIST rather than listed by hand.
 *
 * Adding a step used to break these two fixtures and nothing else, which is
 * backwards: the fixtures should follow the list so a new step is covered the
 * moment it is added.
 */
const NONE: ChecklistState = Object.fromEntries(
  CHECKLIST.map((i) => [i.id, false]),
) as ChecklistState;
const ALL: ChecklistState = Object.fromEntries(
  CHECKLIST.map((i) => [i.id, true]),
) as ChecklistState;

describe("the tour", () => {
  /**
   * The upper bound went from 6 to 9 when the tour gained steps for tasks,
   * deals and the content hub (playbook-v5 P17/3) — a tour that stops at the
   * features of six months ago teaches a smaller product than the one
   * somebody just signed into. The lower bound is what matters: it must not
   * shrink back to a stub.
   */
  it("walks at least the five steps the playbook asks for, and stays a tour", () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(5);
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(9);
  });

  it("walks the daily loop in order, ending at Settings", () => {
    expect(TOUR_STEPS[0].href).toBe("/");
    expect(TOUR_STEPS.at(-1)!.href).toBe("/settings");
    expect(TOUR_STEPS.map((s) => s.href)).toContain("/pipeline");
  });

  it("has a lowercase headline on every step, matching the prototype's voice", () => {
    for (const step of TOUR_STEPS) {
      expect(step.title, step.id).toBe(step.title.toLowerCase());
      expect(step.body.length, step.id).toBeGreaterThan(40);
    }
  });

  it("gives every step a distinct id", () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the checklist", () => {
  /**
   * The five playbook-v5 P17/3 names, plus connecting a mailbox.
   *
   * That sixth one is deliberate: it is not in the playbook's list, but a
   * connected mailbox is what makes replies thread onto the lead they belong
   * to, and dropping a real step to match a count would be the wrong kind of
   * tidy.
   */
  it("covers the five steps the playbook names, in the order somebody does them", () => {
    const ids = CHECKLIST.map((i) => i.id);
    for (const required of [
      "install_extension",
      "first_lead",
      "first_audit",
      "first_meeting",
      "first_post",
    ]) {
      expect(ids, required).toContain(required);
    }
    // Capture before anything can be captured about; the post comes last.
    expect(ids.indexOf("install_extension")).toBeLessThan(ids.indexOf("first_lead"));
    expect(ids.indexOf("first_lead")).toBeLessThan(ids.indexOf("first_audit"));
    expect(ids.at(-1)).toBe("first_post");
  });

  it("counts progress, and is complete only when everything is", () => {
    const total = CHECKLIST.length;
    expect(checklistProgress(NONE)).toEqual({ done: 0, total });
    expect(checklistComplete(NONE)).toBe(false);

    const partial = { ...NONE, first_lead: true, first_audit: true };
    expect(checklistProgress(partial)).toEqual({ done: 2, total });
    expect(checklistComplete(partial)).toBe(false);

    expect(checklistProgress(ALL)).toEqual({ done: total, total });
    expect(checklistComplete(ALL)).toBe(true);
  });

  it("sends every item somewhere it can actually be done", () => {
    for (const item of CHECKLIST) {
      expect(item.href, item.id).toMatch(/^\//);
      expect(item.hint.length, item.id).toBeGreaterThan(10);
    }
  });
});
