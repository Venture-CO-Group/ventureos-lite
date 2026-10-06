"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import { undo, type UndoResult } from "./store";

/**
 * The undo toast's only action (playbook-v2 P7/2).
 *
 * Revalidates broadly on success: an undo moves rows between boards, tables and
 * counts, and the one moment a full refresh is unambiguously wanted is right
 * after somebody has said "no, put that back".
 */
export async function undoAction(undoId: string): Promise<UndoResult> {
  const parsed = z.string().min(1).max(60).safeParse(undoId);
  if (!parsed.success) return { ok: false, error: "Nothing to undo." };

  const { workspaceId, userId } = await getActiveContext();
  const res = await undo(workspaceId, userId, parsed.data);
  if (res.ok) {
    revalidatePath("/leads");
    revalidatePath("/pipeline");
    revalidatePath("/deals");
    revalidatePath("/content");
    revalidatePath("/outbound");
    revalidatePath("/");
  }
  return res;
}
