import type { QuotaMeter } from "@/modules/registry/registry-service";

/**
 * The registry detail quota, at a glance (spec §4.43.4). Server-rendered:
 * it is a reading, not a control.
 */
export function RegistryQuotaMeter({ meter, compact = false }: { meter: QuotaMeter; compact?: boolean }) {
  const pct = meter.limit > 0 ? Math.min(100, Math.round((meter.usedMonth / meter.limit) * 100)) : 100;
  const low = meter.monthRemaining <= meter.reserve;
  return (
    <section
      className={`rounded-card border border-line bg-panel ${compact ? "p-3" : "p-[18px]"}`}
      data-testid="registry-quota-meter"
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="font-display text-[16px] font-bold lowercase">registry quota</h3>
        <span className="text-[11.5px] text-muted">{meter.month}</span>
        <span className="ml-auto text-[13px] tabular-nums text-ink">
          {meter.usedMonth.toLocaleString("hu-HU")} / {meter.limit.toLocaleString("hu-HU")} datasheets
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[rgba(239,241,248,0.08)]" aria-hidden>
        <div
          className={`h-full rounded-full ${low ? "bg-[#FF5C7A]" : "bg-[linear-gradient(90deg,#310B59,#7427C6)]"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-[11.5px] tabular-nums text-muted">
        Today&apos;s batch allocation: {meter.usedTodayBatch} / {meter.dailyAllocation} used · {meter.reserve} held back for
        interactive lookups · {meter.cacheHitsMonth} cache hits this month (free)
        {low ? " · only the interactive reserve is left" : ""}
      </p>
    </section>
  );
}
