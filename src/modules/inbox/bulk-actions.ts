"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import type { BulkResult } from "@/lib/bulk";
import { bulkArchiveThreads, bulkLinkThreadsToLead, bulkMarkThreadsRead } from "./bulk";

const ids = z.array(z.string().min(1).max(60)).min(1).max(200);

export async function bulkThreadsRead(raw: unknown, unread = false): Promise<BulkResult> {
  const parsed = ids.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const { workspaceId } = await getActiveContext();
  const res = await bulkMarkThreadsRead(workspaceId, parsed.data, unread);
  revalidatePath("/inbox");
  return res;
}

export async function bulkThreadsArchive(raw: unknown, archived = true): Promise<BulkResult> {
  const parsed = ids.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const { workspaceId } = await getActiveContext();
  const res = await bulkArchiveThreads(workspaceId, parsed.data, archived);
  revalidatePath("/inbox");
  return res;
}

export async function bulkThreadsLink(raw: unknown, leadId: string): Promise<BulkResult> {
  const parsed = ids.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const who = z.string().min(1).max(60).safeParse(leadId);
  if (!who.success) return { applied: 0, skipped: [] };
  const { workspaceId } = await getActiveContext();
  const res = await bulkLinkThreadsToLead(workspaceId, parsed.data, who.data);
  revalidatePath("/inbox");
  return res;
}
