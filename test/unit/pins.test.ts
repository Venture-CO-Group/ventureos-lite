import { describe, it, expect } from "vitest";
import {
  FAVOURITE_CAP,
  RECENT_CAP,
  capFor,
  isPinEntity,
  isPinKind,
  mergeForPalette,
  nextPosition,
  positionBetween,
  type PinRow,
} from "../../src/modules/pins/logic";

function row(over: Partial<PinRow> = {}): PinRow {
  return {
    entityType: "lead",
    entityId: "l1",
    label: "A lead",
    href: "/leads?lead=l1",
    position: 1024,
    at: new Date("2026-09-01T10:00:00Z"),
    ...over,
  };
}

describe("what may be pinned", () => {
  it("knows the entity vocabulary", () => {
    for (const e of ["lead", "company", "deal", "task", "board", "document", "audit"]) {
      expect(isPinEntity(e)).toBe(true);
    }
    // Anything else is refused rather than stored: a pin renders a link, and
    // an unknown type is a row nothing can open.
    expect(isPinEntity("workspace")).toBe(false);
    expect(isPinEntity("")).toBe(false);
  });

  it("knows the two kinds", () => {
    expect(isPinKind("recent")).toBe(true);
    expect(isPinKind("favourite")).toBe(true);
    expect(isPinKind("pinned")).toBe(false);
  });

  /** A rolling window, not a log — the palette read has to stay instant. */
  it("caps each kind", () => {
    expect(capFor("recent")).toBe(RECENT_CAP);
    expect(capFor("favourite")).toBe(FAVOURITE_CAP);
    expect(RECENT_CAP).toBeGreaterThan(5);
    expect(RECENT_CAP).toBeLessThanOrEqual(50);
  });
});

describe("ordering favourites", () => {
  it("spaces new positions so a drop between two is one write", () => {
    expect(nextPosition([])).toBe(1024);
    expect(nextPosition([1024])).toBe(2048);
    expect(nextPosition([1024, 3072])).toBe(4096);
  });

  it("finds the midpoint between two neighbours", () => {
    expect(positionBetween(1024, 2048)).toBe(1536);
    expect(positionBetween(null, 2048)).toBe(1024);
    expect(positionBetween(2048, null)).toBe(3072);
    expect(positionBetween(null, null)).toBe(1024);
  });

  /** No gap left: the caller renumbers rather than writing a duplicate. */
  it("says when there is no room", () => {
    expect(positionBetween(1024, 1025)).toBeNull();
    expect(positionBetween(1024, 1024)).toBeNull();
  });
});

describe("what the palette shows on an empty query", () => {
  it("puts favourites first, in their hand order", () => {
    const merged = mergeForPalette(
      [
        row({ entityId: "f2", label: "Second", position: 2048 }),
        row({ entityId: "f1", label: "First", position: 1024 }),
      ],
      [],
    );
    expect(merged.map((m) => m.label)).toEqual(["First", "Second"]);
    expect(merged.every((m) => m.favourite)).toBe(true);
  });

  it("puts recents after them, newest first", () => {
    const merged = mergeForPalette(
      [],
      [
        row({ entityId: "r1", label: "Older", at: new Date("2026-09-01T09:00:00Z") }),
        row({ entityId: "r2", label: "Newer", at: new Date("2026-09-01T11:00:00Z") }),
      ],
    );
    expect(merged.map((m) => m.label)).toEqual(["Newer", "Older"]);
    expect(merged.every((m) => !m.favourite)).toBe(true);
  });

  /**
   * The one that would read as a bug: something both starred AND recently
   * opened must appear once, as a favourite.
   */
  it("shows a row that is both only once", () => {
    const both = row({ entityId: "x", label: "Both" });
    const merged = mergeForPalette([both], [both, row({ entityId: "y", label: "Only recent" })]);
    expect(merged.filter((m) => m.entityId === "x")).toHaveLength(1);
    expect(merged.find((m) => m.entityId === "x")!.favourite).toBe(true);
    expect(merged.map((m) => m.label)).toEqual(["Both", "Only recent"]);
  });

  it("is empty for somebody who has opened nothing", () => {
    expect(mergeForPalette([], [])).toEqual([]);
  });

  /** Same entity id, different type, is a different thing. */
  it("does not confuse a lead and a task that share an id", () => {
    const merged = mergeForPalette(
      [row({ entityType: "lead", entityId: "same", label: "The lead" })],
      [row({ entityType: "task", entityId: "same", label: "The task" })],
    );
    expect(merged).toHaveLength(2);
  });
});
