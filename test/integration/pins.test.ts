import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { RECENT_CAP, FAVOURITE_CAP } from "../../src/modules/pins/logic";
import {
  forgetPinsForMember,
  isFavourite,
  listPins,
  paletteShortcuts,
  recordRecent,
  toggleFavourite,
} from "../../src/modules/pins/store";

/**
 * Recents and favourites, against a real database (playbook-v5 P17/2).
 *
 * The requirements with teeth: the history is CAPPED (a growing table would
 * make the one read that has to be instant slower every week), the rows are
 * scoped per WORKSPACE, and they go when a membership does.
 */
const WS = "Pins WS";
const OTHER = "Pins Other WS";
let workspaceId = "";
let otherWorkspaceId = "";
const userId = "pins-user";
const otherUserId = "pins-other-user";

beforeAll(async () => {
  const ws =
    (await prismaUnsafe.workspace.findFirst({ where: { name: WS } })) ??
    (await prismaUnsafe.workspace.create({ data: { name: WS } }));
  workspaceId = ws.id;
  const other =
    (await prismaUnsafe.workspace.findFirst({ where: { name: OTHER } })) ??
    (await prismaUnsafe.workspace.create({ data: { name: OTHER } }));
  otherWorkspaceId = other.id;
});

beforeEach(async () => {
  await prismaUnsafe.userPin.deleteMany({
    where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
  });
});

afterAll(async () => {
  await prismaUnsafe.userPin.deleteMany({
    where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
  });
});

const lead = (id: string, label = `Lead ${id}`) => ({
  entityType: "lead",
  entityId: id,
  label,
  href: `/leads?lead=${id}`,
});

describe("recording what was opened", () => {
  it("keeps it, newest first", async () => {
    await recordRecent(workspaceId, userId, lead("a"));
    await recordRecent(workspaceId, userId, lead("b"));
    const rows = await listPins(workspaceId, userId, "recent");
    expect(rows.map((r) => r.entityId)).toEqual(["b", "a"]);
  });

  /** Opening something twice moves it up rather than growing the history. */
  it("does not duplicate a second visit", async () => {
    await recordRecent(workspaceId, userId, lead("a"));
    await recordRecent(workspaceId, userId, lead("b"));
    await recordRecent(workspaceId, userId, lead("a"));
    const rows = await listPins(workspaceId, userId, "recent");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.entityId).toBe("a");
  });

  /**
   * The cap is the point: an unbounded history would make the palette's one
   * instant read get slower every week somebody used the product.
   */
  it("keeps only the most recent N", async () => {
    for (let i = 0; i < RECENT_CAP + 8; i++) {
      await recordRecent(workspaceId, userId, lead(`x${i}`));
    }
    const rows = await listPins(workspaceId, userId, "recent");
    expect(rows).toHaveLength(RECENT_CAP);
    // The oldest are the ones that went.
    expect(rows.some((r) => r.entityId === "x0")).toBe(false);
    expect(rows[0]!.entityId).toBe(`x${RECENT_CAP + 7}`);
  });

  it("refuses an entity type nothing can open", async () => {
    await recordRecent(workspaceId, userId, {
      entityType: "workspace",
      entityId: "w1",
      label: "A workspace",
      href: "/settings",
    });
    expect(await listPins(workspaceId, userId, "recent")).toHaveLength(0);
  });

  /**
   * A stored href is rendered as a link, so an absolute one would let a bad
   * write turn a shortcut into an off-site redirect.
   */
  it("refuses an href that is not a path on this app", async () => {
    for (const href of ["https://evil.example/x", "//evil.example", "javascript:alert(1)"]) {
      await recordRecent(workspaceId, userId, { ...lead("z"), href });
    }
    expect(await listPins(workspaceId, userId, "recent")).toHaveLength(0);
  });

  it("refuses a label that is only whitespace", async () => {
    await recordRecent(workspaceId, userId, { ...lead("s"), label: "   " });
    expect(await listPins(workspaceId, userId, "recent")).toHaveLength(0);
  });
});

