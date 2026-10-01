/**
 * The outbound send sweep (playbook-v6 F5): every five minutes, per
 * workspace that has anything to send or to watch — one send at most, then
 * bounces, replies and due follow-ups.
 */
import { prismaUnsafe } from "@/lib/db";
import { processBounces, processReplies, scheduleFollowups, sendTick, type SendDeps, type SendOutcome } from "./sender";

export async function processOutboundSendSweep(deps: SendDeps = { now: () => new Date() }): Promise<Record<string, SendOutcome>> {
  const active = await prismaUnsafe.outreachDraft.findMany({
    where: { status: { in: ["APPROVED", "SENT"] } },
    distinct: ["workspaceId"],
    select: { workspaceId: true },
  });
  const out: Record<string, SendOutcome> = {};
  for (const { workspaceId } of active) {
    try {
      out[workspaceId] = await sendTick(workspaceId, deps);
      await processReplies(workspaceId, deps);
      await scheduleFollowups(workspaceId, deps);
      await processBounces(workspaceId, deps).catch(() => ({ bounced: 0, tripped: false }));
    } catch (e) {
      // One workspace's broken mailbox must not stop another's sends.
      // eslint-disable-next-line no-console
      console.error(`[outbound] send sweep failed for ${workspaceId}`, e);
      out[workspaceId] = "failed";
    }
  }
  return out;
}
