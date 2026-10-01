"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import {
  addSearchToPool,
  cancelRun,
  estimateRun,
  importPoolCsv,
  previewPoolCsv,
  startManualRun,
} from "@/modules/outbound/run-actions";
import type { RunEstimate, RunRow } from "@/modules/outbound/run-store";
import type { ProductView, SegmentView } from "@/modules/outbound/catalog";

/**
 * Sourcing runs by hand (playbook-v6 F3/8).
 *
 * The launcher will not start a run until the estimate has been shown —
 * pool size, expected registry lookups, their share of the month — and the
 * server refuses a start whose estimate has grown since. Spending quota is a
 * decision, not a side effect of a button.
 */

const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent";
const LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted";
const BUTTON =
  "min-h-[40px] rounded-[9px] border border-line px-3 py-2 text-[12.5px] font-semibold text-ink hover:border-accent disabled:opacity-45";
const PRIMARY =
  "min-h-[40px] rounded-[9px] border border-accent bg-[linear-gradient(135deg,#310B59,#7427C6)] px-3.5 py-2 text-[12.5px] font-semibold text-white shadow-[0_0_18px_rgba(116,39,198,0.35)] disabled:opacity-45";

const STATUS: Record<string, { label: string; cls: string }> = {
  RUNNING: { label: "running", cls: "text-accent-ink" },
  AWAITING_AUDITS: { label: "waiting for audits", cls: "text-accent-ink" },
  PAUSED_QUOTA: { label: "paused — quota", cls: "text-[#FFD27A]" },
  DONE: { label: "done", cls: "text-pos" },
  FAILED: { label: "failed", cls: "text-[#FFB3C2]" },
  CANCELLED: { label: "cancelled", cls: "text-muted" },
};

const CHANNELS = [
  { value: "all", label: "Whole pool (harvest + seeds + imports)" },
  { value: "NAME_HARVEST", label: "Name-fragment harvest" },
  { value: "SEED_LIST", label: "Seed lists" },
  { value: "PLACES", label: "Google Places (from the Prospector)" },
  { value: "CSV", label: "CSV imports" },
];

export interface SearchOption {
  id: string;
  label: string;
}

export function OutboundRuns({
  products,
  runs,
  segments,
  searches,
  canRun,
}: {
  products: ProductView[];
  runs: RunRow[];
  segments: SegmentView[];
  searches: SearchOption[];
  canRun: boolean;
}) {
  const router = useRouter();
  const live = runs.some((r) => r.status === "RUNNING" || r.status === "AWAITING_AUDITS");
  // Poll while something is moving; stop as soon as nothing is.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [live, router]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="grid content-start gap-4">
        {canRun && <Launcher products={products} />}
        <section className="grid gap-2" data-testid="run-list">
          <h3 className="font-display text-[17px] font-bold lowercase">runs</h3>
          {runs.length === 0 && <p className="text-[12.5px] text-muted">No runs yet.</p>}
          {runs.map((r) => (
            <RunCard key={r.id} run={r} canRun={canRun} />
          ))}
        </section>
      </div>
      {canRun && (
        <aside className="grid content-start gap-4">
          <CsvImport segments={segments} />
          <PlacesImport segments={segments} searches={searches} />
        </aside>
      )}
    </div>
  );
}

