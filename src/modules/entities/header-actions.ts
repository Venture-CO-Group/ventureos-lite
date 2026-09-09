"use server";

import { z } from "zod";
import { getActiveContext } from "@/lib/session";
import { companyHeader, dealHeader, type EntityHeader } from "./header";

const id = z.string().min(1).max(60);

/**
 * The drawer's header, for the entities that have no page of their own
 * (playbook-v5 P20/4). A lead has its full modal and does not come through
 * here.
 */
export async function getEntityHeader(
  kind: "company" | "deal",
  entityId: string,
): Promise<EntityHeader | null> {
  const parsed = z.object({ kind: z.enum(["company", "deal"]), entityId: id }).safeParse({
    kind,
    entityId,
  });
  if (!parsed.success) return null;
  const { workspaceId } = await getActiveContext();
  return parsed.data.kind === "company"
    ? companyHeader(workspaceId, parsed.data.entityId)
    : dealHeader(workspaceId, parsed.data.entityId);
}
