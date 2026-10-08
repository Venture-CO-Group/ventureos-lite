import { prismaUnsafe } from "@/lib/db";
import { parseOutboundConfig } from "./config";

/**
 * The workspace's configured cold outbound address, and its connected mailbox.
 *
 * One lookup for everything that needs "the sender" — the drafting engine for
 * the signature name, the queue for the preview, the settings screen and the
 * sender itself — so none of them can drift back to a hard-coded address.
 * The mailbox is looked up IN THIS WORKSPACE only: a mailbox another workspace
 * connected is never this workspace's sender, whatever its address.
 */
export async function outboundSenderAddress(workspaceId: string): Promise<string | null> {
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { outboundConfig: true },
  });
  return parseOutboundConfig(ws?.outboundConfig).sending.senderAddress;
}

export async function outboundMailAccount(workspaceId: string, opts: { enabledOnly?: boolean } = {}) {
  const address = await outboundSenderAddress(workspaceId);
  if (!address) return null;
  return prismaUnsafe.mailAccount.findFirst({
    where: { workspaceId, accountEmail: address, ...(opts.enabledOnly ? { enabled: true } : {}) },
  });
}
