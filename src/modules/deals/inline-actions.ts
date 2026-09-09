"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import { applyDealInlineEdit, type DealInlineResult } from "./inline";

/** One inline edit on a deal (playbook-v5 P16/1). */
export async function editDealField(raw: unknown): Promise<DealInlineResult> {
  const parsed = z
    .object({
      dealId: z.string().min(1),
      field: z.string().min(1).max(60),
      value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That edit is not valid." };

  const { workspaceId, userId } = await getActiveContext();
  const res = await applyDealInlineEdit(workspaceId, userId, parsed.data);

  // The amount and the close date both feed the forecast, which is a different
  // tab reading the same rows.
  if (res.ok && (parsed.data.field === "value" || parsed.data.field === "expectedCloseAt")) {
    revalidatePath("/deals");
  }
  return res;
}
