import { prismaUnsafe, getWorkspaceClient } from "../../lib/db";
import { coldEmailAllowed } from "./logic";
import { runCampaignSend, ColdGateError } from "./send";


/**
 * Daily cold-email send sweep (spec §4.16). Per workspace with a recorded
 * sign-off, sends the next batch of each ACTIVE campaign — respecting the
 * warm-up ramp, daily cap, suppression, stop-on-reply, and circuit breaker.
 * Gated: a workspace without sign-off is skipped entirely. Returns total sent.
 */
export async function processColdSends(nowMs: number = Date.now()): Promise<number> {
  const workspaces = await prismaUnsafe.workspace.findMany({
    where: { deletedAt: null },
    select: { id: true, featureFlags: true, mailgunConfig: true },
  });

  let total = 0;
  for (const ws of workspaces) {
    if (!coldEmailAllowed(ws.featureFlags)) continue; // hard gate
    const db = getWorkspaceClient(ws.id);
    const active = await db.campaign.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
    for (const c of active) {
      try {
        const res = await runCampaignSend(db, c.id, {
          workspaceId: ws.id,
          featureFlags: ws.featureFlags,
          mailgunConfig: ws.mailgunConfig,
          nowMs,
        });
        total += res.sent;
      } catch (e) {
        if (e instanceof ColdGateError) break; // sign-off revoked mid-run
        // eslint-disable-next-line no-console
        console.error(`[cold] send failed for campaign ${c.id}`, e);
      }
    }
  }
  return total;
}
