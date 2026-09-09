"use server";

import { mkdir, writeFile, unlink } from "node:fs/promises";
import { DENSITIES, toDensity, type Density } from "@/lib/density";
import { join } from "node:path";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { AVATAR_TYPES, MAX_AVATAR_BYTES } from "./profile-limits";

/**
 * A person's own profile — the half of Settings that is about YOU.
 *
 * Everything here is keyed by the session's user id and nothing takes an id
 * from the caller: "my profile" is the only thing these can edit, which is why
 * they need no permission check beyond being signed in. Managing OTHER people
 * is `users/actions.ts`, and that is Owner-gated.
 */
const FILES_DIR = process.env.FILES_DIR ?? "/data/files";
const AVATAR_DIR = "user-avatars";

export interface MyProfile {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  isSuperAdmin: boolean;
  /** Workspaces they belong to, with the role in each. */
  memberships: Array<{ workspace: string; role: string }>;
  lastLoginAt: string | null;
  /** Row density, per user. See src/lib/density.ts for why it is not per device. */
  density: Density;
}

export async function getMyProfile(): Promise<MyProfile> {
  const { userId } = await getActiveContext();
  const user = await prismaUnsafe.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      avatarPath: true,
      density: true,
      isSuperAdmin: true,
      lastLoginAt: true,
      memberships: {
        orderBy: { createdAt: "asc" },
        select: { role: true, workspace: { select: { name: true } } },
      },
    },
  });
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    // Served by id rather than by path: the file is not workspace-owned, so the
    // shared /api/files route (which authorises by owning workspace) cannot
    // answer for it. A cache-buster on the path keeps a replaced photo from
    // showing the old one.
    avatarUrl: user.avatarPath ? `/api/users/${user.id}/avatar?v=${stamp(user.avatarPath)}` : null,
    isSuperAdmin: user.isSuperAdmin,
    memberships: user.memberships.map((m) => ({ workspace: m.workspace.name, role: m.role })),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    density: toDensity(user.density),
  };
}

/** Short, stable per stored file, so the browser refetches after a replace. */
function stamp(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i += 1) h = (h * 31 + path.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

const nameSchema = z.object({ name: z.string().trim().min(1).max(120) });

/**
 * Set the row density.
 *
 * Its own action rather than a field on `updateMyProfile`, because it is a
 * one-click toggle: bundling it into the name form would mean choosing compact
 * required pressing Save on a form you had not otherwise touched.
 *
 * Revalidates the layout, not a page: the shell stamps `data-density` on the
 * whole app, so every open surface has to pick up the change.
 */
export async function setMyDensity(
  raw: unknown,
): Promise<{ ok: true; density: Density } | { ok: false; error: string }> {
  const parsed = z.enum(DENSITIES).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That is not a density." };
  const { userId } = await getActiveContext();
  await prismaUnsafe.user.update({ where: { id: userId }, data: { density: parsed.data } });
  revalidatePath("/", "layout");
  return { ok: true, density: parsed.data };
}

export async function updateMyProfile(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = nameSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Give a name between 1 and 120 characters." };
  const { userId } = await getActiveContext();
  await prismaUnsafe.user.update({ where: { id: userId }, data: { name: parsed.data.name } });
  revalidatePath("/settings");
  return { ok: true };
}

/**
 * Store an uploaded photo.
 *
 * Written under `user-avatars/<userId>.<ext>` — one file per person, replaced in
 * place, so an old photo cannot linger on the volume after a new one is set.
 * The extension can change between uploads, so the previous file is removed
 * when it does.
 */
export async function storeMyAvatar(
  bytes: Uint8Array,
  contentType: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const ext = AVATAR_TYPES[contentType.split(";")[0]!.trim().toLowerCase()];
  if (!ext) return { ok: false, error: "Use a JPEG, PNG or WebP image." };
  if (bytes.byteLength === 0) return { ok: false, error: "That file is empty." };
  if (bytes.byteLength > MAX_AVATAR_BYTES) return { ok: false, error: "Keep the image under 2 MB." };

  const { userId } = await getActiveContext();
  const rel = `${AVATAR_DIR}/${userId}.${ext}`;
  try {
    await mkdir(join(FILES_DIR, AVATAR_DIR), { recursive: true });
    await writeFile(join(FILES_DIR, rel), bytes);
  } catch (e) {
    // The same failure the lead avatars hit: a volume owned by root and an app
    // running as uid 1001. Say which it is rather than "could not store".
    const errno = (e as { code?: string }).code;
    return {
      ok: false,
      error:
        errno === "EACCES" || errno === "EPERM"
          ? "The files volume is not writable by the app user."
          : "Could not store the image.",
    };
  }

  const previous = (
    await prismaUnsafe.user.findUnique({ where: { id: userId }, select: { avatarPath: true } })
  )?.avatarPath;
  await prismaUnsafe.user.update({ where: { id: userId }, data: { avatarPath: rel } });
  if (previous && previous !== rel) {
    await unlink(join(FILES_DIR, previous)).catch(() => {
      /* a leftover file is not worth failing the upload for */
    });
  }
  revalidatePath("/settings");
  return { ok: true, url: `/api/users/${userId}/avatar?v=${stamp(rel)}` };
}

export async function removeMyAvatar(): Promise<{ ok: true }> {
  const { userId } = await getActiveContext();
  const user = await prismaUnsafe.user.findUnique({
    where: { id: userId },
    select: { avatarPath: true },
  });
  if (user?.avatarPath) {
    await unlink(join(FILES_DIR, user.avatarPath)).catch(() => {});
  }
  await prismaUnsafe.user.update({ where: { id: userId }, data: { avatarPath: null } });
  revalidatePath("/settings");
  return { ok: true };
}