describe("starring", () => {
  it("goes on and off", async () => {
    expect((await toggleFavourite(workspaceId, userId, lead("a"))).favourite).toBe(true);
    expect(await isFavourite(workspaceId, userId, "lead", "a")).toBe(true);
    expect((await toggleFavourite(workspaceId, userId, lead("a"))).favourite).toBe(false);
    expect(await isFavourite(workspaceId, userId, "lead", "a")).toBe(false);
  });

  it("hand-orders with sparse positions", async () => {
    await toggleFavourite(workspaceId, userId, lead("a"));
    await toggleFavourite(workspaceId, userId, lead("b"));
    const rows = await listPins(workspaceId, userId, "favourite");
    expect(rows.map((r) => r.position)).toEqual([1024, 2048]);
  });

  /**
   * Refused at the cap rather than dropping the oldest. A favourite is a
   * deliberate choice, so losing one without being told is worse than being
   * asked to remove one.
   */
  it("refuses past the cap rather than evicting", async () => {
    for (let i = 0; i < FAVOURITE_CAP; i++) {
      await toggleFavourite(workspaceId, userId, lead(`f${i}`));
    }
    const res = await toggleFavourite(workspaceId, userId, lead("one-too-many"));
    expect(res.favourite).toBe(false);
    expect(await listPins(workspaceId, userId, "favourite")).toHaveLength(FAVOURITE_CAP);
    expect(await isFavourite(workspaceId, userId, "lead", "f0")).toBe(true);
  });

  /** Starring does not also make something "recent" — they are separate facts. */
  it("does not touch the recent list", async () => {
    await toggleFavourite(workspaceId, userId, lead("a"));
    expect(await listPins(workspaceId, userId, "recent")).toHaveLength(0);
  });
});

describe("the palette's empty-query list", () => {
  it("is favourites then recents, with a shared row appearing once", async () => {
    await recordRecent(workspaceId, userId, lead("both", "Both"));
    await recordRecent(workspaceId, userId, lead("only", "Only recent"));
    await toggleFavourite(workspaceId, userId, lead("both", "Both"));

    const rows = await paletteShortcuts(workspaceId, userId);
    expect(rows.map((r) => r.label)).toEqual(["Both", "Only recent"]);
    expect(rows[0]!.favourite).toBe(true);
  });
});

describe("scoping", () => {
  /** Shortcuts in one workspace have no business appearing in another. */
  it("keeps workspaces apart", async () => {
    await recordRecent(workspaceId, userId, lead("mine"));
    await recordRecent(otherWorkspaceId, userId, lead("theirs"));
    expect((await listPins(workspaceId, userId, "recent")).map((r) => r.entityId)).toEqual([
      "mine",
    ]);
    expect((await listPins(otherWorkspaceId, userId, "recent")).map((r) => r.entityId)).toEqual([
      "theirs",
    ]);
  });

  it("keeps people apart", async () => {
    await recordRecent(workspaceId, userId, lead("mine"));
    await recordRecent(workspaceId, otherUserId, lead("theirs"));
    expect(await listPins(workspaceId, userId, "recent")).toHaveLength(1);
    expect(await listPins(workspaceId, otherUserId, "recent")).toHaveLength(1);
  });

  /**
   * And they go when the membership does. A record of what somebody was
   * working on must not survive their access.
   */
  it("forgets everything for a member who is removed", async () => {
    await recordRecent(workspaceId, userId, lead("a"));
    await toggleFavourite(workspaceId, userId, lead("b"));
    await recordRecent(workspaceId, otherUserId, lead("c"));

    const gone = await forgetPinsForMember(workspaceId, userId);
    expect(gone).toBe(2);
    expect(await listPins(workspaceId, userId, "recent")).toHaveLength(0);
    expect(await listPins(workspaceId, userId, "favourite")).toHaveLength(0);
    // Somebody else's are untouched.
    expect(await listPins(workspaceId, otherUserId, "recent")).toHaveLength(1);
  });
});
