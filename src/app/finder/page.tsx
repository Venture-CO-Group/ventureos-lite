import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { hasGrant } from "@/lib/authz";
import { listLists } from "@/modules/finder/store";
import { describeCriteria } from "@/modules/finder/criteria";
import { loadSegments } from "@/modules/outbound/segments";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "not run",
  HARVESTING: "harvesting",
  READY: "estimate ready",
  ENRICHING: "looking up",
  CHECKPOINT: "first batch done",
  PAUSED_QUOTA: "paused — quota",
  CONTACTS: "reading imprints",
  IDLE: "idle",
  FAILED: "failed",
};

/** Company Finder: saved lists ("listák"), newest first. */
export default async function FinderIndexPage() {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const [lists, canEdit, segments] = await Promise.all([listLists(db), hasGrant("settings.manage"), loadSegments(db, workspaceId)]);
  const names = Object.fromEntries(segments.map((s) => [s.key, s.name]));
  return (
    <AppShell activePath="/finder">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-display text-[22px] font-extrabold lowercase tracking-display">company finder</h2>
        {canEdit && (
          <Link
            href="/finder/new"
            className="min-h-[44px] rounded-[9px] border border-accent bg-[linear-gradient(135deg,#310B59,#7427C6)] px-3.5 py-2.5 text-[12.5px] font-semibold text-white shadow-[0_0_18px_rgba(116,39,198,0.35)]"
            data-testid="finder-new"
          >
            New list
          </Link>
        )}
      </div>
      <p className="mb-4 max-w-[720px] text-[12.5px] text-muted">
        Filter Hungarian companies by activity, size, revenue, region and more, then export them or hand them to the CRM
        or an outbound product. Harvesting candidates is free; each new datasheet costs one registry lookup, and cached
        ones are free.
      </p>
      <section className="grid gap-2" data-testid="finder-lists">
        {lists.length === 0 && <p className="text-[12.5px] text-muted">No lists yet.</p>}
        {lists.map((l) => (
          <Link key={l.id} href={`/finder/${l.id}`} className="grid gap-1 rounded-card border border-line bg-panel p-3 hover:border-accent">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{l.name}</span>
              <span className="text-[11.5px] font-semibold text-muted">{STATUS_LABEL[l.status] ?? l.status.toLowerCase()}</span>
            </div>
            <span className="text-[11.5px] text-muted">{describeCriteria(l.criteria, names)}</span>
            <span className="text-[11.5px] tabular-nums text-muted">
              {l.matches} matches{l.cachedOnly ? " · cached only" : ""} · updated {l.updatedAt.slice(0, 10)}
            </span>
          </Link>
        ))}
      </section>
    </AppShell>
  );
}
