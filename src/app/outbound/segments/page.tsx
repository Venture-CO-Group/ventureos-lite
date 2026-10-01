import { AppShell } from "@/components/app-shell";
import { OutboundTabs } from "@/components/outbound-tabs";
import { OutboundSegments } from "@/components/outbound-segments";
import { listSegments, catalogPermissions } from "@/modules/outbound/catalog-actions";

export const dynamic = "force-dynamic";

export default async function OutboundSegmentsPage() {
  const [segments, perms] = await Promise.all([listSegments(), catalogPermissions()]);
  return (
    <AppShell activePath="/outbound">
      <OutboundTabs active="/outbound/segments" />
      <OutboundSegments segments={segments} canEdit={perms.canEditSegments} yields={{}} />
    </AppShell>
  );
}
