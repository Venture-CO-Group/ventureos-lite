"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import { continueFinderRun, estimatePhase2, startContactEnrichment, startHarvest, startPhase2, stopRun } from "@/modules/finder/run-actions";
import type { EnrichmentEstimate } from "@/modules/finder/engine";
import type { ListView } from "@/modules/finder/store";
import { REASON_LABEL, type FinderReason } from "@/modules/finder/criteria";
import { BUTTON, INPUT, LABEL, PRIMARY } from "./finder-editor";

/**
 * The two-phase run (item 2). Phase 1 is a button: it is free. Phase 2 is a
 * number, an estimate, and a confirmation — the panel will not start it until
 * the person has seen what the number means against the month and the day.
 */

export interface RunRowView {
  id: string;
  status: string;
  maxLookups: number;
  lookupsSpent: number;
  paidMatches: number;
  evaluated: number;
  matches: number;
  checkpointAt: number | null;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const n = (x: number) => x.toLocaleString("hu-HU");

export function FinderRunPanel({
  list,
  runs,
  canRun,
  contactTodo = 0,
}: {
  list: ListView;
  runs: RunRowView[];
  canRun: boolean;
  /** Matches (and contact-only refusals) whose site has not been read yet. */
  contactTodo?: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [maxLookups, setMaxLookups] = useState(Math.max(1, Math.min(list.stats.metered || 100, 100)));
  const [estimate, setEstimate] = useState<EnrichmentEstimate | null>(null);
  const open = runs.find((r) => r.status === "RUNNING" || r.status === "CHECKPOINT" || r.status === "PAUSED_QUOTA") ?? null;
  const busy = list.status === "HARVESTING" || list.status === "ENRICHING" || list.status === "CONTACTS";

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [busy, router]);

  const act = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setError(null);
    startTransition(async () => {
      const res = await attempt(fn());
      if (!res.ok) setError(res.error);
      setEstimate(null);
      router.refresh();
    });
  };

  function doEstimate() {
    setError(null);
    startTransition(async () => {
      const res = await attempt(estimatePhase2({ listId: list.id, maxLookups }));
      if (!res.ok) setError(res.error);
      else setEstimate(res.estimate);
    });
  }

  const s = list.stats;
  const excluded = Object.entries(s.excluded).filter(([, v]) => v > 0);
  const phase1Done = !!s.harvestedAt && list.status !== "DRAFT";

