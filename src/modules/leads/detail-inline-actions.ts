"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import { applyDetailInlineEdit, type DetailInlineResult } from "./detail-inline";

const schema = z.object({
  leadId: z.string().min(1),
  field: z.string().min(1).max(60),
  value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
});

/** The lead detail panel's per-field commit (playbook-v5 P16/1). */
export async function editLeadDetailField(raw: unknown): Promise<DetailInlineResult> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That edit is not valid." };

  const { workspaceId, userId } = await getActiveContext();
  const res = await applyDetailInlineEdit(workspaceId, userId, parsed.data);

  // A company rename shows on every lead at that company, and on the boards.
  if (res.ok && parsed.data.field.startsWith("company.")) {
    revalidatePath("/leads");
    revalidatePath("/pipeline");
  }
  return res;
}
