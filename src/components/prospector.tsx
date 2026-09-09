"use client";
import { serverActionError } from "@/lib/client/server-action";

import { useMemo, useState, useTransition } from "react";
import { estimateProspectCostUsd } from "@/modules/prospector/cost";
import { BulkBar, type BulkAction } from "./bulk-bar";
import { useBulkSelection } from "./use-bulk-selection";
import { bulkAddProspects, bulkAuditProspects } from "@/modules/prospector/bulk-actions";
import type {
  ProspectRow,
  ProspectSearchResult,
  SavedSearch,
} from "@/modules/prospector/types";
import {
  runProspectSearch,
  addProspectAsLead,
  classifyProspects,
} from "@/modules/prospector/actions";

function WebsiteChip({ presence }: { presence: ProspectRow["presence"] }) {
  if (presence === "none")
    return (
      <span className="rounded-full bg-[rgba(245,184,65,0.14)] px-2.5 py-0.5 text-[11px] font-semibold text-warn">
        No website
      </span>
    );
  if (presence === "facebook")
    return (
      <span className="rounded-full bg-[rgba(133,140,174,0.15)] px-2.5 py-0.5 text-[11px] font-semibold text-muted">
        Facebook only
      </span>
    );
  return (
    <span className="rounded-full bg-[rgba(61,220,151,0.1)] px-2.5 py-0.5 text-[11px] font-semibold text-[#3DDC97]">
      Has website
    </span>
  );
}

/**
 * Google says this business is shut.
 *
 * Worth a warning rather than a quiet field: a permanently closed business is a
 * wasted lead, a wasted audit and eventually a wasted email, and the status
 * arrived with every search — it was simply never asked for.
 */
