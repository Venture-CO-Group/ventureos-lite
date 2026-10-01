import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { OutboundTabs } from "@/components/outbound-tabs";
import { outboundFunnel, costReport, fragmentRetirementCandidates, fragmentYields, REVIEW_REASON_LIST, type FunnelRow } from "@/modules/outbound/metrics";
import { REASON_LABEL } from "@/modules/outbound/run-store";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Is the motor working (spec §4.43.10, playbook-v6 F6/4–5)? The approval rate
 * and the rejection-reason distribution lead, because they say whether to
 * fix the targeting or the copy; then the funnel, the cost per meeting and
 * the fragments worth retiring or copying.
 */
const COLS: Array<{ key: keyof FunnelRow; label: string }> = [
  { key: "sourced", label: "Sourced" },
  { key: "prefiltered", label: "Pre-filtered" },
  { key: "enriched", label: "Enriched" },
  { key: "qualified", label: "Qualified" },
  { key: "drafted", label: "Drafted" },
  { key: "approved", label: "Approved" },
  { key: "sent", label: "Sent" },
  { key: "replied", label: "Replied" },
  { key: "meetings", label: "Meetings" },
];

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

function FunnelTable({ rows, label }: { rows: FunnelRow[]; label: (r: FunnelRow) => string }) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-panel">
      <table className="w-full min-w-[760px] text-[12px] tabular-nums">
        <thead className="text-left text-[10.5px] uppercase tracking-[0.12em] text-muted">
          <tr>
            <th className="p-2.5"> </th>
            {COLS.map((c) => (
              <th key={c.key} className="p-2.5 text-right">{c.label}</th>
            ))}
            <th className="p-2.5 text-right">Approval</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.productId}-${r.profileId}`} className="border-t border-line">
              <td className="p-2.5 text-ink">{label(r)}</td>
              {COLS.map((c) => (
                <td key={c.key} className="p-2.5 text-right">{String(r[c.key] ?? 0)}</td>
              ))}
              <td className="p-2.5 text-right font-semibold text-ink">{pct(r.approvalRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function OutboundInsightsPage() {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const [funnel, costs, retire, yields] = await Promise.all([outboundFunnel(db), costReport(db), fragmentRetirementCandidates(db), fragmentYields(db)]);
  const reasons = funnel.total.rejectionReasons;
  const rejectedTotal = REVIEW_REASON_LIST.reduce((s, r) => s + (reasons[r] ?? 0), 0);
  const strong = Object.entries(yields)
    .flatMap(([segment, list]) => list.map((y) => ({ segment, ...y })))
    .filter((y) => y.approved >= 3)
    .sort((a, b) => b.approved / b.sourced - a.approved / a.sourced)
    .slice(0, 8);

  return (
    <AppShell activePath="/outbound">
      <OutboundTabs active="/outbound/insights" />
      <div className="grid gap-4">
        <section className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-card border border-line bg-panel p-[18px]" data-testid="approval-rate">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Approval rate</div>
            <div className="font-display text-[34px] font-extrabold tabular-nums">{pct(funnel.total.approvalRate)}</div>
            <p className="text-[12px] text-muted">
              {funnel.total.approved} approved, {funnel.total.rejected} rejected. A low rate means the profile or the source is
              wrong — not the copy.
            </p>
          </div>
          <div className="rounded-card border border-line bg-panel p-[18px]" data-testid="rejection-reasons">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Why drafts were rejected</div>
            {rejectedTotal === 0 && <p className="text-[12.5px] text-muted">No rejections yet.</p>}
            {REVIEW_REASON_LIST.filter((r) => reasons[r]).map((r) => (
              <div key={r} className="grid grid-cols-[140px_minmax(0,1fr)_40px] items-center gap-2 text-[12.5px]">
                <span className="text-muted">{REASON_LABEL[r]}</span>
                <div className="h-2 overflow-hidden rounded-full bg-[rgba(239,241,248,0.08)]">
                  <div className="h-full rounded-full bg-[linear-gradient(90deg,#310B59,#7427C6)]" style={{ width: `${((reasons[r] ?? 0) / rejectedTotal) * 100}%` }} />
                </div>
                <span className="text-right tabular-nums">{reasons[r]}</span>
              </div>
            ))}
            {rejectedTotal > 0 && (
              <p className="mt-2 text-[11.5px] text-muted">
                {(reasons.WRONG_TARGETING ?? 0) >= (reasons.WEAK_COPY ?? 0)
                  ? "Targeting dominates: look at the sources and profiles first."
                  : "Copy dominates: look at the product's value props and the templates first."}
              </p>
            )}
          </div>
        </section>

        <h3 className="font-display text-[17px] font-bold lowercase">by product</h3>
        <FunnelTable rows={[...funnel.products, funnel.total]} label={(r) => r.productName} />
        <h3 className="font-display text-[17px] font-bold lowercase">by profile</h3>
        <FunnelTable rows={funnel.profiles} label={(r) => `${r.productName} · ${r.profileName}`} />
        <p className="text-[11.5px] text-muted">Opens are not counted: cold outbound is sent as plain text with no tracking pixel.</p>

        <section className="grid gap-2" data-testid="cost-report">
          <h3 className="font-display text-[17px] font-bold lowercase">cost per meeting · {costs[0]?.month ?? "this month"}</h3>
          <div className="overflow-x-auto rounded-card border border-line bg-panel">
            <table className="w-full min-w-[520px] text-[12px] tabular-nums">
              <thead className="text-left text-[10.5px] uppercase tracking-[0.12em] text-muted">
                <tr>
                  <th className="p-2.5">Product</th>
                  <th className="p-2.5 text-right">Registry lookups</th>
                  <th className="p-2.5 text-right">Claude (USD)</th>
                  <th className="p-2.5 text-right">Meetings</th>
                  <th className="p-2.5 text-right">Lookups / meeting</th>
                  <th className="p-2.5 text-right">USD / meeting</th>
                </tr>
              </thead>
              <tbody>
                {costs.map((c) => (
                  <tr key={String(c.productId)} className="border-t border-line">
                    <td className="p-2.5 text-ink">{c.productName}</td>
                    <td className="p-2.5 text-right">{c.registryLookups}</td>
                    <td className="p-2.5 text-right">{c.claudeUsd.toFixed(2)}</td>
                    <td className="p-2.5 text-right">{c.meetings}</td>
                    <td className="p-2.5 text-right">{c.lookupsPerMeeting ?? "—"}</td>
                    <td className="p-2.5 text-right">{c.claudeUsdPerMeeting?.toFixed(2) ?? "—"}</td>
                  </tr>
                ))}
                {costs.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-2.5 text-muted">Nothing spent this month yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid gap-2 rounded-card border border-line bg-panel p-[18px]" data-testid="fragment-maintenance">
          <h3 className="font-display text-[17px] font-bold lowercase">name fragments</h3>
          {retire.length === 0 && strong.length === 0 && <p className="text-[12.5px] text-muted">Not enough decided candidates yet to judge any fragment (20 per fragment).</p>}
          {retire.map((r) => (
            <p key={`${r.segmentKey}-${r.fragment}`} className="text-[12.5px]">
              Retire <b className="text-ink">“{r.fragment}”</b> in {r.segmentKey}: {r.decided} decided, none approved. The weekly Signal Engine run raises this as a proposal.
            </p>
          ))}
          {strong.map((y) => (
            <p key={`${y.segment}-${y.fragment}`} className="text-[12.5px] text-muted">
              Strong: <b className="text-ink">“{y.fragment}”</b> ({y.segment}) — {y.approved} approved of {y.sourced} found. Similar words are worth adding.
            </p>
          ))}
          <Link href="/outbound/segments" className="justify-self-start text-[12px] underline">Edit fragments</Link>
        </section>
      </div>
    </AppShell>
  );
}
