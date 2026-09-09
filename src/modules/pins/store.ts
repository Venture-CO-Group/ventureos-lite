/**
 * Recents and favourites, against the database (playbook-v5 P17/2).
 *
 * ── NOT ON THE CRITICAL RENDER PATH ─────────────────────────────────────────
 *
 * The playbook is explicit: recents must never add a query to a page render.
 * So nothing here is called while a screen is being built. Recording happens
 * when somebody OPENS something, from the client, without anything waiting on
 * it — a lost recent is a shortcut that did not appear, which is nothing next
 * to a slower lead page. Reading happens in exactly two places: the command
 * palette and the sidebar's favourites list.
 *
 * ── SCOPED PER WORKSPACE ────────────────────────────────────────────────────
 *
 * A person's shortcuts in one workspace have no business appearing in another,
 * and the rows go when their membership does — which `forgetPinsForMember`
 * does, called from the removal flow.
 */

import { getWorkspaceClient } from "@/lib/db";
import { isInternalPath } from "@/lib/paths";
import {
  capFor,
  isPinEntity,
  mergeForPalette,
  nextPosition,
  type PinEntity,
  type PinKind,
  type PinRow,
} from "./logic";

export { isInternalPath };

export async function recordRecent(
  workspaceId: string,
  userId: string,
  input: { entityType: string; entityId: string; label: string; href: string },
): Promise<void> {
  if (!isPinEntity(input.entityType)) return;
  const label = input.label.trim().slice(0, 200);
  if (!label) return;
  /**
   * A path on this app, and nothing else.
   *
   * A stored href is rendered as a link, so a bad write must not be able to
   * turn a shortcut into an off-site redirect. `startsWith("/")` alone is NOT
   * enough — which the test found: `//evil.example` starts with a slash and is
   * a protocol-relative URL that leaves the site. A backslash after the slash
   * is the same trick in browsers that normalise it.
   */
  if (!isInternalPath(input.href)) return;

  const db = getWorkspaceClient(workspaceId);
  await db.userPin.upsert({
    where: {
      userId_workspaceId_kind_entityType_entityId: {
        userId,
        workspaceId,
        kind: "recent",
        entityType: input.entityType,
        entityId: input.entityId,
      },
    },
    // Opening something twice moves it up the list rather than growing it.
    update: { at: new Date(), label, href: input.href.slice(0, 300) },
    create: {
      workspaceId,
      userId,
      kind: "recent",
      entityType: input.entityType,
      entityId: input.entityId,
      label,
      href: input.href.slice(0, 300),
    },
  });

  await trim(workspaceId, userId, "recent");
}

/** The rolling window. Anything past the cap goes. */
async function trim(workspaceId: string, userId: string, kind: PinKind): Promise<void> {
  const db = getWorkspaceClient(workspaceId);
  const keep = await db.userPin.findMany({
    where: { userId, kind },
    orderBy: { at: "desc" },
    take: capFor(kind),
    select: { id: true },
  });
  await db.userPin.deleteMany({
    where: { userId, kind, id: { notIn: keep.map((k) => k.id) } },
  });
}

export async function toggleFavourite(
  workspaceId: string,
  userId: string,
  input: { entityType: string; entityId: string; label: string; href: string },
): Promise<{ favourite: boolean }> {
  if (!isPinEntity(input.entityType)) return { favourite: false };
  if (!isInternalPath(input.href)) return { favourite: false };
  const db = getWorkspaceClient(workspaceId);
  const where = {
    userId_workspaceId_kind_entityType_entityId: {
      userId,
      workspaceId,
      kind: "favourite",
      entityType: input.entityType,
      entityId: input.entityId,
    },
  };
  const existing = await db.userPin.findUnique({ where });
  if (existing) {
    await db.userPin.delete({ where });
    return { favourite: false };
  }

  const siblings = await db.userPin.findMany({
    where: { userId, kind: "favourite" },
    select: { position: true },
  });
  if (siblings.length >= capFor("favourite")) {
    // Refused rather than silently dropping the oldest: a favourite is a
    // deliberate choice, so losing one without being told is worse than being
    // asked to remove one.
    return { favourite: false };
  }

  await db.userPin.create({
    data: {
      workspaceId,
      userId,
      kind: "favourite",
      entityType: input.entityType,
      entityId: input.entityId,
      label: input.label.trim().slice(0, 200),
      href: input.href.slice(0, 300),
      position: nextPosition(siblings.map((s) => s.position)),
    },
  });
  return { favourite: true };
}

export async function listPins(
  workspaceId: string,
  userId: string,
  kind: PinKind,
): Promise<PinRow[]> {
  const db = getWorkspaceClient(workspaceId);
  return db.userPin.findMany({
    where: { userId, kind },
    orderBy: kind === "recent" ? { at: "desc" } : { position: "asc" },
    take: capFor(kind),
    select: { entityType: true, entityId: true, label: true, href: true, position: true, at: true },
  });
}

/** What the palette shows on an empty query: favourites first, then recents. */
export async function paletteShortcuts(
  workspaceId: string,
  userId: string,
): Promise<(PinRow & { favourite: boolean })[]> {
  const [favourites, recents] = await Promise.all([
    listPins(workspaceId, userId, "favourite"),
    listPins(workspaceId, userId, "recent"),
  ]);
  return mergeForPalette(favourites, recents);
}

export async function isFavourite(
  workspaceId: string,
  userId: string,
  entityType: PinEntity,
  entityId: string,
): Promise<boolean> {
  const db = getWorkspaceClient(workspaceId);
  const row = await db.userPin.findUnique({
    where: {
      userId_workspaceId_kind_entityType_entityId: {
        userId,
        workspaceId,
        kind: "favourite",
        entityType,
        entityId,
      },
    },
    select: { id: true },
  });
  return row !== null;
}

/** Reorder a favourite. Sparse positions, so this is one write. */
export async function moveFavourite(
  workspaceId: string,
  userId: string,
  entityId: string,
  entityType: string,
  position: number,
): Promise<void> {
  const db = getWorkspaceClient(workspaceId);
  await db.userPin.updateMany({
    where: { userId, kind: "favourite", entityType, entityId },
    data: { position },
  });
}

/**
 * Everything this person kept in this workspace, gone.
 *
 * Called when a membership ends. Their shortcuts are a record of what they
 * were working on, and it has no business surviving their access.
 */
export async function forgetPinsForMember(workspaceId: string, userId: string): Promise<number> {
  const db = getWorkspaceClient(workspaceId);
  const { count } = await db.userPin.deleteMany({ where: { userId } });
  return count;
}
