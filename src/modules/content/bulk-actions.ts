"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { ContentStatus } from "@prisma/client";
import { getActiveContext } from "@/lib/session";
import type { BulkResult } from "@/lib/bulk";
import { bulkSetContentStatus } from "./bulk";

const ids = z.array(z.string().min(1).max(60)).min(1).max(200);

/**
 * A bulk status change.
 *
 * The approver check happens once, for the actor — every member of the
 * workspace may approve a post (the per-post rule lives in `canTransition`),
 * so what matters here is that a CLIENT-role session is not one.
 */
export async function bulkContentStatus(raw: unknown, to: string): Promise<BulkResult> {
  const parsed = ids.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const status = z.nativeEnum(ContentStatus).safeParse(to);
  if (!status.success) return { applied: 0, skipped: [] };

  const { workspaceId, userId, role } = await getActiveContext();
  const isApprover = role !== "CLIENT";
  const res = await bulkSetContentStatus(workspaceId, userId, parsed.data, status.data, isApprover);
  revalidatePath("/content");
  return res;
}
