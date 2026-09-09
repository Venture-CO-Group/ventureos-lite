/**
 * What a recent and a favourite are (playbook-v5 P17/2).
 *
 * Inert: the entity vocabulary, the cap, and the ordering. Kept away from the
 * queries so the rules — how many recents a person keeps, what may be pinned,
 * how favourites sort — can be tested without a database.
 */

export const PIN_ENTITIES = [
  "lead",
  "company",
  "deal",
  "task",
  "board",
  "document",
  "audit",
] as const;
export type PinEntity = (typeof PIN_ENTITIES)[number];

export const PIN_KINDS = ["recent", "favourite"] as const;
export type PinKind = (typeof PIN_KINDS)[number];

/**
 * How much history is kept.
 *
 * A rolling window, not a log. Twenty is more than anybody scrolls in a
 * palette and few enough that the sweep is a single delete; an unbounded
 * history would make the one read that has to be instant get slower every
 * week somebody used the product.
 */
export const RECENT_CAP = 20;

/** Favourites are a hand-ordered shortlist, not a second history. */
export const FAVOURITE_CAP = 30;

export function capFor(kind: PinKind): number {
  return kind === "recent" ? RECENT_CAP : FAVOURITE_CAP;
}

export function isPinEntity(value: string): value is PinEntity {
  return (PIN_ENTITIES as readonly string[]).includes(value);
}

export function isPinKind(value: string): value is PinKind {
  return (PIN_KINDS as readonly string[]).includes(value);
}

export interface PinRow {
  entityType: string;
  entityId: string;
  label: string;
  href: string;
  position: number;
  at: Date;
}

/**
 * Sparse positions, so dragging a favourite between two others is one write
 * rather than a renumber of the list — the same trick the task board's columns
 * use.
 */
export const POSITION_STEP = 1024;

export function nextPosition(existing: number[]): number {
  return existing.length === 0 ? POSITION_STEP : Math.max(...existing) + POSITION_STEP;
}

/** The position that puts a row between two others, or null if there is no gap. */
export function positionBetween(before: number | null, after: number | null): number | null {
  if (before === null && after === null) return POSITION_STEP;
  if (before === null) return Math.floor(after! / 2) || null;
  if (after === null) return before + POSITION_STEP;
  if (after - before < 2) return null;
  return Math.floor((before + after) / 2);
}

/**
 * Favourites first, then recents — with anything that is BOTH appearing only
 * once, as a favourite.
 *
 * The playbook asks for favourites to rank first in palette results. A row
 * that is both would otherwise appear twice, which reads as a bug.
 */
export function mergeForPalette(
  favourites: PinRow[],
  recents: PinRow[],
): (PinRow & { favourite: boolean })[] {
  const seen = new Set(favourites.map((f) => `${f.entityType}:${f.entityId}`));
  return [
    ...[...favourites]
      .sort((a, b) => a.position - b.position)
      .map((f) => ({ ...f, favourite: true })),
    ...recents
      .filter((r) => !seen.has(`${r.entityType}:${r.entityId}`))
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .map((r) => ({ ...r, favourite: false })),
  ];
}
