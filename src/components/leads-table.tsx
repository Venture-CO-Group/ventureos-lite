"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { moveLeadStage, runResearch } from "@/modules/leads/actions";
import { attempt } from "@/lib/client/server-action";
import { columnsWithCustom } from "@/modules/leads/columns";
import type { FilterSet, SortField, SortSpec } from "@/modules/leads/filters";
import type { LeadFacets, LeadTableRow } from "@/modules/leads/table";
import { serializeColumns, serializeFilterSet, serializeSort } from "@/modules/leads/view-params";
import type { LeadView } from "@/modules/leads/views";
import { LeadBulkBar } from "./lead-bulk-bar";
import { LeadFilterBuilder } from "./lead-filter-builder";
import { LeadViewTabs } from "./lead-view-tabs";
import { ExportSchedules } from "./export-schedules";
import { LeadDetailModal } from "./lead-detail-modal";
import { EnrichDialog, OverrideDialog } from "./lead-dialogs";
import { LeadAvatar } from "./lead-avatar";
import { RiskChip } from "./risk-chip";
import {
  customFieldKey,
  formatValue,
  isCustomFieldRef,
  type CustomFieldType,
  type FieldDef,
} from "@/modules/fields/types";
import { editLeadField } from "@/modules/leads/inline-actions";
import { InlineCell, type InlineKind } from "./inline-cell";
import { PIPELINE_STAGES, SIDE_STAGES, STAGE_LABELS } from "@/modules/pipeline/transitions";
import { EmptyState } from "./empty-state";

/**
 * The leads table (playbook-v2 P3/2): selectable columns, sorting, pagination
 * and the filter builder above it.
 *
 * All of the table's state — filter, sort, columns, page — lives in the URL.
 * That is what makes a filtered table linkable and refresh-proof, and it is
 * also what lets a saved view be nothing more cunning than a stored query
 * string. The server does the filtering; this component only navigates.
 */

export interface LeadsTableProps {
  rows: LeadTableRow[];
  columns: string[];
  sort: SortSpec;
  filters: FilterSet;
  facets: LeadFacets;
  /** Owner-defined lead fields (P5/1): extra columns and filter conditions. */
  customFields?: FieldDef[];
  threshold: number;
  page: number;
  pageCount: number;
  total: number;
  totalUnfiltered: number;
  views: LeadView[];
  activeViewId: string | null;
  currentUserId: string;
  canCurateViews: boolean;
  /** Owner-only, matching the single-lead delete. */
  canDelete: boolean;
  /** `exports.run` grant (spec §3). */
  canExport: boolean;
}

/** One custom-field cell, formatted by its definition (P5/1). */
function CustomCell({ def, value }: { def?: FieldDef; value?: unknown }) {
  if (!def) return <span className="text-muted">—</span>;
  const text = formatValue(def, value as never);
  if (!text) return <span className="text-muted">—</span>;
  if (def.type === "URL") {
    return (
      <a
        href={text}
        target="_blank"
        rel="noreferrer noopener"
        className="text-accent-ink underline-offset-2 hover:underline"
      >
        {text.replace(/^https?:\/\//, "")}
      </a>
    );
  }
  return <span className="text-[12.5px]">{text}</span>;
}

/** Which editor a custom field's type gets in a table cell (P7/1). */
const INLINE_KIND: Record<CustomFieldType, InlineKind> = {
  TEXT: "text",
  URL: "text",
  NUMBER: "number",
  DATE: "date",
  SELECT: "select",
  MULTISELECT: "multiselect",
  CHECKBOX: "checkbox",
};

/**
 * Stages a cell may move a lead to. Disqualified is absent on purpose: it
 * requires a reason, and a dropdown has nowhere to ask for one — the server
 * refuses it too, so this is the UI agreeing with the rule rather than
 * enforcing it.
 */
const STAGE_OPTIONS = [...PIPELINE_STAGES, ...SIDE_STAGES]
  .filter((s) => s !== "DISQUALIFIED")
  .map((s) => ({ value: s, label: STAGE_LABELS[s] }));

function Notches({ score }: { score: number | null }) {
  const n = score ?? 0;
  return (
    <span className="inline-flex gap-[3px] align-middle">
      {Array.from({ length: 5 }).map((_, i) => (
        <i key={i} className={`h-[5px] w-[9px] rounded-[2px] ${i < n ? "bg-grad" : "bg-line"}`} />
      ))}
    </span>
  );
}

/**
 * A signal pill, sized for a column that is scanned rather than read.
 *
 * The margins are gone because the row lays the pills out with `gap`, and the
 * vertical one (`mb-1`) was half of why a signals cell could be two lines tall.
 * `max-w` plus `truncate` is the other half: a long trigger phrase now shortens
 * instead of widening the column, and the full text is on the cell's title.
 */
function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex max-w-[8.5rem] items-center truncate rounded-full border border-accent-soft px-1.5 py-px text-[10.5px] font-semibold leading-[1.35] text-accent-ink">
      {children}
    </span>
  );
}

