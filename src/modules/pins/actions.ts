"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import { PIN_ENTITIES } from "./logic";
import {
  isFavourite as isFavouriteIn,
  moveFavourite,
  paletteShortcuts,
  recordRecent,
  toggleFavourite,
} from "./store";
import type { PinRow } from "./logic";

const pin = z.object({
  entityType: z.enum(PIN_ENTITIES),
  entityId: z.string().min(1).max(60),
  label: z.string().min(1).max(200),
  /**
   * A path on this app. `/^\//` alone lets `//evil.example` through — a
   * protocol-relative URL that leaves the site — so the second character is
   * excluded too.
   */
  href: z.string().min(1).max(300).regex(/^\/(?![/\\])/),
});

/**
 * Remember that somebody opened something (playbook-v5 P17/2).
 *
 * Called from the client after a detail opens, with nothing awaiting it. A
 * lost recent is a shortcut that did not appear; a slower lead page is worse.
 * No revalidation, for the same reason.
 */
export async function noteOpened(raw: unknown): Promise<void> {
  const parsed = pin.safeParse(raw);
  if (!parsed.success) return;
  const { workspaceId, userId } = await getActiveContext();
  await recordRecent(workspaceId, userId, parsed.data);
}

export async function toggleFavouriteAction(
  raw: unknown,
): Promise<{ ok: true; favourite: boolean } | { ok: false; error: string }> {
  const parsed = pin.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That cannot be starred." };
  const { workspaceId, userId } = await getActiveContext();
  const res = await toggleFavourite(workspaceId, userId, parsed.data);
  // The sidebar's favourites list lives in the shell, so the whole layout has
  // to pick this up.
  revalidatePath("/", "layout");
  return { ok: true, favourite: res.favourite };
}

export async function getPaletteShortcuts(): Promise<
  (Omit<PinRow, "at"> & { at: string; favourite: boolean })[]
> {
  const { workspaceId, userId } = await getActiveContext();
  const rows = await paletteShortcuts(workspaceId, userId);
  return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
}

export async function isFavourited(entityType: string, entityId: string): Promise<boolean> {
  const parsed = z.enum(PIN_ENTITIES).safeParse(entityType);
  if (!parsed.success) return false;
  const { workspaceId, userId } = await getActiveContext();
  return isFavouriteIn(workspaceId, userId, parsed.data, entityId);
}

export async function reorderFavourite(raw: unknown): Promise<{ ok: true }> {
  const parsed = z
    .object({
      entityType: z.enum(PIN_ENTITIES),
      entityId: z.string().min(1).max(60),
      position: z.number().int().min(0).max(10_000_000),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: true };
  const { workspaceId, userId } = await getActiveContext();
  await moveFavourite(
    workspaceId,
    userId,
    parsed.data.entityId,
    parsed.data.entityType,
    parsed.data.position,
  );
  revalidatePath("/", "layout");
  return { ok: true };
}
