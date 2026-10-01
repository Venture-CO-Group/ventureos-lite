import { AppShell } from "@/components/app-shell";
import { OutboundTabs } from "@/components/outbound-tabs";
import { OutboundSegments } from "@/components/outbound-segments";
import { listSegments, catalogPermissions } from "@/modules/outbound/catalog-actions";
import { fragmentYields } from "@/modules/outbound/metrics";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OutboundSegmentsPage() {
  const { workspaceId } = await getActiveContext();
  const [segments, perms, yields] = await Promise.all([listSegments(), catalogPermissions(), fragmentYields(getWorkspaceClient(workspaceId))]);
  return (
    <AppShell activePath="/outbound">
      <OutboundTabs active="/outbound/segments" />
      <OutboundSegments segments={segments} canEdit={perms.canEditSegments} yields={yields} />
    </AppShell>
  );
}
