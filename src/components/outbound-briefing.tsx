import Link from "next/link";
import type { Briefing } from "@/modules/outbound/briefing";

/**
 * The morning briefing on the Dashboard (spec §4.43.10). Server-rendered and
 * plain: a reading, not a control — one link, to the queue.
 */
export function OutboundBriefing({ b }: { b: Briefing }) {
  if (!b.active) return null;
  return (
    <section className="grid gap-2 rounded-card border border-line bg-panel p-[18px]" data-testid="outbound-briefing">
      <div className="flex flex-wrap items-baseline gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Outbound this morning</div>
        {b.lastNight && <span className="text-[11px] tabular-nums text-muted">last run {b.lastNight.date} · {b.lastNight.runs} run(s)</span>}
        <Link
          href="/outbound"
          className="ml-auto min-h-[36px] rounded-[9px] border border-line px-3 py-1.5 text-[12px] font-semibold text-ink hover:border-accent"
        >
          Open the queue →
        </Link>
      </div>
      <p className="text-[14px] tabular-nums">
        <b className="text-ink">{b.pending.total}</b> waiting for approval
        {b.pending.byProduct.length > 0 && <span className="text-muted"> · {b.pending.byProduct.map((p) => `${p.name} ${p.n}`).join(", ")}</span>}
        {b.linkedIn > 0 && <span className="text-muted"> · {b.linkedIn} in the LinkedIn queue</span>}
      </p>
      {b.dropped.total > 0 && (
        <p className="text-[12.5px] tabular-nums text-muted">
          {b.dropped.total} dropped last night: {b.dropped.byReason.slice(0, 4).map((r) => `${r.n} ${r.label}`).join(", ")}
        </p>
      )}
      <p className="text-[12.5px] tabular-nums text-muted">
        Registry datasheets: {b.quota.used.toLocaleString("hu-HU")} / {b.quota.limit.toLocaleString("hu-HU")} this month
      </p>
      {b.missed.map((m) => (
        <p key={`${m.product}-${m.profile}`} className="text-[12.5px] text-[#FFD27A]">
          {m.product} · {m.profile}: {m.got} of {m.wanted} — {m.why}
        </p>
      ))}
      {b.exhausted.map((e) => (
        <p key={`${e.product}-${e.profile}`} className="text-[12.5px] text-muted">
          <b className="text-ink">{e.segments.join(", ") || e.profile}</b> is running dry. {e.suggestion}{" "}
          <Link href="/outbound/segments" className="underline">Segments</Link>
        </p>
      ))}
    </section>
  );
}
