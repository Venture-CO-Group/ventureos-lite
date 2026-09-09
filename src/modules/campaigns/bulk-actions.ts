"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import type { BulkResult } from "@/lib/bulk";
import { bulkRemoveRecipients } from "./bulk";

const ids = z.array(z.string().min(1).max(60)).min(1).max(200);

export async function bulkRemoveCampaignRecipients(raw: unknown): Promise<BulkResult> {
  const parsed = ids.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const { workspaceId } = await getActiveContext();
  const res = await bulkRemoveRecipients(workspaceId, parsed.data);
  revalidatePath("/campaigns");
  return res;
}
