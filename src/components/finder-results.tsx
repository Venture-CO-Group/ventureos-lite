"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import { finderAddLeads, finderSendToOutbound, finderSuppress } from "@/modules/finder/results-actions";
import { DEFAULT_CRITERIA, HU_COUNTIES, LEGAL_FORMS, finderFilter, type FinderCriteria } from "@/modules/finder/criteria";
import { coverage, subjectFromRow, type FinderRow } from "@/modules/finder/row";
import { SIZE_BAND_DEFS, type SizeBand } from "@/modules/outbound/size-band";
import { BUTTON, INPUT, LABEL } from "./finder-editor";

/**
 * The results (item 5). The refine filters run the SAME `finderFilter` the
 * server ran, over the rows in the browser — so narrowing here can never
 * disagree with what a run would decide. Selection, row actions and bulk
 * actions all go through the same three server actions.
 */

type SortKey = "name" | "city" | "county" | "legalForm" | "employeeCount" | "netRevenue" | "foundedAt" | "email" | "phone" | "website";

const COLS: Array<{ key: SortKey; label: string; numeric?: boolean }> = [
  { key: "name", label: "Company" },
  { key: "city", label: "City" },
  { key: "county", label: "County" },
  { key: "legalForm", label: "Form" },
  { key: "employeeCount", label: "Staff", numeric: true },
  { key: "netRevenue", label: "Revenue", numeric: true },
  { key: "foundedAt", label: "Founded" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "website", label: "Website" },
];

const SOURCE_TAG: Record<string, string> = { registry: "reg", impresszum: "imp", crm: "crm" };
const PAGE = 200;

function sortValue(r: FinderRow, k: SortKey): string | number | null {
  switch (k) {
    case "name":
      return (r.shortName ?? r.legalName).toLowerCase();
    case "employeeCount":
      return r.employeeCount;
    case "netRevenue":
      return r.netRevenue;
    default:
      return (r[k] as string | null)?.toLowerCase() ?? null;
  }
}

const fmtFt = (n: number | null) =>
  n === null ? "" : Math.abs(n) >= 1e9 ? `${(n / 1e9).toFixed(1)} Mrd` : Math.abs(n) >= 1e6 ? `${Math.round(n / 1e6)} M` : n.toLocaleString("hu-HU");
const pct = (x: number) => `${Math.round(x * 100)}%`;

export interface ProfileOption {
  id: string;
  label: string;
}

export interface ResultsSummary {
  lookupsSpent: number;
  paidMatches: number;
}

