import type { ApiCostReport } from "@/lib/api-usage";

/**
 * What the outside world costs this workspace, in one place.
 *
 * Claude sits at the top because it is the only one with an ENFORCED daily cap;
 * everything below it is tracked, not gated. The free Google APIs are listed
 * too, showing calls rather than dollars — a money column for them would read
 * $0.00 for ever while a quota quietly ran out, which is the opposite of
 * keeping track.
 */
function usd(n: number): string {
  // Sub-cent spend is normal here (a SERP query is $0.002), so two decimals
  // would round a real month of tracking to $0.00.
  if (n === 0) return "$0";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function ApiCosts({ report }: { report: ApiCostReport }) {
  const claudePct =
    report.claude.capUsd > 0
      ? Math.min(100, Math.round((report.claude.todayUsd / report.claude.capUsd) * 100))
      : 0;

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <h2 className="font-display text-[15px] font-bold lowercase tracking-display">
          api usage &amp; costs
        </h2>
        <span className="ml-auto text-[11px] text-muted">
          This month:{" "}
          <b className="tabular-nums text-[#C9CEE3]">{usd(report.totalMonthUsd)}</b>
        </span>
      </div>
      <p className="mb-3 text-[11.5px] leading-relaxed text-muted">
        UTC days, current calendar month. Only Claude has an enforced cap — the rest is
        tracked so nothing surprises you on a bill.
      </p>

      {/* Claude first: the one with a hard limit behind it. */}
      <div className="rounded-[10px] border border-line bg-panel-2 p-3">
        <div className="flex flex-wrap items-baseline gap-2 text-[12.5px]">
          <span className="font-semibold text-ink">✦ Claude</span>
          <span className="text-[11px] text-muted">daily cap enforced</span>
          <span className="ml-auto tabular-nums text-[#C9CEE3]">
            {usd(report.claude.todayUsd)} / {usd(report.claude.capUsd)} today
          </span>
        </div>
        <div className="mt-2 h-[5px] overflow-hidden rounded-full bg-[rgba(239,241,248,0.08)]">
          <div
            className={`h-full ${claudePct >= 100 ? "bg-neg" : claudePct >= 80 ? "bg-warn" : "bg-grad"}`}
            style={{ width: `${claudePct}%` }}
          />
        </div>
        <div className="mt-1.5 text-[11px] text-muted">
          {usd(report.claude.monthUsd)} this month
        </div>
      </div>

      <div className="mt-2.5 overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-line text-[10px] uppercase tracking-[0.08em] text-muted">
              <th className="py-1.5 pr-3 text-left font-semibold">Provider</th>
              <th className="py-1.5 pr-3 text-right font-semibold">Calls today</th>
              <th className="py-1.5 pr-3 text-right font-semibold">Calls (month)</th>
              <th className="py-1.5 pr-3 text-right font-semibold">Cost today</th>
              <th className="py-1.5 text-right font-semibold">Cost (month)</th>
            </tr>
          </thead>
          <tbody>
            {report.providers.map((p) => (
              <tr key={p.provider} className="border-b border-[rgba(239,241,248,0.05)] align-top">
                <td className="py-2 pr-3">
                  <div className="text-[#C9CEE3]">
                    {p.label}
                    {!p.billed && (
                      <span className="ml-1.5 rounded-full border border-line px-1.5 py-0.5 text-[10px] text-muted">
                        free
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-muted">{p.note}</div>
                  {/*
                    The quota line is only true with a key. Without one,
                    PageSpeed runs on Google's shared anonymous project, whose
                    daily allowance is usually already spent by somebody else —
                    so "0% of 25,000/day used" was being shown for a provider
                    refusing every call with a 429.
                  */}
                  {p.keyConfigured === false ? (
                    <div
                      data-testid={`no-key-${p.provider}`}
                      className="mt-1 rounded-[6px] border border-[rgba(245,184,65,0.35)] bg-[rgba(245,184,65,0.08)] px-1.5 py-1 text-[11px] leading-relaxed text-[#F5D9A0]"
                    >
                      No API key. Calls fall back to Google&apos;s shared
                      anonymous quota, which is usually exhausted — expect them
                      to fail. Set a key in Integrations above.
                    </div>
                  ) : (
                    p.quotaPct !== null &&
                    p.dailyQuota !== null && (
                      <div className="mt-1 text-[11px] text-muted">
                        {p.quotaPct}% of the {p.dailyQuota.toLocaleString("en-US")}/day free quota
                      </div>
                    )
                  )}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted">{p.callsToday}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted">{p.callsMonth}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted">
                  {p.billed ? usd(p.costTodayUsd) : "—"}
                </td>
                <td className="py-2 text-right tabular-nums text-[#C9CEE3]">
                  {p.billed ? usd(p.costMonthUsd) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2.5 text-[11px] leading-relaxed text-muted">
        PageSpeed and Chrome UX Report are free; the number that can run out is calls
        against Google&apos;s per-project quota, so that is what is shown for them. A single
        audit spends one PageSpeed call and up to four CrUX calls.
      </p>
    </div>
  );
}
