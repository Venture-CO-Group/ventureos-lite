import { describe, it, expect } from "vitest";
import {
  boolField,
  decodeView,
  encodeView,
  enumField,
  historyModeFor,
  idField,
  numField,
  setField,
  textField,
  viewQuery,
} from "../../src/lib/client/view-state";

/**
 * The URL codec (playbook-v5 P16/5).
 *
 * Parsing is TOTAL — every field returns its default for a missing or
 * malformed value and never throws. A query string is the most hostile input a
 * page takes: it arrives from a bookmark written months ago, from a link
 * somebody edited by hand, from a crawler appending nonsense. A surface must
 * not be able to 500 or to render a state it has no branch for.
 */
const TASKS = {
  view: enumField("v", ["board", "list"] as const, "board"),
  mineOnly: boolField("mine"),
  showDone: boolField("done"),
  openTask: idField("task"),
  page: numField("p", 1, { min: 1, max: 999 }),
  query: textField("q"),
  tags: setField("tag", ["seo", "audit", "content"]),
};

describe("reading a view out of a URL", () => {
  it("gives every field its default for an empty query", () => {
    expect(decodeView(TASKS, "")).toEqual({
      view: "board",
      mineOnly: false,
      showDone: false,
      openTask: null,
      page: 1,
      query: "",
      tags: [],
    });
  });

  it("reads what is there", () => {
    const v = decodeView(TASKS, "v=list&mine=1&task=abc123&p=4&q=seo%20audit&tag=seo,audit");
    expect(v.view).toBe("list");
    expect(v.mineOnly).toBe(true);
    expect(v.openTask).toBe("abc123");
    expect(v.page).toBe(4);
    expect(v.query).toBe("seo audit");
    expect(v.tags).toEqual(["seo", "audit"]);
  });

  describe("hostile input falls back rather than breaking", () => {
    it("an unknown enum value is the default", () => {
      // Otherwise a hand-edited URL puts the surface in a state it cannot render.
      expect(decodeView(TASKS, "v=timeline").view).toBe("board");
    });

    it("a number that is not one is the default", () => {
      expect(decodeView(TASKS, "p=banana").page).toBe(1);
      expect(decodeView(TASKS, "p=").page).toBe(1);
    });

    it("a number out of range clamps", () => {
      expect(decodeView(TASKS, "p=-5").page).toBe(1);
      expect(decodeView(TASKS, "p=99999").page).toBe(999);
      expect(decodeView(TASKS, "p=3.7").page).toBe(3);
    });

    it("an absurdly long id is refused", () => {
      expect(decodeView(TASKS, `task=${"x".repeat(5000)}`).openTask).toBeNull();
    });

    it("unknown members of a set are dropped, and duplicates collapse", () => {
      expect(decodeView(TASKS, "tag=seo,nope,seo,audit").tags).toEqual(["seo", "audit"]);
    });

    it("free text is bounded", () => {
      expect(decodeView(TASKS, `q=${"a".repeat(500)}`).query.length).toBe(120);
    });

    it("a flag only reads as on for a value that means on", () => {
      expect(decodeView(TASKS, "mine=1").mineOnly).toBe(true);
      expect(decodeView(TASKS, "mine=true").mineOnly).toBe(true);
      expect(decodeView(TASKS, "mine=0").mineOnly).toBe(false);
      expect(decodeView(TASKS, "mine=yes").mineOnly).toBe(false);
    });
  });
});

describe("writing a view into a URL", () => {
  /**
   * The rule that keeps links readable, and keeps two identical views from
   * producing two different URLs.
   */
  it("omits everything sitting at its default", () => {
    expect(viewQuery(TASKS, { view: "board", mineOnly: false, page: 1, query: "" })).toBe("");
  });

  it("writes only what changed", () => {
    expect(viewQuery(TASKS, { view: "list", mineOnly: true })).toBe("?v=list&mine=1");
  });

  it("removes a key when it goes back to its default", () => {
    expect(viewQuery(TASKS, { view: "board" }, "v=list&mine=1")).toBe("?mine=1");
  });

  /**
   * `?task=` arrives from notification links, and a view update must not drop
   * it — that was a real bug class before this: changing a filter silently
   * closed the card a notification had opened.
   */
  it("keeps parameters it does not own", () => {
    const q = viewQuery(TASKS, { view: "list" }, "board=b1&utm_source=email");
    expect(q).toContain("board=b1");
    expect(q).toContain("utm_source=email");
    expect(q).toContain("v=list");
  });

  it("does not touch fields that are not in the patch", () => {
    const params = encodeView(TASKS, { mineOnly: true }, "v=list");
    expect(params.get("v")).toBe("list");
    expect(params.get("mine")).toBe("1");
  });

  it("round-trips", () => {
    const before = decodeView(TASKS, "v=list&mine=1&task=t1&p=3&q=hello&tag=audit");
    const after = decodeView(TASKS, viewQuery(TASKS, before).slice(1));
    expect(after).toEqual(before);
  });

  it("trims free text and drops it when it is only whitespace", () => {
    expect(viewQuery(TASKS, { query: "   " })).toBe("");
    expect(viewQuery(TASKS, { query: "  seo  " })).toBe("?q=seo");
  });
});

describe("what Back should undo", () => {
  /** Opening a card pushes, so Back closes it instead of leaving the page. */
  it("pushes for a detail item", () => {
    expect(historyModeFor(TASKS, { openTask: "abc" })).toBe("push");
  });

  it("pushes for a tab or view switch", () => {
    expect(historyModeFor(TASKS, { view: "list" })).toBe("push");
  });

  /** Four toggles must not mean four presses of Back to leave the page. */
  it("replaces for a filter", () => {
    expect(historyModeFor(TASKS, { mineOnly: true })).toBe("replace");
    expect(historyModeFor(TASKS, { page: 3 })).toBe("replace");
  });

  /**
   * A patch that changes both: push wins. The surprising failure is Back not
   * undoing something it should, not one extra history entry.
   */
  it("pushes when a patch mixes the two", () => {
    expect(historyModeFor(TASKS, { mineOnly: true, openTask: "abc" })).toBe("push");
  });

  it("replaces for a field nobody declared", () => {
    expect(historyModeFor(TASKS, { nope: 1 } as never)).toBe("replace");
  });
});
