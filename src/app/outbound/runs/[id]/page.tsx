import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { OutboundTabs } from "@/components/outbound-tabs";
import { getRunDetail } from "@/modules/outbound/run-actions";
import { REASON_LABEL } from "@/modules/outbound/run-store";

export const dynamic = "force-dynamic";

/**
 * One run's result (playbook-v6 F3/8): the funnel, and the drop reasons
 * grouped with examples — because that distribution is how the targeting
 * gets fixed.
 */
export default async function OutboundRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRunDetail(id);
  if (!run) notFound();
  const top = Math.max(1, run.funnel[0]?.count ?? 1);
  return (
    <AppShell activePath="/outbound">
      <OutboundTabs active="/outbound/runs" />
      <Link href="/outbound/runs" className="mb-3 inline-block text-[12px] text-muted underline hover:text-ink">
        ← all runs
      </Link>
      <section className="mb-4 grid gap-2 rounded-card border border-line bg-panel p-[18px]" data-testid="run-funnel">
        <h3 className="font-display text-[18px] font-bold lowercase">
          {run.productName ?? "—"} · {run.profileName ?? "deleted profile"}
        </h3>
        <p className="text-[12px] tabular-nums text-muted">
          {run.status.toLowerCase().replace("_", " ")} · {run.requested} wanted · {run.quotaUsed} registry lookups ·{" "}
          {run.startedAt.slice(0, 16).replace("T", " ")}
          {run.message ? ` · ${run.message}` : ""}
        </p>
        {run.funnel.map((f) => (
          <div key={f.label} className="grid grid-cols-[150px_minmax(0,1fr)_48px] items-center gap-2 text-[12.5px]">
            <span className="text-muted">{f.label}</span>
            <div className="h-2 overflow-hidden rounded-full bg-[rgba(239,241,248,0.08)]">
              <div className="h-full rounded-full bg-[linear-gradient(90deg,#310B59,#7427C6)]" style={{ width: `${(f.count / top) * 100}%` }} />
            </div>
            <span className="text-right tabular-nums">{f.count}</span>
          </div>
        ))}
      </section>
      <section className="mb-4 grid gap-2 rounded-card border border-line bg-panel p-[18px]" data-testid="run-reasons">
        <h3 className="font-display text-[16px] font-bold lowercase">why candidates dropped</h3>
        {run.reasons.length === 0 && <p className="text-[12.5px] text-muted">Nothing dropped.</p>}
        {run.reasons.map((r) => (
          <details key={r.reason} className="rounded-[10px] border border-line px-3 py-2">
            <summary className="cursor-pointer text-[12.5px]">
              <span className="tabular-nums text-ink">{r.count}</span> · {REASON_LABEL[r.reason]}
            </summary>
            <ul className="mt-1 grid gap-0.5 text-[11.5px] text-muted">
              {r.examples.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </details>
        ))}
      </section>
      <section className="overflow-x-auto rounded-card border border-line bg-panel">
        <table className="w-full min-w-[560px] text-[12px]">
          <thead className="text-left text-[10.5px] uppercase tracking-[0.12em] text-muted">
            <tr>
              <th className="p-2.5">Company</th>
              <th className="p-2.5">State</th>
              <th className="p-2.5">Why</th>
              <th className="p-2.5 text-right">Priority</th>
            </tr>
          </thead>
          <tbody>
            {run.candidates.map((c) => (
              <tr key={c.id} className="border-t border-line">
                <td className="p-2.5 text-ink">{c.name}</td>
                <td className="p-2.5">{c.state.toLowerCase().replace(/_/g, " ")}{c.parked ? " · parked" : ""}</td>
                <td className="p-2.5 text-muted">{c.reasonDetail ?? (c.reason ? REASON_LABEL[c.reason] : "")}</td>
                <td className="p-2.5 text-right tabular-nums">{c.priority}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}