function StatusChip({ status }: { status?: string | null }) {
  if (status !== "CLOSED_PERMANENTLY" && status !== "CLOSED_TEMPORARILY") return null;
  const permanent = status === "CLOSED_PERMANENTLY";
  return (
    <span
      className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        permanent
          ? "bg-[rgba(255,92,122,0.14)] text-[#FFB3C2]"
          : "bg-[rgba(245,184,65,0.14)] text-warn"
      }`}
    >
      {permanent ? "Permanently closed" : "Temporarily closed"}
    </span>
  );
}

function FitChip({ fit, priority }: { fit: string; priority: number }) {
  const color =
    fit === "strong"
      ? "text-[#3DDC97]"
      : fit === "possible"
        ? "text-accent-ink"
        : "text-muted";
  return (
    <span className={`ml-2 text-[11px] font-semibold ${color}`}>
      {fit} · P{priority}
    </span>
  );
}

export function Prospector({ saved }: { saved: SavedSearch[] }) {
  const [pending, startTransition] = useTransition();
  const [keyword, setKeyword] = useState("vízvezetékszerelő");
  const [location, setLocation] = useState("Budapest");
  const [radius, setRadius] = useState("15 km");
  // Google returns 20 per page and at most 3 pages; each page is billed.
  const [depth, setDepth] = useState(20);
  const [result, setResult] = useState<ProspectSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Record<number, "added" | "duplicate">>({});
  const [classifying, setClassifying] = useState(false);
  // What the classifier actually managed — "25 of 60" is information the
  // operator needs and never used to get.
  const [classifyNote, setClassifyNote] = useState<string | null>(null);

  /**
   * Bulk actions on the results (playbook-v5 P17/1).
   *
   * ── DISMISS IS THE ONE THAT IS NOT A SERVER CALL ────────────────────────
   *
   * A prospector result is not a row yet — it comes back from Places and only
   * becomes a company when somebody adds it. So dismissing one is a statement
   * about THIS list, kept here, and there is nothing to persist. Add-as-leads
   * and run-audits do reach the server, and both take the payloads rather than
   * ids for the same reason: there are no ids yet.
   */
  const [dismissed, setDismissed] = useState<string[]>([]);
  const visible = useMemo(
    () =>
      (result?.results ?? []).filter(
        (r, i) => !dismissed.includes(r.placeId ?? `${r.name}-${i}`),
      ),
    [result, dismissed],
  );
  const selection = useBulkSelection(visible.length);
  const byKey = useMemo(() => {
    const map = new Map<string, ProspectRow>();
    (result?.results ?? []).forEach((r, i) => map.set(r.placeId ?? `${r.name}-${i}`, r));
    return map;
  }, [result]);

  const bulkActions = useMemo<BulkAction<unknown>[]>(
    () => [
      {
        key: "add",
        label: "Add as leads",
        noun: "prospect",
        verb: "added",
        run: async (ids) => {
          const payloads = ids
            .map((id) => byKey.get(id))
            .filter(Boolean)
            .map((r) => ({
              placeId: r!.placeId ?? null,
              name: r!.name,
              category: r!.category ?? null,
              phone: r!.phone ?? null,
              websiteUri: r!.websiteUri ?? null,
              address: r!.address ?? null,
              city: r!.city ?? null,
              businessStatus: r!.businessStatus ?? null,
              rating: r!.rating ?? null,
              reviews: r!.reviews ?? null,
            }));
          return bulkAddProspects(payloads);
        },
      },
      {
        key: "audit",
        label: "Run audits",
        noun: "prospect",
        verb: "queued",
        run: async (ids) => {
          const payloads = ids
            .map((id) => byKey.get(id))
            .filter(Boolean)
            .map((r) => ({
              placeId: r!.placeId ?? null,
              name: r!.name,
              websiteUri: r!.websiteUri ?? null,
            }));
          return bulkAuditProspects(payloads);
        },
      },
      {
        key: "dismiss",
        label: "Dismiss",
        noun: "prospect",
        verb: "dismissed",
        run: async (ids) => {
          // Local only: see the note above. Resolves immediately, and the rows
          // leave the list.
          setDismissed((current) => [...new Set([...current, ...ids])]);
          return { applied: ids.length, skipped: [] };
        },
      },
    ],
    [byKey],
  );

  const estimate = estimateProspectCostUsd({ expectedResults: depth });

  async function run(kw = keyword, loc = location, rad = radius, max = depth) {
    setError(null);
    setAdded({});
    setClassifyNote(null);
    try {
      const res = await runProspectSearch({
        keyword: kw,
        location: loc,
        radius: rad,
        maxResults: max,
      });
      setResult(res);
    } catch (e) {
      setResult(null);
      setError(serverActionError(e));
    }
  }

  async function add(row: ProspectRow, index: number) {
    // Everything the search paid for, not a subset of it: the city, the place
    // id and the rating all arrived with the row and used to stop at this line.
    const res = await addProspectAsLead({
      placeId: row.placeId,
      name: row.name,
      category: row.category,
      phone: row.phone,
      websiteUri: row.websiteUri,
      address: row.address,
      city: row.city,
      businessStatus: row.businessStatus,
      rating: row.rating,
      reviews: row.reviews,
    });
    setAdded((m) => ({ ...m, [index]: res.ok ? "added" : "duplicate" }));
  }

  async function classify() {
    if (!result) return;
    setClassifying(true);
    setClassifyNote(null);
    try {
      const outcome = await classifyProspects(result.searchId);
      // Re-run from cache to pull the merged classifications back.
      const res = await runProspectSearch({ keyword, location, radius, maxResults: depth });
      setResult(res);
      setClassifyNote(
        outcome.note ?? `Classified ${outcome.classified} of ${outcome.total}.`,
      );
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setClassifying(false);
    }
  }

  const input =
    "min-w-[150px] flex-1 rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent";

  return (
    <div className="max-w-[1400px]">
      {error && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3.5 py-2.5 text-[12.5px] text-[#FFB3C2]">
          {error}
        </div>
      )}

      {result?.notice && (
        <div className="mb-3 rounded-[10px] border border-[rgba(245,184,65,0.35)] bg-[rgba(245,184,65,0.1)] px-3.5 py-2.5 text-[12.5px] text-warn">
          {result.notice}
        </div>
      )}

      <div className="mb-1 rounded-card border border-line bg-panel p-[18px]">
        <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Find businesses on Google
        </div>
        <div className="flex flex-wrap gap-2.5">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="Keyword — e.g. plumber, restaurant, dental clinic"
            className={input}
          />
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Location"
            className={`${input} max-w-[180px]`}
          />
          <input
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
            placeholder="Radius"
            className={`${input} max-w-[90px]`}
          />
          {/*
            Search depth. Google's Text Search hands back 20 results per page
            and stops after three pages, so 60 is the ceiling — not a setting
            we chose. Each extra page is a separately billed request, which is
            why this is an explicit choice rather than always fetching 60.
          */}
          <select
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
            title="How many results to fetch — each 20 is one billed Places request"
            className={`${input} max-w-[130px]`}
          >
            <option value={20}>20 results</option>
            <option value={40}>40 results</option>
            <option value={60}>60 (max)</option>
          </select>
          <button
            onClick={() => startTransition(() => run())}
            disabled={pending}
            className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
          >
            {pending ? "Running…" : "Run search"}
          </button>
        </div>
        <p className="mt-2.5 text-[11.5px] text-muted">
          Estimated cost: ~${estimate.toFixed(2)} Places API for {depth} results
          ({Math.ceil(depth / 20)} request{depth > 20 ? "s" : ""}) ·{" "}
          <b className="text-[#C9CEE3]">0 Claude calls</b> — results come from
          Google directly. Cached 30 days.
        </p>
      </div>

      {result && (
        <div className="font-display text-[17px] font-bold [margin:18px_0_4px]">
          {result.summary}
          {result.fromCache && (
            <span className="ml-2 text-[12px] font-normal text-muted">· cached (0 cost)</span>
          )}
        </div>
      )}

      {saved.length > 0 && (
        <p className="mb-3 text-[12px] text-muted">
          Saved searches:{" "}
          {saved.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setKeyword(s.keyword);
                setLocation(s.location);
                startTransition(() => run(s.keyword, s.location, radius));
              }}
              className="ml-1 mb-1 inline-flex items-center rounded-full border border-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-ink hover:bg-accent-soft"
            >
              {s.keyword} · {s.location}
            </button>
          ))}
        </p>
      )}

      {result && (
        <>
          <div className="rounded-card border border-line bg-panel px-0 pb-0 pt-1.5">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {["Business", "Rating", "Website", "Phone", ""].map((h) => (
                    <th
                      key={h}
                      className="border-b border-line px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.results.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-center text-[13px] text-muted" colSpan={5}>
                      No results.
                    </td>
                  </tr>
                )}
                {result.results.map((r, i) => {
                  const key = r.placeId ?? `${r.name}-${i}`;
                  if (dismissed.includes(key)) return null;
                  return (
                  <tr key={i} className="hover:[&>td]:bg-panel">
                    <td className="border-b border-line px-3 py-3 text-[13px] align-middle">
                      <span className="mr-1.5 inline-flex align-middle">
                        <input
                          type="checkbox"
                          checked={selection.isSelected(key)}
                          onChange={() => selection.toggle(key)}
                          data-testid="prospect-select"
                          aria-label={`Select ${r.name}`}
                          style={{ accentColor: "#7427C6" }}
                        />
                      </span>
                      <b>{r.name}</b>
                      <StatusChip status={r.businessStatus} />
                      {r.classification && (
                        <FitChip fit={r.classification.fit} priority={r.classification.priority} />
                      )}
                      <span className="block text-[12px] text-muted">
                        {[r.category, r.address].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </td>
                    <td className="border-b border-line px-3 py-3 text-[13px] align-middle">
                      {r.rating != null ? `${r.rating} ★ (${r.reviews ?? 0})` : "—"}
                    </td>
                    <td className="border-b border-line px-3 py-3 align-middle">
                      <WebsiteChip presence={r.presence} />
                    </td>
                    <td className="border-b border-line px-3 py-3 text-[12px] align-middle text-muted">
                      {r.phone ?? "—"}
                    </td>
                    <td className="border-b border-line px-3 py-3 align-middle">
                      <div className="flex justify-end gap-2">
                        {r.presence === "has" && r.websiteUri && (
                          <a
                            href={`/audit?url=${encodeURIComponent(r.websiteUri)}`}
                            className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2"
                          >
                            Audit site
                          </a>
                        )}
                        {added[i] ? (
                          <span
                            className={`text-[12px] ${added[i] === "added" ? "text-[#3DDC97]" : "text-warn"}`}
                          >
                            {added[i] === "added" ? "Added ✓" : "Duplicate"}
                          </span>
                        ) : (
                          <button
                            onClick={() => startTransition(() => add(r, i))}
                            disabled={pending}
                            className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2 disabled:opacity-60"
                          >
                            Add as lead
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <BulkBar selection={selection} actions={bulkActions} />

          <div className="mt-3.5 flex items-center gap-2.5">
            <button
              onClick={() => startTransition(classify)}
              disabled={classifying || pending}
              className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] font-semibold text-ink hover:bg-panel-2 disabled:opacity-60"
            >
              ✦ Classify fit with Claude{" "}
              <span className="font-normal text-muted">· 1 Haiku call / 25 rows</span>
            </button>
            <span className="text-[12px] text-muted">
              {classifying
                ? "Classifying…"
                : (classifyNote ?? "Optional — off by default to save credits")}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
