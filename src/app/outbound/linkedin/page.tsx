import { AppShell } from "@/components/app-shell";
import { OutboundTabs } from "@/components/outbound-tabs";
import { OutboundLinkedIn } from "@/components/outbound-linkedin";
import { loadLinkedInQueue } from "@/modules/outbound/queue-view";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OutboundLinkedInPage() {
  const { workspaceId } = await getActiveContext();
  const cards = await loadLinkedInQueue(getWorkspaceClient(workspaceId));
  return (
    <AppShell activePath="/outbound">
      <OutboundTabs active="/outbound/linkedin" />
      <OutboundLinkedIn cards={cards} />
    </AppShell>
  );
}