  return (
    <section className="grid gap-3 rounded-card border border-line bg-panel p-[18px]" data-testid="finder-run-panel">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-display text-[17px] font-bold lowercase">run</h3>
        {list.message && <span className="text-[12px] text-muted" data-testid="finder-list-message">{list.message}</span>}
      </div>
      {error && <p className="text-[12px] text-[#FFB3C2]" role="alert">{error}</p>}

      {/* Phase 1 */}
      <div className="grid gap-2 rounded-[10px] border border-line p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-ink">
            {list.cachedOnly ? "Filter cached datasheets" : "Phase 1 · harvest and pre-filter"}
          </span>
          <span className="rounded-full border border-line px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-pos">free</span>
          {canRun && (
            <button
              type="button"
              className={`${BUTTON} ml-auto`}
              disabled={pending || busy || !!open}
              onClick={() => act(() => startHarvest(list.id))}
              data-testid="finder-phase1"
            >
              {list.status === "HARVESTING" ? "Running…" : phase1Done ? "Run again" : "Run"}
            </button>
          )}
        </div>
        {phase1Done && (
          <div className="grid gap-1 text-[12.5px] tabular-nums" data-testid="finder-phase1-stats">
            <span>
              <b className="text-ink">{n(s.candidates)}</b> candidates{list.cachedOnly ? " in the cache" : ` from ${n(s.fragments)} harvests`} ·{" "}
              <b className="text-ink">{n(s.cached)}</b> had a cached datasheet and were filtered free ·{" "}
              <b className="text-ink">{n(s.metered)}</b> need a metered lookup
            </span>
            {excluded.length > 0 && (
              <span className="text-muted">
                Dropped before any lookup:{" "}
                {excluded.map(([k, v]) => `${n(v)} ${REASON_LABEL[k as FinderReason] ?? k}`).join(" · ")}
              </span>
            )}
            {s.errors.length > 0 && <span className="text-[#FFD27A]">Some searches failed: {s.errors[0]}</span>}
          </div>
        )}
      </div>

      {/* Phase 2 */}
      {!list.cachedOnly && phase1Done && (
        <div className="grid gap-2 rounded-[10px] border border-line p-3" data-testid="finder-phase2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-ink">Phase 2 · metered lookups</span>
            <span className="rounded-full border border-line px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#FFD27A]">
              uses quota
            </span>
          </div>

          {open ? (
            <OpenRun run={open} pending={pending} canRun={canRun} act={act} />
          ) : s.metered === 0 ? (
            <p className="text-[12.5px] text-muted">Nothing needs a lookup — every candidate was decided for free.</p>
          ) : (
            canRun && (
              <>
                <label className="grid max-w-[260px] gap-1">
                  <span className={LABEL}>Most lookups this run may spend</span>
                  <input
                    className={`${INPUT} tabular-nums`}
                    type="number"
                    min={1}
                    max={100000}
                    value={maxLookups}
                    onChange={(e) => {
                      setMaxLookups(Math.max(1, Number(e.target.value) || 1));
                      setEstimate(null);
                    }}
                    data-testid="finder-max-lookups"
                  />
                </label>
                {estimate && (
                  <div className="grid gap-1 rounded-[10px] border border-accent/60 p-3 text-[12.5px] tabular-nums" data-testid="finder-estimate">
                    <span>
                      This run will spend up to <b className="text-ink">{n(estimate.expected)} lookups</b> —{" "}
                      <b className="text-ink">{pct(estimate.monthShare)}</b> of the {n(estimate.monthRemaining)} left this month and{" "}
                      <b className="text-ink">
                        {estimate.todayRemaining > 0 ? pct(estimate.expected / estimate.todayRemaining) : "all (none left today)"}
                      </b>{" "}
                      of today&apos;s remaining allocation ({n(estimate.todayRemaining)} of {n(estimate.dailyAllocation)}).
                    </span>
                    <span className="text-muted">
                      {n(estimate.pending)} waiting · {n(estimate.cachedNow)} of them are cached now (free) · {n(estimate.meteredNeeded)} would
                      cost a lookup. Lookups go best-scored first. The run stops after the first batch so you can judge the yield. The{" "}
                      {n(estimate.reserve)} lookups held back for interactive use are never touched.
                    </span>
                    {estimate.exceedsToday && (
                      <span className="text-[#FFD27A]">
                        Today&apos;s allocation covers {n(estimate.expectedToday)} of them; the run pauses there and can be resumed tomorrow.
                      </span>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={BUTTON} disabled={pending} onClick={doEstimate} data-testid="finder-estimate-btn">
                    {pending && !estimate ? "Estimating…" : "Estimate"}
                  </button>
                  <button
                    type="button"
                    className={PRIMARY}
                    disabled={pending || !estimate || estimate.expected === 0}
                    onClick={() =>
                      estimate && act(() => startPhase2({ listId: list.id, maxLookups, confirmedLookups: estimate.expected }))
                    }
                    data-testid="finder-phase2-start"
                  >
                    {estimate ? `Confirm and spend up to ${n(estimate.expected)}` : "Confirm and start"}
                  </button>
                </div>
              </>
            )
          )}
          <RunHistory runs={runs.filter((r) => r !== open)} />
        </div>
      )}

      {/* Optional contact enrichment */}
      {phase1Done && (
        <div className="grid gap-2 rounded-[10px] border border-line p-3" data-testid="finder-contacts">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-ink">Contacts from imprint pages · optional</span>
            <span className="rounded-full border border-line px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-pos">free</span>
            {canRun && (
              <button
                type="button"
                className={`${BUTTON} ml-auto`}
                disabled={pending || busy || contactTodo === 0}
                onClick={() => act(() => startContactEnrichment(list.id))}
                data-testid="finder-contacts-start"
              >
                {list.status === "CONTACTS" ? "Reading…" : "Find contacts"}
              </button>
            )}
          </div>
          <span className="text-[12px] text-muted">
            For matches without an email or phone: reads the company&apos;s own site (homepage and imprint / contact page,
            robots.txt honoured) and checks the CRM. No quota, no paid verification. Companies refused only for the contact
            requirement are re-checked too. {contactTodo > 0 ? `${contactTodo} to check.` : "Nothing left to check."}
          </span>
        </div>
      )}
    </section>
  );
}

function OpenRun({
  run,
  pending,
  canRun,
  act,
}: {
  run: RunRowView;
  pending: boolean;
  canRun: boolean;
  act: (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) => void;
}) {
  const yieldPer100 = run.lookupsSpent > 0 ? Math.round((run.paidMatches / run.lookupsSpent) * 1000) / 10 : null;
  return (
    <div className="grid gap-2" data-testid="finder-open-run">
      <div className="h-1.5 overflow-hidden rounded-full bg-[rgba(239,241,248,0.08)]" aria-hidden>
        <div
          className="h-full rounded-full bg-[linear-gradient(90deg,#310B59,#7427C6)]"
          style={{ width: `${Math.min(100, Math.round((run.lookupsSpent / Math.max(1, run.maxLookups)) * 100))}%` }}
        />
      </div>
      <span className="text-[12.5px] tabular-nums">
        {run.status === "RUNNING" ? "Looking up…" : run.status === "CHECKPOINT" ? "First batch done." : "Paused — quota."}{" "}
        {run.lookupsSpent} / {run.maxLookups} lookups · {run.matches} matches
        {yieldPer100 !== null && run.status !== "RUNNING" && (
          <>
            {" "}
            · observed yield <b className="text-ink" data-testid="finder-yield">{yieldPer100} matches per 100 lookups</b>
          </>
        )}
      </span>
      {run.message && <span className="text-[12px] text-muted">{run.message}</span>}
      {canRun && (
        <div className="flex flex-wrap gap-2">
          {run.status !== "RUNNING" && (
            <button type="button" className={PRIMARY} disabled={pending} onClick={() => act(() => continueFinderRun(run.id))} data-testid="finder-continue">
              {run.status === "CHECKPOINT" ? `Continue (up to ${run.maxLookups - run.lookupsSpent} more)` : "Resume"}
            </button>
          )}
          <button type="button" className={BUTTON} disabled={pending} onClick={() => act(() => stopRun(run.id))} data-testid="finder-stop">
            Stop here
          </button>
        </div>
      )}
    </div>
  );
}

function RunHistory({ runs }: { runs: RunRowView[] }) {
  if (runs.length === 0) return null;
  return (
    <details className="text-[11.5px] text-muted">
      <summary className="cursor-pointer">Earlier runs ({runs.length})</summary>
      <ul className="mt-1 grid gap-1 tabular-nums">
        {runs.map((r) => (
          <li key={r.id}>
            {r.startedAt.slice(0, 16).replace("T", " ")} · {r.status.toLowerCase()} · {r.lookupsSpent}/{r.maxLookups} lookups · {r.matches} matches
            {r.lookupsSpent > 0 ? ` · ${Math.round((r.paidMatches / r.lookupsSpent) * 1000) / 10} per 100` : ""}
          </li>
        ))}
      </ul>
    </details>
  );
}