export function FinderResults({
  listId,
  rows,
  summary,
  profiles,
  canAct,
  exportSlot,
}: {
  listId: string;
  rows: FinderRow[];
  summary: ResultsSummary;
  profiles: ProfileOption[];
  canAct: boolean;
  /** The export control (item 6), handed the rows currently in view and the selection. */
  exportSlot?: (args: { filtered: FinderRow[]; selected: string[] }) => React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [refine, setRefine] = useState<Partial<FinderCriteria>>({});
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");

  // A criteria object that only narrows: everything the run already decided
  // (status, business type, segments) is left wide open here.
  const live: FinderCriteria = useMemo(
    () => ({
      ...DEFAULT_CRITERIA,
      status: "any",
      businessType: "both",
      excludeInCrm: false,
      excludeSuppressed: false,
      includeUnknownSize: true,
      ...refine,
    }),
    [refine],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (needle) {
        const hay = `${r.legalName} ${r.shortName ?? ""} ${r.taxNumber} ${r.city ?? ""} ${r.email ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return finderFilter(live, subjectFromRow(r), []).ok;
    });
    return out.sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      if (x === y) return 0;
      if (x === null) return 1; // blanks last, whichever way
      if (y === null) return -1;
      return (x < y ? -1 : 1) * sort.dir;
    });
  }, [rows, q, live, sort]);

  const cov = coverage(filtered);
  const yieldPer100 = summary.lookupsSpent > 0 ? Math.round((summary.paidMatches / summary.lookupsSpent) * 1000) / 10 : null;
  const selectedIds = [...selected].filter((id) => filtered.some((r) => r.id === id));
  const allSelected = filtered.length > 0 && selectedIds.length === filtered.length;

  const setR = <K extends keyof FinderCriteria>(k: K, v: FinderCriteria[K] | undefined) =>
    setRefine((prev) => {
      const next = { ...prev };
      if (v === undefined || (Array.isArray(v) && v.length === 0)) delete next[k];
      else next[k] = v;
      return next;
    });

  function run(ids: string[], kind: "leads" | "outbound" | "suppress") {
    if (ids.length === 0) return;
    if (kind === "suppress" && !confirm(`Add ${ids.length} compan${ids.length === 1 ? "y" : "ies"} to the suppression list? Every channel will skip them.`)) return;
    setMsg(null);
    startTransition(async () => {
      if (kind === "leads") {
        const res = await attempt(finderAddLeads({ listId, ids }));
        setMsg(res.ok ? `${res.created} lead${res.created === 1 ? "" : "s"} added${res.skipped ? `, ${res.skipped} skipped (${res.firstSkip})` : ""}.` : res.error);
      } else if (kind === "outbound") {
        const res = await attempt(finderSendToOutbound({ listId, ids, profileId }));
        setMsg(res.ok ? `${res.created} new and ${res.updated} known candidates added to the outbound pool.` : res.error);
      } else {
        const res = await attempt(finderSuppress({ listId, ids }));
        setMsg(res.ok ? `${res.added} added to the suppression list.` : res.error);
      }
      setSelected(new Set());
      router.refresh();
    });
  }

  return (
    <section className="grid gap-3 rounded-card border border-line bg-panel p-[18px]" data-testid="finder-results">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-display text-[17px] font-bold lowercase">results</h3>
        <span className="text-[12px] tabular-nums text-muted" data-testid="finder-summary">
          {filtered.length.toLocaleString("hu-HU")}
          {filtered.length !== rows.length ? ` of ${rows.length.toLocaleString("hu-HU")}` : ""} matches · {summary.lookupsSpent} lookups spent
          {yieldPer100 !== null ? ` · yield ${yieldPer100} per 100` : ""} · email {pct(cov.email)} · phone {pct(cov.phone)} · website {pct(cov.website)}
        </span>
      </div>

      {/* Live refine */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="grid gap-1">
          <span className={LABEL}>Search</span>
          <input className={INPUT} value={q} onChange={(e) => setQ(e.target.value)} placeholder="name, tax number, city…" data-testid="finder-search" />
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>County</span>
          <select className={INPUT} value={refine.counties?.[0] ?? ""} onChange={(e) => setR("counties", e.target.value ? [e.target.value] : undefined)}>
            <option value="">Any</option>
            {HU_COUNTIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Size</span>
          <select className={INPUT} value={refine.sizeBands?.[0] ?? ""} onChange={(e) => setR("sizeBands", e.target.value ? [e.target.value as SizeBand] : undefined)}>
            <option value="">Any</option>
            {SIZE_BAND_DEFS.map((d) => (
              <option key={d.band} value={d.band}>{d.label}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Legal form</span>
          <select className={INPUT} value={refine.legalForms?.[0] ?? ""} onChange={(e) => setR("legalForms", e.target.value ? [e.target.value] : undefined)}>
            <option value="">Any</option>
            {LEGAL_FORMS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Must have</span>
          <select
            className={INPUT}
            value={refine.contactRequirement ?? "none"}
            onChange={(e) => setR("contactRequirement", e.target.value === "none" ? undefined : (e.target.value as FinderCriteria["contactRequirement"]))}
            data-testid="finder-refine-contact"
          >
            <option value="none">Nothing</option>
            <option value="any">Any contact</option>
            <option value="email">Email</option>
            <option value="phone">Phone</option>
            <option value="website">Website</option>
          </select>
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Revenue min (M Ft)</span>
          <input
            className={`${INPUT} tabular-nums`}
            inputMode="decimal"
            onChange={(e) => setR("revenueMin", e.target.value.trim() ? Math.round(Number(e.target.value) * 1e6) || 0 : undefined)}
          />
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Revenue max (M Ft)</span>
          <input
            className={`${INPUT} tabular-nums`}
            inputMode="decimal"
            onChange={(e) => setR("revenueMax", e.target.value.trim() ? Math.round(Number(e.target.value) * 1e6) || 0 : undefined)}
          />
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>City</span>
          <input className={INPUT} onChange={(e) => setR("cities", e.target.value.trim() ? [e.target.value.trim()] : undefined)} />
        </label>
      </div>

      {/* Bulk bar */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] tabular-nums text-muted">{selectedIds.length} selected</span>
        {canAct && (
          <>
            <button type="button" className={BUTTON} disabled={pending || selectedIds.length === 0} onClick={() => run(selectedIds, "leads")} data-testid="finder-bulk-leads">
              Add as leads
            </button>
            {profiles.length > 0 && (
              <span className="flex flex-wrap items-center gap-1">
                <select className={`${INPUT} w-auto max-w-[220px]`} value={profileId} onChange={(e) => setProfileId(e.target.value)} aria-label="Outbound product profile">
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
                <button type="button" className={BUTTON} disabled={pending || selectedIds.length === 0 || !profileId} onClick={() => run(selectedIds, "outbound")} data-testid="finder-bulk-outbound">
                  Send to outbound
                </button>
              </span>
            )}
            <button type="button" className={BUTTON} disabled={pending || selectedIds.length === 0} onClick={() => run(selectedIds, "suppress")} data-testid="finder-bulk-suppress">
              Suppress
            </button>
          </>
        )}
        <span className="ml-auto">{exportSlot?.({ filtered, selected: selectedIds })}</span>
      </div>
      {msg && <p className="text-[12px] text-muted" role="status">{msg}</p>}

      <div className="-mx-[18px] overflow-x-auto px-[18px]">
        <table className="w-full min-w-[980px] border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="w-8 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(filtered.map((r) => r.id)))}
                />
              </th>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  className={`py-2 pr-3 ${c.numeric ? "text-right" : ""}`}
                  aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                >
                  <button
                    type="button"
                    className={`text-[10.5px] font-semibold uppercase tracking-[0.1em] ${sort.key === c.key ? "text-ink" : "text-muted"} hover:text-ink`}
                    onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? ((s.dir * -1) as 1 | -1) : 1 }))}
                  >
                    {c.label}
                    {sort.key === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                  </button>
                </th>
              ))}
              {canAct && <th className="py-2" />}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, shown).map((r) => (
              <tr key={r.id} className="border-b border-line/60 align-top" data-testid="finder-row">
                <td className="py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${r.shortName ?? r.legalName}`}
                    checked={selected.has(r.id)}
                    onChange={() =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (n.has(r.id)) n.delete(r.id);
                        else n.add(r.id);
                        return n;
                      })
                    }
                  />
                </td>
                <td className="max-w-[260px] py-2 pr-3">
                  <div className="truncate font-semibold text-ink" title={r.legalName}>{r.shortName ?? r.legalName}</div>
                  <div className="truncate text-[11px] text-muted">
                    {r.taxNumber} · {r.principalActivity ?? "no activity"}
                    {r.inCrm ? " · in CRM" : ""}
                  </div>
                </td>
                <td className="py-2 pr-3">{r.city}</td>
                <td className="py-2 pr-3">{r.county}</td>
                <td className="py-2 pr-3">{r.legalForm}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{r.employeeCount ?? ""}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtFt(r.netRevenue)}</td>
                <td className="py-2 pr-3 tabular-nums">{r.foundedAt?.slice(0, 4)}</td>
                <td className="max-w-[200px] truncate py-2 pr-3">
                  {r.email}
                  {r.emailSource && <span className="ml-1 text-[10px] text-muted">{SOURCE_TAG[r.emailSource]}</span>}
                </td>
                <td className="whitespace-nowrap py-2 pr-3">
                  {r.phone}
                  {r.phoneSource && <span className="ml-1 text-[10px] text-muted">{SOURCE_TAG[r.phoneSource]}</span>}
                </td>
                <td className="max-w-[180px] truncate py-2 pr-3">
                  {r.website && (
                    <a href={r.website} target="_blank" rel="noreferrer noopener" className="underline">
                      {r.website.replace(/^https?:\/\//, "")}
                    </a>
                  )}
                  {r.websiteSource && <span className="ml-1 text-[10px] text-muted">{SOURCE_TAG[r.websiteSource]}</span>}
                </td>
                {canAct && (
                  <td className="whitespace-nowrap py-2">
                    <RowMenu
                      disabled={pending}
                      onLead={() => run([r.id], "leads")}
                      onOutbound={profiles.length ? () => run([r.id], "outbound") : null}
                      onSuppress={() => run([r.id], "suppress")}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length === 0 && <p className="text-[12.5px] text-muted">No matches{rows.length ? " for these refinements" : " yet"}.</p>}
      {filtered.length > shown && (
        <button type="button" className={`${BUTTON} justify-self-start`} onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, filtered.length - shown)} more
        </button>
      )}
      <p className="text-[11px] text-muted">Contact sources: reg = company registry · imp = the company&apos;s imprint page · crm = our CRM.</p>
    </section>
  );
}

