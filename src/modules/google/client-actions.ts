"use server";

/**
 * Server actions for the workspace's "Google connection" panel (item 3).
 *
 * NOTE: nothing but async functions may be exported from a "use server" file.
 *
 * The acting workspace and actor come from the session, never the request:
 * an Owner configures the client of the workspace they are standing in.
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import { isLiveOwner } from "@/modules/workspaces/admin";
import {
  affectedByChange,
  deleteGoogleClient,
  googleClientPanel,
  saveGoogleClient,
  type GoogleClientPanel,
  type SaveResult,
} from "./client-admin";

export async function getGoogleClientPanel(): Promise<GoogleClientPanel | null> {
  const { workspaceId, userId } = await getActiveContext();
  if (!(await isLiveOwner(userId, workspaceId))) return null;
  return googleClientPanel(workspaceId);
}

const clientIdSchema = z
  .string()
  .trim()
  .min(10)
  .max(200)
  .regex(/\.apps\.googleusercontent\.com$/, "A Google client id ends in .apps.googleusercontent.com");

/** How many connections a save (or a delete, with null) would cut. */
export async function previewGoogleClientChange(raw: unknown): Promise<{ affected: number }> {
  const { workspaceId, userId } = await getActiveContext();
  if (!(await isLiveOwner(userId, workspaceId))) return { affected: 0 };
  const parsed = z.object({ clientId: z.string().trim().max(200) }).nullable().safeParse(raw);
  if (!parsed.success) return { affected: 0 };
  return { affected: await affectedByChange(workspaceId, parsed.data) };
}

export async function saveWorkspaceGoogleClient(raw: unknown): Promise<SaveResult> {
  const parsed = z
    .object({
      clientId: clientIdSchema,
      clientSecret: z.string().trim().max(200).default(""),
      confirmAffected: z.number().int().min(0).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the client id and secret." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const res = await saveGoogleClient({ actorId: userId, workspaceId, ...parsed.data });
  if (res.ok) {
    revalidatePath("/settings/email");
    revalidatePath("/settings/admin/integrations");
  }
  return res;
}

export async function removeWorkspaceGoogleClient(
  raw: unknown,
): ReturnType<typeof deleteGoogleClient> {
  const parsed = z.object({ confirmAffected: z.number().int().min(0).optional() }).safeParse(raw);
  const { workspaceId, userId } = await getActiveContext();
  const res = await deleteGoogleClient({
    actorId: userId,
    workspaceId,
    confirmAffected: parsed.success ? parsed.data.confirmAffected : undefined,
  });
  if (res.ok) {
    revalidatePath("/settings/email");
    revalidatePath("/settings/admin/integrations");
  }
  return res;
}