function Launcher({ products }: { products: ProductView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const profiles = products.flatMap((p) => p.profiles.filter((x) => x.active).map((x) => ({ ...x, productName: p.name })));
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [channel, setChannel] = useState("all");
  const [requested, setRequested] = useState(10);
  const [estimate, setEstimate] = useState<RunEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);

  const input = { profileId, channel, requested };
  const reset = () => setEstimate(null);

  function doEstimate() {
    setError(null);
    startTransition(async () => {
      const res = await attempt(estimateRun(input));
      if (!res.ok) setError(res.error);
      else setEstimate(res.estimate);
    });
  }
  function doStart() {
    if (!estimate) return;
    setError(null);
    startTransition(async () => {
      const res = await attempt(startManualRun({ ...input, confirmedLookups: estimate.expectedLookups }));
      if (!res.ok) {
        setError(res.error);
        setEstimate(null);
        return;
      }
      setEstimate(null);
      router.refresh();
    });
  }

  if (profiles.length === 0) {
    return (
      <p className="rounded-card border border-line bg-panel p-4 text-[12.5px] text-muted">
        No active ICP profile yet. <Link href="/outbound/products" className="underline">Create one</Link> on a product first.
      </p>
    );
  }

  return (
    <section className="grid gap-3 rounded-card border border-line bg-panel p-[18px]" data-testid="run-launcher">
      <h3 className="font-display text-[17px] font-bold lowercase">new run</h3>
      {error && <p className="text-[12px] text-[#FFB3C2]">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-[2fr_2fr_1fr]">
        <label className="grid gap-1">
          <span className={LABEL}>Product · profile</span>
          <select className={INPUT} value={profileId} onChange={(e) => { setProfileId(e.target.value); reset(); }}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.productName} · {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Channel</span>
          <select className={INPUT} value={channel} onChange={(e) => { setChannel(e.target.value); reset(); }}>
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Qualified wanted</span>
          <input
            className={`${INPUT} tabular-nums`}
            type="number"
            min={1}
            max={200}
            value={requested}
            onChange={(e) => { setRequested(Number(e.target.value) || 1); reset(); }}
          />
        </label>
      </div>
      {estimate && (
        <div className="grid gap-1 rounded-[10px] border border-line p-3 text-[12.5px] tabular-nums" data-testid="run-estimate">
          <span>
            {estimate.eligible} companies in the pool for this profile · about{" "}
            <b className="text-ink">{estimate.expectedLookups} registry lookups</b> (
            {Math.round(estimate.monthShare * 1000) / 10}% of the month) at a{" "}
            {Math.round(estimate.passRate * 100)}% pass rate{estimate.passRateFromHistory ? " observed so far" : " (default until there is history)"}.
          </span>
          <span className="text-muted">
            {estimate.remainingToday} left in today&apos;s allocation · {estimate.monthRemaining} left this month. An upper
            bound: cached datasheets cost nothing.
            {estimate.exceedsToday ? " The run will pause when today's allocation runs out and resume on the next pass." : ""}
          </span>
          {estimate.eligible === 0 && (
            <span className="text-[#FFD27A]">
              The pool is empty for this profile — the run will harvest its segments first, which is free.
            </span>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON} disabled={pending || !profileId} onClick={doEstimate} data-testid="run-estimate-btn">
          {pending && !estimate ? "Estimating…" : "Estimate"}
        </button>
        <button type="button" className={PRIMARY} disabled={pending || !estimate} onClick={doStart} data-testid="run-start">
          {pending && estimate ? "Starting…" : "Start run"}
        </button>
      </div>
    </section>
  );
}

function RunCard({ run, canRun }: { run: RunRow; canRun: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const st = STATUS[run.status] ?? { label: run.status.toLowerCase(), cls: "text-muted" };
  const qualified =
    (run.counters.byState.CONTACT_RESOLVED ?? 0) +
    (run.counters.byState.DRAFTED ?? 0) +
    (run.counters.byState.PENDING_APPROVAL ?? 0) +
    (run.counters.byState.APPROVED ?? 0) +
    (run.counters.byState.SENT ?? 0) +
    (run.counters.byState.REPLIED ?? 0);
  const active = run.status === "RUNNING" || run.status === "AWAITING_AUDITS" || run.status === "PAUSED_QUOTA";
  return (
    <div className="grid gap-1 rounded-card border border-line bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/outbound/runs/${run.id}`} className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink hover:underline">
          {run.productName ?? "—"} · {run.profileName ?? "deleted profile"}
        </Link>
        <span className={`text-[11.5px] font-semibold ${st.cls}`}>{st.label}</span>
      </div>
      <span className="text-[11.5px] tabular-nums text-muted">
        {run.trigger.toLowerCase()} · {run.startedAt.slice(0, 16).replace("T", " ")} · {qualified}/{run.requested} ready to draft ·{" "}
        {run.counters.total} evaluated · {run.quotaUsed} lookups
      </span>
      {run.message && <span className="text-[11.5px] text-muted">{run.message}</span>}
      {canRun && active && (
        <button
          type="button"
          className="justify-self-start text-[11.5px] text-muted underline hover:text-ink disabled:opacity-45"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await attempt(cancelRun(run.id));
              router.refresh();
            })
          }
        >
          Cancel
        </button>
      )}
    </div>
  );
}

function CsvImport({ segments }: { segments: SegmentView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [csv, setCsv] = useState("");
  const [headers, setHeaders] = useState<string[] | null>(null);
  const [segmentKey, setSegmentKey] = useState(segments[0]?.key ?? "");
  const [map, setMap] = useState<{ name: number; taxNumber: number | null; website: number | null; city: number | null }>({
    name: 0,
    taxNumber: null,
    website: null,
    city: null,
  });
  const [msg, setMsg] = useState<string | null>(null);

  async function onFile(f: File) {
    const text = await f.text();
    setCsv(text);
    const res = await attempt(previewPoolCsv(text));
    if (!res.ok) setMsg(res.error);
    else {
      setHeaders(res.headers);
      const find = (re: RegExp) => {
        const i = res.headers.findIndex((h) => re.test(h));
        return i >= 0 ? i : null;
      };
      setMap({
        name: find(/név|name|cég/i) ?? 0,
        taxNumber: find(/adószám|tax|vat/i),
        website: find(/web|url|honlap/i),
        city: find(/város|city|település/i),
      });
      setMsg(`${res.rows} rows read.`);
    }
  }

  function doImport() {
    startTransition(async () => {
      const res = await attempt(importPoolCsv({ segmentKey, csv, mapping: map }));
      if (!res.ok) setMsg(res.error);
      else {
        setMsg(`${res.created} added, ${res.updated} already known${res.skipped.length ? `, ${res.skipped.length} skipped (first: row ${res.skipped[0]!.row}, ${res.skipped[0]!.reason})` : ""}.`);
        setHeaders(null);
        setCsv("");
        router.refresh();
      }
    });
  }

  const col = (k: keyof typeof map, label: string, optional = true) =>
    headers && (
      <label className="grid gap-1">
        <span className={LABEL}>{label}</span>
        <select
          className={INPUT}
          value={map[k] ?? ""}
          onChange={(e) => setMap((m) => ({ ...m, [k]: e.target.value === "" ? null : Number(e.target.value) }))}
        >
          {optional && <option value="">— none —</option>}
          {headers.map((h, i) => (
            <option key={i} value={i}>
              {h || `column ${i + 1}`}
            </option>
          ))}
        </select>
      </label>
    );

  return (
    <section className="grid gap-2 rounded-card border border-line bg-panel p-[18px]" data-testid="pool-csv">
      <h3 className="font-display text-[16px] font-bold lowercase">import a list</h3>
      <p className="text-[11.5px] text-muted">A CSV of companies into the pool — a name column at least, a tax number if you have one.</p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} className="text-[12px]" />
      {headers && (
        <>
          <label className="grid gap-1">
            <span className={LABEL}>Segment</span>
            <select className={INPUT} value={segmentKey} onChange={(e) => setSegmentKey(e.target.value)}>
              {segments.filter((s) => !s.archived).map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {col("name", "Company name", false)}
          {col("taxNumber", "Tax number")}
          {col("website", "Website")}
          {col("city", "City")}
          <button type="button" className={BUTTON} disabled={pending} onClick={doImport}>
            {pending ? "Importing…" : "Add to pool"}
          </button>
        </>
      )}
      {msg && <p className="text-[11.5px] text-muted">{msg}</p>}
    </section>
  );
}

function PlacesImport({ segments, searches }: { segments: SegmentView[]; searches: SearchOption[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [searchId, setSearchId] = useState(searches[0]?.id ?? "");
  const [segmentKey, setSegmentKey] = useState(segments.find((s) => s.sourcingHint === "PLACES")?.key ?? segments[0]?.key ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  if (searches.length === 0) return null;
  return (
    <section className="grid gap-2 rounded-card border border-line bg-panel p-[18px]" data-testid="pool-places">
      <h3 className="font-display text-[16px] font-bold lowercase">from the prospector</h3>
      <p className="text-[11.5px] text-muted">Results already fetched from Google Places — no new spend.</p>
      <select className={INPUT} value={searchId} onChange={(e) => setSearchId(e.target.value)}>
        {searches.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      <select className={INPUT} value={segmentKey} onChange={(e) => setSegmentKey(e.target.value)}>
        {segments.filter((s) => !s.archived).map((s) => (
          <option key={s.key} value={s.key}>
            {s.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={BUTTON}
        disabled={pending || !searchId}
        onClick={() =>
          startTransition(async () => {
            const res = await attempt(addSearchToPool({ searchId, segmentKey }));
            setMsg(res.ok ? `${res.created} added, ${res.updated} already known.` : res.error);
            router.refresh();
          })
        }
      >
        Add to pool
      </button>
      {msg && <p className="text-[11.5px] text-muted">{msg}</p>}
    </section>
  );
}
