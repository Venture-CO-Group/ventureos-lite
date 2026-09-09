import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { ProspectorSkeleton } from "@/components/skeletons";
import { Prospector } from "@/components/prospector";
import { ProspectorBackfill } from "@/components/prospector-backfill";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import type { SavedSearch } from "@/modules/prospector/types";
import { getBackfillState, canRunBackfill } from "@/modules/prospector/backfill-actions";

export const dynamic = "force-dynamic";

export default function ProspectorPage() {
  return (
    <AppShell activePath="/prospector">
      <Suspense fallback={<ProspectorSkeleton />}>
        <ProspectorBody />
      </Suspense>
    </AppShell>
  );
}

async function ProspectorBody() {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.prospectSearch.findMany({
    orderBy: { ranAt: "desc" },
    take: 20,
    select: { id: true, keywords: true, location: true },
  });

  const seen = new Set<string>();
  const saved: SavedSearch[] = [];
  for (const r of rows) {
    const key = `${r.keywords.toLowerCase()}|${r.location.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    saved.push({ id: r.id, keyword: r.keywords, location: r.location });
  }

  // Owner/Admin only — the same rule the actions enforce server-side.
  const [mayBackfill, backfill] = await Promise.all([canRunBackfill(), getBackfillState()]);

  return (
    <div className="flex flex-col gap-4">
      <Prospector saved={saved} />
      {mayBackfill && <ProspectorBackfill state={backfill} />}
    </div>
  );
}
