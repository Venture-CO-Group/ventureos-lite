"use client";

import { useState, useTransition } from "react";
import { attempt } from "@/lib/client/server-action";
import { exportFinderResults } from "@/modules/finder/export-actions";
import { DEFAULT_COLUMN_KEYS, FINDER_COLUMNS } from "@/modules/finder/export-columns";
import type { FinderRow } from "@/modules/finder/row";
import { BUTTON, INPUT, LABEL, PRIMARY } from "./finder-editor";

/**
 * The export dialog (item 6): format, scope, column picker. Bank account
 * numbers appear only for the Owner, behind an explicit toggle, and the
 * server checks both again.
 */

function saveBase64(base64: string, filename: string, mime: string): void {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface ExportPolicy {
  canExport: boolean;
  isOwner: boolean;
}

export function FinderExport({
  listId,
  total,
  filtered,
  selected,
  policy,
}: {
  listId: string;
  total: number;
  filtered: FinderRow[];
  selected: string[];
  policy: ExportPolicy;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [format, setFormat] = useState<"csv" | "xlsx">("xlsx");
  const [scope, setScope] = useState<"all" | "view" | "selection">("all");
  const [cols, setCols] = useState<string[]>([...DEFAULT_COLUMN_KEYS]);
  const [bank, setBank] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (!policy.canExport) {
    return (
      <button type="button" className={BUTTON} disabled title="Needs the exports.run grant">
        Export
      </button>
    );
  }

  const count = scope === "all" ? total : scope === "view" ? filtered.length : selected.length;
  const visible = FINDER_COLUMNS.filter((c) => !c.ownerOnly || policy.isOwner);
  const toggle = (k: string) => setCols((cs) => (cs.includes(k) ? cs.filter((x) => x !== k) : [...cs, k]));

  function run() {
    setMsg(null);
    const ids = scope === "all" ? undefined : scope === "view" ? filtered.map((r) => r.id) : selected;
    const columns = cols.filter((k) => k !== "bankAccounts" || bank);
    startTransition(async () => {
      const res = await attempt(exportFinderResults({ listId, format, columns, ids, scope, includeBankAccounts: bank }));
      if (!res.ok) {
        setMsg(res.error);
        return;
      }
      if (res.kind === "inline") saveBase64(res.base64, res.filename, res.mime);
      else window.open(`/api/files/${res.rel}`, "_blank", "noopener");
      setMsg(`${res.rows} rows exported.`);
    });
  }

  return (
    <>
      <button type="button" className={BUTTON} onClick={() => setOpen(true)} data-testid="finder-export-open">
        Export
      </button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(0,5,29,0.7)] p-4" role="dialog" aria-modal="true" aria-label="Export companies">
          <div className="grid max-h-[90vh] w-full max-w-[640px] gap-3 overflow-y-auto rounded-card border border-line bg-[#0B1030] p-[18px]" data-testid="finder-export-dialog">
            <div className="flex items-center gap-2">
              <h3 className="font-display text-[17px] font-bold lowercase">export</h3>
              <button type="button" className="ml-auto min-h-[44px] px-2 text-[13px] text-muted hover:text-ink" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1">
                <span className={LABEL}>Format</span>
                <select className={INPUT} value={format} onChange={(e) => setFormat(e.target.value as "csv" | "xlsx")} data-testid="finder-export-format">
                  <option value="xlsx">Excel (.xlsx) — typed columns, links, filters</option>
                  <option value="csv">CSV (UTF-8) — for another system</option>
                </select>
              </label>
              <label className="grid gap-1">
                <span className={LABEL}>Rows</span>
                <select className={INPUT} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
                  <option value="all">All matches ({total})</option>
                  <option value="view">Current view ({filtered.length})</option>
                  <option value="selection" disabled={selected.length === 0}>Selected ({selected.length})</option>
                </select>
              </label>
            </div>

            <fieldset className="grid gap-1">
              <legend className={`${LABEL} mb-1 flex w-full flex-wrap gap-3`}>
                <span>Columns ({cols.filter((k) => k !== "bankAccounts").length})</span>
                <button type="button" className="underline" onClick={() => setCols([...DEFAULT_COLUMN_KEYS])}>defaults</button>
                <button type="button" className="underline" onClick={() => setCols(visible.filter((c) => !c.ownerOnly).map((c) => c.key))}>all</button>
                <button type="button" className="underline" onClick={() => setCols([])}>none</button>
              </legend>
              <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2" data-testid="finder-column-picker">
                {visible
                  .filter((c) => !c.ownerOnly)
                  .map((c) => (
                    <label key={c.key} className="flex min-h-[32px] items-center gap-2 text-[12.5px]">
                      <input type="checkbox" checked={cols.includes(c.key)} onChange={() => toggle(c.key)} />
                      {c.label}
                    </label>
                  ))}
              </div>
            </fieldset>

            {policy.isOwner && (
              <label className="flex min-h-[36px] items-start gap-2 rounded-[10px] border border-line p-2 text-[12.5px]" data-testid="finder-export-bank">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={bank}
                  onChange={(e) => {
                    setBank(e.target.checked);
                    setCols((cs) => (e.target.checked ? [...cs.filter((k) => k !== "bankAccounts"), "bankAccounts"] : cs.filter((k) => k !== "bankAccounts")));
                  }}
                />
                <span>
                  <b>Include bank account numbers</b> (Owner only). Off by default; the export is logged with this choice.
                </span>
              </label>
            )}

            {msg && <p className="text-[12px] text-muted" role="status">{msg}</p>}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={PRIMARY} disabled={pending || count === 0 || cols.length === 0} onClick={run} data-testid="finder-export-run">
                {pending ? "Exporting…" : `Export ${count} row${count === 1 ? "" : "s"}`}
              </button>
              <button type="button" className={BUTTON} onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
