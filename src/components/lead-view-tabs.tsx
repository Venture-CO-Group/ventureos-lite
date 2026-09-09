"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { deleteLeadView, saveLeadView, updateLeadView } from "@/modules/leads/view-actions";
import { viewMatchesState, viewToQuery, type LeadView } from "@/modules/leads/views";
import { parseColumns, parseFilterSet, parseSort } from "@/modules/leads/view-params";
import type { FilterSet, SortSpec } from "@/modules/leads/filters";
import { Modal } from "./modal";

/**
 * The saved-view tab strip above the leads table (playbook-v2 P3/2).
 *
 * A view is nothing more than a stored query string, so opening one is a
 * navigation and the table itself needs to know nothing about views at all.
 * The tab stays lit while the table still matches what was saved; edit the
 * filter and it dims and offers to absorb the change instead.
 */

export function LeadViewTabs({
  views,
  filters,
  sort,
  columns,
  activeViewId,
  currentUserId,
  canCurate,
}: {
  views: LeadView[];
  filters: FilterSet;
  sort: SortSpec;
  columns: string[];
  activeViewId: string | null;
  currentUserId: string;
  /** Owner/Admin may edit the workspace's shared tabs, not just their own. */
  canCurate: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const unfiltered = filters.conditions.length === 0;
  /**
   * The active tab is the one the URL NAMES, and it stays active only while the
   * table still matches it. Searching all views for a structural match instead
   * looked equivalent and was not: a view that filters nothing matches the
   * unfiltered table, so the first such view silently stole the highlight from
   * "All leads" for ever after.
   */
  const named = activeViewId ? views.find((v) => v.id === activeViewId) : undefined;
  const matched = named && viewMatchesState(named, filters, sort, columns) ? named : undefined;
  const activeId = matched?.id ?? null;
  /** Named but no longer matching = the user has edited it since opening. */
  const edited = !!named && !matched;
  const allActive = !activeId && unfiltered;

  // Same reasoning as the table's `navigate`: the URL leads, so no transition.
  function open(view: LeadView) {
    router.push(`${pathname}?${viewToQuery(view).toString()}`);
  }

  function openAll() {
    router.push(pathname);
  }

  /**
   * What to store, read from the URL at the moment of the click rather than
   * from props.
   *
   * The props come from the server render of the previous URL, so between
   * "Apply" and that render landing they still describe the PREVIOUS table —
   * and a view saved in that window silently stored an empty filter. The query
   * string is authoritative and updates on navigation, so it cannot lag.
   */
  function currentState() {
    return {
      filters: parseFilterSet(searchParams.get("f")),
      sort: parseSort(searchParams.get("sort")),
      columns: parseColumns(searchParams.get("cols")),
    };
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await saveLeadView({ name, shared, ...currentState() });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSaveOpen(false);
      setName("");
      setShared(false);
      open(res.view);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function overwrite(view: LeadView) {
    const res = await updateLeadView(view.id, currentState());
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  async function remove(view: LeadView) {
    const res = await deleteLeadView(view.id);
    if (!res.ok) setError(res.error);
    else {
      if (activeViewId === view.id) openAll();
      router.refresh();
    }
  }

  const editable = (v: LeadView) => v.ownerId === currentUserId || canCurate;

  return (
    <div className="mb-3">
      {/* Only out here — while the dialog is open it shows the error itself,
          and rendering it in both places put the same sentence on screen twice. */}
      {error && !saveOpen && (
        <div className="mb-2 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3 py-2 text-[12.5px] text-[#FFB3C2]">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 border-b border-line pb-2">
        <button
          type="button"
          onClick={openAll}
          data-testid="view-tab-all"
          aria-current={allActive}
          className={`rounded-[10px] px-3 py-1.5 text-[12.5px] font-semibold ${
            allActive
              ? "border border-accent bg-accent-soft text-[#E4D3FF]"
              : "border border-transparent text-muted hover:bg-panel-2 hover:text-ink"
          }`}
        >
          All leads
        </button>

        {views.map((v) => {
          const active = activeId === v.id;
          return (
            <span key={v.id} className="group relative inline-flex items-center">
              <button
                type="button"
                onClick={() => open(v)}
                data-testid="view-tab"
                aria-current={active}
                title={v.shared ? `Shared view` : "Your view"}
                className={`rounded-[10px] px-3 py-1.5 text-[12.5px] font-semibold ${
                  active
                    ? "border border-accent bg-accent-soft text-[#E4D3FF]"
                    : "border border-transparent text-muted hover:bg-panel-2 hover:text-ink"
                }`}
              >
                {v.shared && (
                  <span aria-hidden className="mr-1 text-[11px] opacity-70">
                    ◆
                  </span>
                )}
                {v.name}
              </button>
              {editable(v) && (
                /* Always rendered, not revealed on hover: there is no hover on
                   a phone, and CLAUDE.md requires the whole daily loop to work
                   at 390px. Kept quiet with opacity instead. */
                <button
                  type="button"
                  onClick={() => remove(v)}
                  aria-label={`Delete view ${v.name}`}
                  data-testid="view-delete"
                  className="ml-0.5 rounded px-1 text-[11px] text-muted opacity-40 transition-opacity hover:text-[#FFB3C2] hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  ✕
                </button>
              )}
            </span>
          );
        })}

        <span className="ml-auto flex items-center gap-2">
          {/* Offered only once the table has actually diverged from the tab —
              "Update view" on an unchanged view is a button that does nothing. */}
          {edited && named && editable(named) && (
            <button
              type="button"
              onClick={() => overwrite(named)}
              disabled={busy}
              data-testid="view-update"
              className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2"
            >
              Update “{named.name}”
            </button>
          )}
          <button
            type="button"
            onClick={() => setSaveOpen(true)}
            data-testid="view-save"
            disabled={unfiltered && columns.length === 0}
            className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] font-semibold hover:bg-panel-2"
          >
            Save as view
          </button>
        </span>
      </div>

      {saveOpen && (
        <Modal>
          <div className="mb-3 flex items-center">
            <h3 className="font-display text-lg font-bold lowercase">save this view</h3>
            <button
              aria-label="Close"
              onClick={() => setSaveOpen(false)}
              className="ml-auto text-muted hover:text-ink"
            >
              ✕
            </button>
          </div>
          <p className="mb-3 text-[12px] text-muted">
            Saves the current filter, column selection and sort order as a tab.
          </p>
          {error && <p className="mb-2 text-[12px] text-[#FFB3C2]">{error}</p>}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="View name"
            data-testid="view-name"
            autoFocus
            className="mb-3 w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent"
          />
          <label className="mb-3 flex cursor-pointer items-start gap-2 text-[12.5px]">
            <input
              type="checkbox"
              checked={shared}
              data-testid="view-shared"
              onChange={(e) => setShared(e.target.checked)}
              className="mt-0.5 accent-[#7427C6]"
            />
            <span>
              Share with the workspace
              <span className="block text-[11.5px] text-muted">
                Everyone here sees the tab. It reveals nothing they could not
                already filter for themselves.
              </span>
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setSaveOpen(false)}
              className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={busy || name.trim().length === 0}
              data-testid="view-save-confirm"
              className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
            >
              {busy ? "Saving…" : "Save view"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
