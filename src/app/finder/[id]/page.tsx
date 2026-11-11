import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { FinderEditor } from "@/components/finder-editor";
import { FinderDelete } from "@/components/finder-delete";
import { FinderRunPanel } from "@/components/finder-run-panel";
import { RegistryQuotaMeter } from "@/components/registry-quota-meter";
import { quotaMeter } from "@/modules/registry/registry-service";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { hasGrant } from "@/lib/authz";
import { getListView } from "@/modules/finder/store";
import { loadSegments } from "@/modules/outbound/segments";

export const dynamic = "force-dynamic";

export default async function FinderListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const [list, canEdit, segments, runs, meter] = await Promise.all([
    getListView(db, id),
    hasGrant("settings.manage"),
    loadSegments(db, workspaceId),
    db.finderRun.findMany({ where: { listId: id }, orderBy: { startedAt: "desc" }, take: 10 }),
    quotaMeter(workspaceId),
  ]);
  if (!list) notFound();
  return (
    <AppShell activePath="/finder">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link href="/finder" className="text-[12px] text-muted hover:text-ink">← lists</Link>
        <h2 className="min-w-0 flex-1 truncate font-display text-[22px] font-extrabold lowercase tracking-display">{list.name}</h2>
        {canEdit && <FinderDelete listId={list.id} />}
      </div>
      <details className="mb-4" open={list.status === "DRAFT"}>
        <summary className="mb-2 cursor-pointer text-[12.5px] font-semibold text-muted">Filter definition</summary>
        <FinderEditor
          listId={list.id}
          initialName={list.name}
          initial={list.criteria}
          initialCachedOnly={list.cachedOnly}
          segments={segments.filter((s) => !s.archived || list.criteria.segmentKeys.includes(s.key)).map((s) => ({ key: s.key, name: s.name, fragments: s.fragments.length }))}
          canEdit={canEdit}
        />
      </details>
      <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <FinderRunPanel
          list={list}
          canRun={canEdit}
          runs={runs.map((r) => ({
            id: r.id,
            status: r.status,
            maxLookups: r.maxLookups,
            lookupsSpent: r.lookupsSpent,
            paidMatches: r.paidMatches,
            evaluated: r.evaluated,
            matches: r.matches,
            checkpointAt: r.checkpointAt,
            message: r.message,
            startedAt: r.startedAt.toISOString(),
            finishedAt: r.finishedAt?.toISOString() ?? null,
          }))}
        />
        <div className="content-start">
          <RegistryQuotaMeter meter={meter} compact />
        </div>
      </div>
    </AppShell>
  );
}
