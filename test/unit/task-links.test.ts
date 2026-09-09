import { describe, it, expect } from "vitest";
import {
  ENTITY_KINDS,
  ENTITY_NOUN,
  chipFor,
  entityHref,
  isEntityKind,
  refsForTask,
  taskHref,
} from "../../src/modules/tasks/links";
import { isInternalPath, returnPath } from "../../src/lib/paths";

/**
 * What a task is about (playbook-v5 P20/4).
 *
 * The database side is in test/integration/task-links.test.ts. This is the
 * vocabulary: the label-and-href chain that used to be written out three times
 * in three files with three different sets of cases.
 */
describe("the entity vocabulary", () => {
  it("has a noun for every kind, and rejects anything else", () => {
    for (const kind of ENTITY_KINDS) {
      expect(ENTITY_NOUN[kind], `${kind} has no noun`).toBeTruthy();
      expect(isEntityKind(kind)).toBe(true);
    }
    expect(isEntityKind("invoice")).toBe(false);
    expect(isEntityKind(null)).toBe(false);
    expect(isEntityKind(undefined)).toBe(false);
    expect(isEntityKind("")).toBe(false);
  });

  it("points every kind somewhere a page actually reads", () => {
    expect(entityHref("lead", "l1")).toBe("/leads?lead=l1");
    expect(entityHref("company", "c1")).toBe("/leads?company=c1");
    expect(entityHref("deal", "d1")).toBe("/deals?deal=d1");
    expect(entityHref("project", "p1")).toBe("/projects?project=p1");
    expect(entityHref("document", "doc1")).toBe("/documents?doc=doc1");
  });

  it("carries the way back, encoded", () => {
    // The return path contains its own query string, so it has to survive
    // being put inside one.
    const href = entityHref("company", "c1", "/tasks?board=b1&task=t1");
    expect(href).toBe("/leads?company=c1&from=%2Ftasks%3Fboard%3Db1%26task%3Dt1");
    expect(decodeURIComponent(href.split("from=")[1])).toBe("/tasks?board=b1&task=t1");
  });

  it("sends a loose task to My Work rather than to a board it has not got", () => {
    expect(taskHref({ id: "t1", boardId: "b1" })).toBe("/tasks?board=b1&task=t1");
    // My Work is a VIEW of the tasks page, not a route: `v=mine` is the key
    // the board's view state actually reads.
    expect(taskHref({ id: "t1", boardId: null })).toBe("/tasks?v=mine&task=t1");
  });
});

describe("chipFor", () => {
  const labels = {
    lead: new Map([["l1", "Kis Béla"]]),
    company: new Map([["c1", "Acme Kft"]]),
  };

  it("resolves the label from the map it was given", () => {
    expect(chipFor({ entityType: "lead", entityId: "l1" }, labels)).toEqual({
      label: "Kis Béla",
      href: "/leads?lead=l1",
    });
  });

  it("falls back to the noun rather than a blank chip", () => {
    // A document or a project has no label map here; the chip still says what
    // kind of thing it is and still opens it.
    expect(chipFor({ entityType: "document", entityId: "doc1" }, labels)).toEqual({
      label: "document",
      href: "/documents?doc=doc1",
    });
    expect(chipFor({ entityType: "lead", entityId: "unknown" }, labels).label).toBe("lead");
  });

  it("says nothing for a task about nothing, and for a kind it does not know", () => {
    expect(chipFor({ entityType: null, entityId: null }, labels)).toEqual({
      label: null,
      href: null,
    });
    expect(chipFor({ entityType: "lead", entityId: null }, labels).href).toBeNull();
    // A stale value in the column must not become a link to /undefined.
    expect(chipFor({ entityType: "invoice", entityId: "i1" }, labels)).toEqual({
      label: null,
      href: null,
    });
  });
});

describe("refsForTask", () => {
  const task = { id: "t1", entityType: "deal", entityId: "d1" };

  it("puts the task's own entity first and marks it primary", () => {
    const refs = refsForTask(task, [
      { taskId: "t1", entityType: "company", entityId: "c1" },
    ]);
    expect(refs).toEqual([
      { kind: "deal", id: "d1", primary: true },
      { kind: "company", id: "c1", primary: false },
    ]);
  });

  it("ignores link rows belonging to other tasks", () => {
    const refs = refsForTask(task, [
      { taskId: "t2", entityType: "company", entityId: "c1" },
    ]);
    expect(refs).toEqual([{ kind: "deal", id: "d1", primary: true }]);
  });

  it("shows a double-recorded link once, as the primary", () => {
    // The columns and a link row can name the same entity. It is one
    // relationship, and the one the columns enforce is the truthful label.
    const refs = refsForTask(task, [{ taskId: "t1", entityType: "deal", entityId: "d1" }]);
    expect(refs).toEqual([{ kind: "deal", id: "d1", primary: true }]);
  });

  it("works for a task about nothing that has been linked anyway", () => {
    const refs = refsForTask({ id: "t1", entityType: null, entityId: null }, [
      { taskId: "t1", entityType: "lead", entityId: "l1" },
    ]);
    expect(refs).toEqual([{ kind: "lead", id: "l1", primary: false }]);
  });

  it("drops a link row whose kind is not one we know", () => {
    const refs = refsForTask({ id: "t1", entityType: null, entityId: null }, [
      { taskId: "t1", entityType: "spreadsheet", entityId: "s1" },
    ]);
    expect(refs).toEqual([]);
  });
});

describe("the return path", () => {
  it("accepts a path on this app", () => {
    expect(returnPath("/leads?lead=l1")).toBe("/leads?lead=l1");
    expect(isInternalPath("/tasks")).toBe(true);
  });

  it("refuses anything that could point at another origin", () => {
    // A "back" button that can be aimed elsewhere is an open redirect with a
    // friendly label.
    expect(returnPath("//evil.example/x")).toBeNull();
    expect(returnPath("/\\evil.example")).toBeNull();
    expect(returnPath("https://evil.example")).toBeNull();
    expect(returnPath("javascript:alert(1)")).toBeNull();
    expect(returnPath("leads")).toBeNull();
    expect(returnPath("")).toBeNull();
    expect(returnPath(null)).toBeNull();
    expect(returnPath(undefined)).toBeNull();
  });

  it("bounds the length, because it arrives in a query string", () => {
    const long = `/leads?q=${"x".repeat(500)}`;
    expect(returnPath(long)!.length).toBe(300);
  });
});
