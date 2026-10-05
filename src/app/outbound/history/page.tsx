import Link from "next/link";
import type { CandidateReason } from "@prisma/client";
import { AppShell } from "@/components/app-shell";
import { OutboundTabs } from "@/components/outbound-tabs";
import { OutboundHistoryTable } from "@/components/outbound-history";
import { HISTORY_TABS, historyWhere, listHistory, type HistoryFilters, type HistoryTab } from "@/modules/outbound/history";
import { REASON_LABEL } from "@/modules/outbound/run-store";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Outbound history (tracking & recovery): every candidate by where it ended
 * up — waiting, sent, rejected, filtered out, on LinkedIn, replied — with who
 * decided and why. Filters are plain GET parameters, so a view is a link.
 */
type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

const INPUT = "min-h-[40px] rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[12.5px] text-ink outline-none focus:border-accent";

export default async function OutboundHistoryPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const tab = (HISTORY_TABS.find((t) => t.key === one(sp.tab))?.key ?? "pending") as HistoryTab;
  const reason = one(sp.reason) in REASON_LABEL ? (one(sp.reason) as CandidateReason) : null;
  const date = (v: string, end = false) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T${end ? "23:59:59" : "00:00:00"}Z`) : null);
  const sort = (["decided", "company", "product"].includes(one(sp.sort)) ? one(sp.sort) : "decided") as HistoryFilters["sort"];
  const dir = one(sp.dir) === "asc" ? "asc" : "desc";
  const filters: HistoryFilters = {
    tab,
    productId: one(sp.product) || null,
    profileId: one(sp.campaign) || null,
    from: date(one(sp.from)),
    to: date(one(sp.to), true),
    reason,
    segment: one(sp.segment) || null,
    q: one(sp.q).slice(0, 100) || null,
    sort,
    dir,
    page: Number(one(sp.page)) || 1,
  };

  const [list, counts, products, profiles, segments] = await Promise.all([
    listHistory(db, workspaceId, filters),
    Promise.all(HISTORY_TABS.map((t) => db.prospectCandidate.count({ where: historyWhere({ ...filters, tab: t.key, page: 1 }) }))),
    db.product.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.icpProfile.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.segment.findMany({ select: { key: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const qs = (over: Record<string, string | number | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (one(v)) p.set(k, one(v));
    for (const [k, v] of Object.entries(over)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, String(v));
    }
    return `/outbound/history?${p.toString()}`;
  };
  const sortHrefs = {
    decided: qs({ sort: "decided", dir: sort === "decided" && dir === "desc" ? "asc" : "desc", page: null }),
    company: qs({ sort: "company", dir: sort === "company" && dir === "asc" ? "desc" : "asc", page: null }),
    product: qs({ sort: "product", dir: sort === "product" && dir === "asc" ? "desc" : "asc", page: null }),
  };
  const reviewTabs = tab === "rejected" || tab === "filtered";

  return (
    <AppShell activePath="/outbound">
      <OutboundTabs active="/outbound/history" />
      <nav className="mb-3 flex gap-1 overflow-x-auto" aria-label="History">
        {HISTORY_TABS.map((t, i) => (
          <Link
            key={t.key}
            href={qs({ tab: t.key, page: null, reason: null })}
            aria-current={t.key === tab ? "page" : undefined}
            className={`min-h-[36px] whitespace-nowrap rounded-[9px] border px-3 py-1.5 text-[12.5px] ${t.key === tab ? "border-accent text-ink" : "border-line text-muted hover:text-ink"}`}
          >
            {t.label} <span className="tabular-nums text-muted">{counts[i]}</span>
          </Link>
        ))}
      </nav>

      <form method="get" className="mb-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-7" data-testid="history-filters">
        <input type="hidden" name="tab" value={tab} />
        <input name="q" defaultValue={one(sp.q)} placeholder="Company or contact" className={`${INPUT} lg:col-span-2`} aria-label="Search" />
        <select name="product" defaultValue={one(sp.product)} className={INPUT} aria-label="Product">
          <option value="">All products</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select name="campaign" defaultValue={one(sp.campaign)} className={INPUT} aria-label="Campaign">
          <option value="">All campaigns</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select name="segment" defaultValue={one(sp.segment)} className={INPUT} aria-label="Segment">
          <option value="">All segments</option>
          {segments.map((s) => (
            <option key={s.key} value={s.key}>{s.name}</option>
          ))}
        </select>
        {reviewTabs ? (
          <select name="reason" defaultValue={one(sp.reason)} className={INPUT} aria-label="Reason">
            <option value="">Any reason</option>
            {Object.entries(REASON_LABEL).map(([k, l]) => (
              <option key={k} value={k}>{l}</option>
            ))}
          </select>
        ) : (
          <span className="hidden lg:block" />
        )}
        <div className="flex gap-2 sm:col-span-3 lg:col-span-7">
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            From <input type="date" name="from" defaultValue={one(sp.from)} className={INPUT} />
          </label>
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            to <input type="date" name="to" defaultValue={one(sp.to)} className={INPUT} />
          </label>
          <button type="submit" className="min-h-[40px] rounded-[9px] border border-line px-3 py-2 text-[12.5px] font-semibold text-ink hover:border-accent">
            Filter
          </button>
          <Link href={`/outbound/history?tab=${tab}`} className="self-center text-[12px] text-muted underline">Clear</Link>
        </div>
      </form>

      <OutboundHistoryTable tab={tab} rows={list.rows} sortHrefs={sortHrefs} sort={sort ?? "decided"} dir={dir} />

      {list.pages > 1 && (
        <div className="mt-3 flex items-center gap-3 text-[12px] tabular-nums text-muted">
          {list.page > 1 && <Link href={qs({ page: list.page - 1 })} className="underline">← previous</Link>}
          <span>page {list.page} of {list.pages} · {list.total} total</span>
          {list.page < list.pages && <Link href={qs({ page: list.page + 1 })} className="underline">next →</Link>}
        </div>
      )}
    </AppShell>
  );
}