function RowMenu({
  disabled,
  onLead,
  onOutbound,
  onSuppress,
}: {
  disabled: boolean;
  onLead: () => void;
  onOutbound: (() => void) | null;
  onSuppress: () => void;
}) {
  return (
    <details className="relative">
      <summary className="min-h-[36px] cursor-pointer list-none rounded-[8px] border border-line px-2 py-1 text-[12px] text-muted hover:text-ink" aria-label="Row actions">
        ⋯
      </summary>
      <div className="absolute right-0 z-10 mt-1 grid w-[190px] gap-0.5 rounded-[10px] border border-line bg-[#0B1030] p-1 shadow-lg">
        <button type="button" disabled={disabled} className="min-h-[36px] rounded-[7px] px-2 text-left text-[12.5px] hover:bg-panel" onClick={onLead}>
          Add as lead
        </button>
        {onOutbound && (
          <button type="button" disabled={disabled} className="min-h-[36px] rounded-[7px] px-2 text-left text-[12.5px] hover:bg-panel" onClick={onOutbound}>
            Send to outbound (selected profile)
          </button>
        )}
        <button type="button" disabled={disabled} className="min-h-[36px] rounded-[7px] px-2 text-left text-[12.5px] hover:bg-panel" onClick={onSuppress}>
          Suppress
        </button>
      </div>
    </details>
  );
}
