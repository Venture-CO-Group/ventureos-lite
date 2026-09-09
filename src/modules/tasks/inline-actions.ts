"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import { applyTaskInlineEdit, type TaskInlineResult } from "./inline";

/**
 * The session-facing wrapper for an inline task edit (playbook-v5 P16/1).
 *
 * NO `revalidatePath` on success, for the same reason the leads table has none:
 * the cell has already updated optimistically and the server has answered with
 * what it stored, so a revalidation would re-render the board underneath
 * somebody who is tabbing along a card. The next real navigation picks it up.
 */
export async function editTaskField(raw: unknown): Promise<TaskInlineResult> {
  const parsed = z
    .object({
      taskId: z.string().min(1),
      field: z.string().min(1).max(60),
      value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That edit is not valid." };

  const { workspaceId, userId } = await getActiveContext();
  const res = await applyTaskInlineEdit(workspaceId, userId, parsed.data);

  // A due date moves the task between the buckets on the dashboard and in My
  // Work, so those do have to know.
  if (res.ok && (parsed.data.field === "dueAt" || parsed.data.field === "assigneeId")) {
    revalidatePath("/");
  }
  return res;
}
