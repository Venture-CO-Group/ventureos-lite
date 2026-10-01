import { AppShell } from "@/components/app-shell";
import { OutboundTabs } from "@/components/outbound-tabs";
import { OutboundRuns } from "@/components/outbound-runs";
import { RegistryQuotaMeter } from "@/components/registry-quota-meter";
import { listProducts, listSegments } from "@/modules/outbound/catalog-actions";
import { listRuns } from "@/modules/outbound/run-store";
import { quotaMeter } from "@/modules/registry/registry-service";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { hasGrant } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function OutboundRunsPage() {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const [products, segments, runs, meter, canRun, searches] = await Promise.all([
    listProducts(),
    listSegments(),
    listRuns(db),
    quotaMeter(workspaceId),
    hasGrant("settings.manage"),
    db.prospectSearch.findMany({
      orderBy: { ranAt: "desc" },
      take: 20,
      select: { id: true, keywords: true, location: true, ranAt: true },
    }),
  ]);
  return (
    <AppShell activePath="/outbound">
      <OutboundTabs active="/outbound/runs" />
      <div className="mb-4">
        <RegistryQuotaMeter meter={meter} compact />
      </div>
      <OutboundRuns
        products={products}
        runs={runs}
        segments={segments}
        canRun={canRun}
        searches={searches.map((s) => ({
          id: s.id,
          label: `${s.keywords} · ${s.location} · ${s.ranAt.toISOString().slice(0, 10)}`,
        }))}
      />
    </AppShell>
  );
}
