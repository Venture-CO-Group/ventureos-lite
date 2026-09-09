import { describe, it, expect } from "vitest";
import {
  RELATION_NOTE,
  TASK_EVENT_KINDS,
  TASK_RELATIONS,
  assignmentKind,
  describeTaskEvent,
  isTaskEventKind,
  type TaskEventView,
} from "../../src/modules/tasks/events";

/**
 * Collaborators and delegation (playbook-v5 P20/6).
 *
 * The distinction this file protects is the one the whole item rests on: a
 * first assignment is not a handover. Conflating them makes the delegation
 * trail meaningless on every board where tasks start unassigned — which is
 * most of them.
 */
describe("assignmentKind", () => {
  it("calls the first assignment an assignment, not a delegation", () => {
    expect(assignmentKind(null, "anna")).toBe("assigned");
  });

  it("calls a change of owner a delegation", () => {
    expect(assignmentKind("anna", "bela")).toBe("delegated");
  });

  it("calls taking the owner away an unassignment", () => {
    expect(assignmentKind("anna", null)).toBe("unassigned");
  });

  it("says nothing happened when nothing did", () => {
    // Re-saving a task without touching the assignee must not write a trail
    // row, or the trail fills with events nobody caused.
    expect(assignmentKind("anna", "anna")).toBeNull();
    expect(assignmentKind(null, null)).toBeNull();
  });
});

describe("the trail reads as sentences", () => {
  const base: TaskEventView = {
    id: "e1",
    kind: "assigned",
    at: "2026-09-10T09:00:00.000Z",
    actorName: "Anna",
    userName: "Béla",
    fromName: null,
  };

  it("names the actor and the person it happened to", () => {
    expect(describeTaskEvent(base)).toBe("Anna assigned this to Béla.");
    expect(describeTaskEvent({ ...base, kind: "delegated", fromName: "Csaba" })).toBe(
      "Anna handed this from Csaba to Béla.",
    );
    expect(describeTaskEvent({ ...base, kind: "unassigned" })).toBe(
      "Anna left this unassigned.",
    );
    expect(describeTaskEvent({ ...base, kind: "collaborator_added" })).toBe(
      "Anna added Béla as a collaborator.",
    );
    expect(describeTaskEvent({ ...base, kind: "collaborator_removed" })).toBe(
      "Anna removed Béla as a collaborator.",
    );
  });

  it("says the system did it when nobody did", () => {
    // A workflow rule's reassignment has no actor, and "undefined assigned
    // this" is worse than saying so.
    expect(describeTaskEvent({ ...base, actorName: null })).toBe(
      "The system assigned this to Béla.",
    );
  });

  it("has a sentence for every kind", () => {
    for (const kind of TASK_EVENT_KINDS) {
      expect(isTaskEventKind(kind)).toBe(true);
      expect(() => describeTaskEvent({ ...base, kind }), kind).not.toThrow();
    }
    expect(isTaskEventKind("something_else")).toBe(false);
  });
});

describe("the three relationships", () => {
  it("keeps them distinct, in order of obligation", () => {
    expect(TASK_RELATIONS).toEqual(["assignee", "collaborator", "follower"]);
  });

  it("says something different to each, because it is different news", () => {
    const notes = TASK_RELATIONS.map((r) => RELATION_NOTE[r]);
    expect(new Set(notes).size, "two relationships share a sentence").toBe(3);
    expect(RELATION_NOTE.assignee).toMatch(/own/i);
    expect(RELATION_NOTE.collaborator).toMatch(/working on/i);
    expect(RELATION_NOTE.follower).toMatch(/following/i);
  });
});
