import { AppShell } from "@/components/app-shell";
import { OutboundTabs } from "@/components/outbound-tabs";
import { OutboundQueue } from "@/components/outbound-queue";
import { loadQueue } from "@/modules/outbound/queue-view";
import { queueStats } from "@/modules/outbound/approval";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { hasGrant } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** The approval queue (spec §4.43.8) — the outbound motor's front door. */
export default async function OutboundQueuePage() {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const canReview = await hasGrant("outbound.approve");
  const [cards, stats] = await Promise.all([
    canReview ? loadQueue(db, workspaceId, userId) : Promise.resolve([]),
    queueStats(db, workspaceId),
  ]);
  return (
    <AppShell activePath="/outbound">
      <OutboundTabs active="/outbound" />
      {canReview ? (
        <OutboundQueue cards={cards} stats={stats} />
      ) : (
        <p className="text-[13px] text-muted">You do not have permission to review outbound drafts.</p>
      )}
    </AppShell>
  );
}