/** "3 days ago" beats a timestamp for a column people scan rather than read. */
function relativeDays(date: Date | string | null): string {
  if (!date) return "—";
  const at = typeof date === "string" ? new Date(date) : date;
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} yr ago`;
}

function humanEnum(v: string): string {
  return v.toLowerCase().replace(/_/g, " ");
}

export function LeadsTable(props: LeadsTableProps) {
  const {
    rows,
    columns,
    sort,
    filters,
    facets,
    threshold,
    page,
    pageCount,
    total,
    totalUnfiltered,
    views,
    activeViewId,
    currentUserId,
    canCurateViews,
    canDelete,
    canExport,
    customFields = [],
  } = props;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [enrichFor, setEnrichFor] = useState<string | null>(null);
  const [showColumns, setShowColumns] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Ticked rows. Ids rather than indices, so paging cannot shift the meaning. */
  const [selected, setSelected] = useState<string[]>([]);
  /**
   * "Select all matching" is a MODE, not 5,000 ids in component state: the
   * server resolves the filter when the action runs, so the selection cannot go
   * stale between ticking it and using it.
   */
  const [allMatching, setAllMatching] = useState(false);

  // Built-ins plus this workspace's own fields (P5/1).
  const allColumns = useMemo(() => columnsWithCustom(customFields), [customFields]);

  const visible = useMemo(
    () => {
      return columns
        .map((key) => allColumns.find((c) => c.key === key))
        .filter((c): c is NonNullable<typeof c> => !!c);
    },
    [columns, allColumns],
  );

  /**
   * Rewrite the query string. Any change of shape resets to page 1.
   *
   * Deliberately NOT wrapped in startTransition. A transition defers the URL
   * update until the new server render commits, and during that window the
   * query string still described the previous table — which is how "Save as
   * view" managed to store the filter you had before the one you were looking
   * at. The URL is the table's state, so it updates first and everything else
   * follows from it.
   */
  /**
   * One inline edit (P7/1). The server is the boundary: the score gate, the
   * qualification gate, field validation and the tenant guard all live there,
   * and the cell renders whatever comes back.
   */
  async function saveCell(
    leadId: string,
    field: string,
    value: string | string[] | boolean | null,
  ) {
    /**
     * `attempt`, because the cell awaits this bare.
     *
     * A Server Action that THROWS rather than returns arrives at the client as
     * a message-less Error. Here that rejection propagated into `InlineCell`'s
     * `await onSave(next)`, which meant `setSaving(false)` never ran: the cell
     * sat in its saving state for ever, showed no error, and kept the edit. The
     * refusals were always handled — it was the unexpected failures that had
     * nowhere to land.
     */
    return attempt(editLeadField({ leadId, field, value }));
  }

  const navigate = useCallback(
    (changes: Record<string, string | undefined>, keepPage = false) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) next.delete(key);
        else next.set(key, value);
      }
      if (!keepPage) next.delete("page");
      router.push(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  function toggleSort(field: SortField) {
    const direction = sort.field === field && sort.direction === "desc" ? "asc" : "desc";
    navigate({ sort: serializeSort({ field, direction }) });
  }

  function applyFilters(next: FilterSet) {
    // Changing the filter abandons any saved view being previewed: the tab is
    // no longer describing what is on screen.
    navigate({ f: serializeFilterSet(next), view: undefined });
  }

  function toggleColumn(key: string) {
    const on = columns.includes(key);
    const next = on ? columns.filter((c) => c !== key) : [...columns, key];
    navigate({ cols: serializeColumns(next) }, true);
  }

  async function research(leadId: string) {
    setError(null);
    /**
     * A refused research is an ANSWER, not a crash — the table shows it in the
     * same error strip it uses for a refused stage move.
     *
     * `attempt` is what makes "Run research does nothing" impossible. This used
     * to be a try/catch rendering `(e as Error).message`, and a Server Action
     * that throws in production arrives with an EMPTY message — so `setError("")`
     * left the strip unrendered (`{error && …}`) and the button looked dead.
     * Every path out of here now produces something the operator can read.
     */
    const res = await attempt(runResearch(leadId));
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  async function toContacted(leadId: string) {
    setError(null);
    const res = await attempt(moveLeadStage(leadId, "CONTACTED"));
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  const filtered = filters.conditions.length > 0;
  const pageIds = rows.map((r) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));

  function toggleRow(id: string) {
    // Ticking a row leaves the "all matching" mode: the user is now naming
    // rows, so the selection must stop meaning "everything the filter finds".
    setAllMatching(false);
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  function togglePage() {
    setAllMatching(false);
    setSelected((s) =>
      allOnPage ? s.filter((id) => !pageIds.includes(id)) : [...new Set([...s, ...pageIds])],
    );
  }

  function clearSelection() {
    setSelected([]);
    setAllMatching(false);
  }

  return (
    <div>
      {error && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3.5 py-2.5 text-[12.5px] text-[#FFB3C2]">
          {error}
        </div>
      )}

      <LeadViewTabs
        views={views}
        filters={filters}
        sort={sort}
        columns={columns}
        activeViewId={activeViewId}
        currentUserId={currentUserId}
        canCurate={canCurateViews}
      />

      {/* Beside the tabs it belongs to, not three clicks away in Settings:
          somebody editing a filter should be able to see that a colleague
          receives it every Monday. */}
      <div className="mb-2 flex flex-wrap justify-end">
        <ExportSchedules
          views={views}
          activeViewId={activeViewId}
          canExport={canExport}
        />
      </div>

      <div className="mb-3 flex flex-wrap items-start gap-x-3 gap-y-2">
        <LeadFilterBuilder
          value={filters}
          facets={facets}
          customFields={customFields}
          onApply={applyFilters}
          activeCount={filters.conditions.length}
        />

        <div className="relative ml-auto flex items-center gap-2">
          <span data-testid="lead-count" className="text-[12px] text-muted">
            {filtered ? `${total} of ${totalUnfiltered}` : `${total}`} leads
          </span>
          <button
            type="button"
            onClick={() => setShowColumns((s) => !s)}
            data-testid="column-toggle"
            className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2"
          >
            Columns
          </button>
          {showColumns && (
            <div
              data-testid="column-panel"
              className="absolute right-0 top-[calc(100%+8px)] z-30 w-[240px] rounded-card border border-line bg-[#050A25] p-2 shadow-glow-lg"
            >
              {allColumns.map((c) => {
                const on = columns.includes(c.key);
                const required = c.key === "contact";
                return (
                  <label
                    key={c.key}
                    className={`flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-[12.5px] ${
                      required ? "text-muted" : "cursor-pointer text-ink hover:bg-panel-2"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={required}
                      onChange={() => toggleColumn(c.key)}
                      className="accent-[#7427C6]"
                    />
                    {c.label}
                    {required && <span className="ml-auto text-[10.5px]">always</span>}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <LeadBulkBar
        ids={selected}
        allMatching={allMatching}
        filters={filters}
        matchingTotal={total}
        pageIds={pageIds}
        columns={columns}
        facets={facets}
        canDelete={canDelete}
        canExport={canExport}
        customFields={customFields}
        onSelectAllMatching={() => setAllMatching(true)}
        onClear={clearSelection}
      />

      <div className="overflow-x-auto rounded-card border border-line bg-panel">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="w-8 border-b border-line px-3 py-2.5 text-left">
                <input
                  type="checkbox"
                  checked={allOnPage}
                  onChange={togglePage}
                  aria-label="Select every lead on this page"
                  data-testid="select-page"
                  className="accent-[#7427C6]"
                />
              </th>
              {visible.map((c) => (
                <th
                  key={c.key}
                  className={`border-b border-line px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted ${
                    c.numeric ? "text-right" : "text-left"
                  } ${c.secondary ? "hidden nav:table-cell" : ""}`}
                >
                  {c.sortField ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.sortField!)}
                      data-testid={`sort-${c.key}`}
                      className="inline-flex items-center gap-1 uppercase tracking-[0.1em] hover:text-ink"
                    >
                      {c.label}
                      {sort.field === c.sortField && (
                        <span aria-hidden className="text-accent-ink">
                          {sort.direction === "asc" ? "↑" : "↓"}
                        </span>
                      )}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
              <th className="border-b border-line px-3 py-2.5 text-right text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  className="px-3 py-8 text-center text-[13px] text-muted"
                  colSpan={visible.length + 2}
                >
                  {filtered ? (
                    <>
                      No lead matches this filter.{" "}
                      <button
                        type="button"
                        onClick={() => applyFilters({ match: "all", conditions: [] })}
                        className="underline hover:text-ink"
                      >
                        Clear the filter
                      </button>{" "}
                      to see all {totalUnfiltered}.
                    </>
                  ) : (
                    <EmptyState
                      title="no leads yet"
                      testId="leads-empty"
                      action={{ label: "Find businesses", href: "/prospector" }}
                      secondary={
                        <span className="text-[12px] text-muted">
                          or add one by hand, paste a LinkedIn profile, or import a CSV
                        </span>
                      }
                    >
                      A lead is a person at a company you want to work with. Nothing is
                      scraped and nothing is sent on its own — every message is yours.
                    </EmptyState>
                  )}
                </td>
              </tr>
            )}
            {rows.map((l, rowIndex) => {
              const ready = (l.icpScore ?? 0) >= threshold;
              return (
                <tr
                  key={l.id}
                  className={`hover:[&>td]:bg-panel ${
                    allMatching || selected.includes(l.id) ? "[&>td]:bg-accent-soft/20" : ""
                  }`}
                >
                  <td className="border-b border-line px-3 py-3 align-middle">
                    <input
                      type="checkbox"
                      checked={allMatching || selected.includes(l.id)}
                      onChange={() => toggleRow(l.id)}
                      aria-label={`Select ${l.contactName ?? "lead"}`}
                      data-testid="select-row"
                      className="accent-[#7427C6]"
                    />
                  </td>
                  {visible.map((c, colIndex) => (
                    <td
                      key={c.key}
                      className={`border-b border-line px-3 py-3 align-middle text-[13px] ${
                        c.numeric ? "text-right tabular-nums" : ""
                      } ${c.secondary ? "hidden nav:table-cell" : ""}`}
                    >
                      {c.key === "contact" && (
                        <span className="flex items-center gap-2">
                          <LeadAvatar name={l.contactName} path={l.avatarPath} size={28} />
                          <button
                            type="button"
                            onClick={() => setDetailFor(l.id)}
                            data-testid="lead-open-detail"
                            title="Open to edit or delete"
                            className="text-left font-bold hover:text-accent-ink hover:underline"
                          >
                            {l.contactName ?? "Unnamed contact"}
                          </button>
                          {l.riskLabel && <RiskChip label={l.riskLabel} />}
                        </span>
                      )}
                      {c.key === "company" && (
                        <span>
                          {l.company ?? "—"}
                          {l.sizeBand && (
                            <span className="block text-[11.5px] text-muted">{l.sizeBand}</span>
                          )}
                        </span>
                      )}
                      {(c.key === "title" || c.key === "email" || c.key === "phone") && (
                        <InlineCell
                          kind="text"
                          label={c.label}
                          row={rowIndex}
                          col={colIndex}
                          value={l[c.key as "title" | "email" | "phone"] ?? null}
                          display={l[c.key as "title" | "email" | "phone"] ?? ""}
                          onSave={(next) => saveCell(l.id, c.key, next)}
                        />
                      )}
                      {c.key === "industry" && (l.industry ?? "—")}
                      {c.key === "city" && (l.city ?? "—")}
                      {c.key === "icpScore" && (
                        <span className="whitespace-nowrap">
                          <Notches score={l.icpScore} />
                          <b className="ml-1.5">{l.icpScore ?? "—"}</b>
                        </span>
                      )}
                      {c.key === "signals" &&
                        (l.signals.length === 0 ? (
                          <span className="text-muted">—</span>
                        ) : (
                          /**
                           * ONE LINE, ALWAYS.
                           *
                           * The pills used to wrap, so a lead with three signals
                           * made its row two lines tall — and because a table row
                           * is as tall as its tallest cell, a handful of busy
                           * leads stretched the whole list. The column is scanned,
                           * not read: what matters at a glance is that there ARE
                           * signals and roughly which.
                           *
                           * Nothing is hidden. Two pills fit the width, the rest
                           * become a count, and the title carries the full list
                           * for anyone who wants it without opening the lead.
                           */
                          <span
                            /**
                             * Capped, because this column is NOT secondary: it is
                             * one of the five default columns and it stays visible
                             * at 390px. Unwrapped pills would otherwise take
                             * whatever width they liked and squeeze Stage off a
                             * phone screen.
                             */
                            className="flex max-w-[12rem] items-center gap-1 overflow-hidden"
                            title={l.signals.join(", ")}
                          >
                            {/*
                              ONE pill when there are three or more, two when
                              there are exactly two.

                              Fitting two pills AND a count into the capped width
                              meant both got clipped mid-word — "hiring marketin",
                              "outdated websi" — which reads as a rendering bug
                              rather than as a summary. A single legible signal
                              plus "+3" says more than two broken ones.
                            */}
                            {l.signals.slice(0, l.signals.length > 2 ? 1 : 2).map((s, i) => (
                              <Tag key={i}>{s}</Tag>
                            ))}
                            {l.signals.length > 2 && (
                              <span className="shrink-0 text-[11px] tabular-nums text-muted">
                                +{l.signals.length - 1}
                              </span>
                            )}
                          </span>
                        ))}
                      {c.key === "stage" && (
                        <>
                          <InlineCell
                            kind="select"
                            label="Stage"
                            row={rowIndex}
                            col={colIndex}
                            value={l.stage}
                            display={humanEnum(l.stage)}
                            options={STAGE_OPTIONS}
                            onSave={(next) => saveCell(l.id, "stage", next)}
                          />
                          {l.stage === "RESEARCHED" && l.icpScore != null && !ready && (
                            <span className="mt-0.5 block rounded-[6px] border border-dashed border-line px-1.5 py-0.5 text-[10.5px] text-muted">
                              below gate — can&apos;t contact
                            </span>
                          )}
                        </>
                      )}
                      {c.key === "source" && (
                        <span className="text-[12px] text-muted">{humanEnum(l.source)}</span>
                      )}
                      {c.key === "owner" && (
                        <InlineCell
                          kind="select"
                          label="Owner"
                          row={rowIndex}
                          col={colIndex}
                          value={l.ownerId}
                          display={l.ownerName ?? "unassigned"}
                          options={facets.owners.map((o) => ({ value: o.id, label: o.name }))}
                          onSave={(next) => saveCell(l.id, "ownerId", next)}
                        />
                      )}
                      {c.key === "lastActivity" && (
                        <span className="text-[12px] text-muted">
                          {relativeDays(l.lastActivityAt)}
                        </span>
                      )}
                      {c.key === "created" && (
                        <span className="text-[12px] text-muted">{relativeDays(l.createdAt)}</span>
                      )}
                      {isCustomFieldRef(c.key) &&
                        (() => {
                          const def = customFields.find((d) => d.key === customFieldKey(c.key));
                          if (!def || def.archived) {
                            return (
                              <CustomCell
                                def={def}
                                value={l.customFields?.[customFieldKey(c.key)]}
                              />
                            );
                          }
                          const raw = (l.customFields?.[customFieldKey(c.key)] ?? null) as
                            | string
                            | string[]
                            | boolean
                            | null;
                          return (
                            <InlineCell
                              kind={INLINE_KIND[def.type]}
                              label={def.label}
                              row={rowIndex}
                              col={colIndex}
                              value={raw}
                              display={formatValue(def, raw as never)}
                              options={def.options}
                              onSave={(next) => saveCell(l.id, c.key, next)}
                            />
                          );
                        })()}
                    </td>
                  ))}
                  <td className="border-b border-line px-3 py-3 align-middle text-[13px]">
                    <div className="flex justify-end gap-2">
                      {l.icpScore == null ? (
                        <button
                          onClick={() => startTransition(() => research(l.id))}
                          disabled={pending}
                          className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2 disabled:opacity-60"
                        >
                          Run research
                        </button>
                      ) : l.stage === "RESEARCHED" ? (
                        <button
                          onClick={() => startTransition(() => toContacted(l.id))}
                          disabled={pending}
                          className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2 disabled:opacity-60"
                          title={ready ? "Move to Contacted" : "Blocked by the score gate"}
                        >
                          → Contacted
                        </button>
                      ) : (
                        <span className="text-[11px] text-muted">—</span>
                      )}
                      {l.companyId && (
                        <button
                          onClick={() => setEnrichFor(l.companyId)}
                          className="hidden rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2 nav:inline-block"
                        >
                          Enrich
                        </button>
                      )}
                      <button
                        onClick={() => setOverrideFor(l.id)}
                        className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2"
                      >
                        Override
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[12px] text-muted">
            Page {page} of {pageCount}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="page-prev"
              disabled={page <= 1 || pending}
              onClick={() => navigate({ page: String(page - 1) }, true)}
              className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2 disabled:opacity-40"
            >
              ← Previous
            </button>
            <button
              type="button"
              data-testid="page-next"
              disabled={page >= pageCount || pending}
              onClick={() => navigate({ page: String(page + 1) }, true)}
              className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {detailFor && <LeadDetailModal leadId={detailFor} onClose={() => setDetailFor(null)} />}
      {overrideFor && (
        <OverrideDialog
          leadId={overrideFor}
          onClose={() => setOverrideFor(null)}
          onDone={() => {
            setOverrideFor(null);
            router.refresh();
          }}
        />
      )}
      {enrichFor && (
        <EnrichDialog
          companyId={enrichFor}
          onClose={() => setEnrichFor(null)}
          onDone={() => {
            setEnrichFor(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
