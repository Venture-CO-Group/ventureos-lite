"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  exportAuditLog,
  readAuditLog,
  setAuditRetention,
  type AuditLogPage,
  type AuditLogRow,
  type AuditRetentionView,
} from "@/modules/auditlog/actions";
import { AUDIT_LOG_CATEGORIES } from "@/modules/auditlog/categories";
import { describeAuditRetention } from "@/modules/auditlog/retention";
import { serverActionError } from "@/lib/client/server-action";

/**
 * Settings → Audit log (CLAUDE.md hard rule #8).
 *
 * Read-only, deliberately and completely. No edit, no delete, no bulk action —
 * an audit log with a delete button answers no question at all. The only
 * controls are the ones that help somebody find the entry they came for.
 */
const BTN =
  "min-h-[32px] rounded-[8px] border border-line px-2.5 py-1 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";

/** The five words a person scans for, in their language. */
const ACTION_LABEL: Record<string, string> = {
  "grant.change": "jogosultság módosítva",
  "export.run": "export",
  "lead.deleted": "lead törölve",
  "lead.erasure.requested": "törlés kérve",
  "lead.erasure.completed": "törlés végrehajtva",
  "document.finalize": "dokumentum véglegesítve",
  "invoice.submit": "számla beküldve",
  "invoice.issued": "számla kiállítva",
  "data.merge": "összevonás",
  "data.merge_reverted": "összevonás visszavonva",
  "import.run": "import",
  "import.rollback": "import visszavonva",
  "cold_email.signoff": "hideg e-mail jóváhagyás",
  "audit_log.exported": "napló exportálva",
  "audit_log.retention_changed": "napló megőrzés módosítva",
  "audit_log.pruned": "napló ritkítva",
  "webhook.created": "webhook létrehozva",
  "webhook.updated": "webhook módosítva",
  "webhook.enabled": "webhook bekapcsolva",
  "webhook.disabled": "webhook kikapcsolva",
  "webhook.secret_rotated": "webhook titok újragenerálva",
  "webhook.deleted": "webhook törölve",
  "workspace.settings_copied": "beállítások átmásolva",
  "workspace.settings_copied_from": "beállítások innen átmásolva",
  "user.role_changed": "szerepkör módosítva",
  "user.invited": "meghívó kiadva",
  "user.invite_emailed": "meghívó e-mailben elküldve",
  "portal.document_opened": "kliens megnyitott egy dokumentumot",
};

function when(iso: string): string {
  return new Date(iso).toLocaleString("hu-HU");
}

export function AuditLogPanel({ retention }: { retention: AuditRetentionView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(String(retention.days));
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<AuditLogPage | null>(null);
  const [rows, setRows] = useState<AuditLogRow[]>([]);

  function load(cursor?: string) {
    startTransition(async () => {
      const res = await readAuditLog({ category, search: search || undefined, cursor });
      setPage(res);
      setRows((prev) => (cursor ? [...prev, ...res.rows] : res.rows));
    });
  }

  /**
   * Take the whole log away with you (P5/5.3).
   *
   * The first request in a data-protection incident is an extract of the log,
   * and "log in and scroll, fifty rows at a time" is not an answer to a
   * regulator, a client's security questionnaire, or a lawyer. The export is
   * itself logged — a record of who read the record of who did what.
   */
  async function download() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await exportAuditLog({ from: from || undefined, to: to || undefined });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // A BOM, because this file is opened in Excel far more often than in a
      // text editor, and without one every Hungarian name arrives mangled.
      const blob = new Blob([`\uFEFF${res.csv}`], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setNote(`${res.rows} bejegyzés letöltve.`);
      // The export itself became a row; show it.
      load();
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveRetention() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await setAuditRetention(Number(days));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNote("Megőrzési szabály mentve.");
      router.refresh();
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(false);
    }
  }

  // Reload from the top whenever the filter changes; the search is applied on
  // Enter or on the button, not per keystroke — this reads a growing table.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  return (
    <section
      data-testid="settings-audit-log"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <h2 className="mb-1 font-display text-lg font-bold lowercase">audit log</h2>
      <p className="mb-3 text-[12.5px] text-muted">
        Ki mit csinált, és mikor. Jogosultság-változás, export, törlés, dokumentum
        véglegesítés, számla-beküldés. <b>Csak olvasható</b> — ez a lényege.
      </p>

      {note && (
        <p
          data-testid="audit-log-note"
          className="mb-3 rounded-[8px] border border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] px-3 py-2 text-[12px] text-[#8CEFC0]"
        >
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 text-[12px] text-[#FFB3C2]">
          {error}
        </p>
      )}

      <div className="mb-3 grid gap-2 rounded-[10px] border border-line bg-panel-2 p-3 sm:grid-cols-[1fr_auto]">
        <div className="grid gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Kivonat
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              data-testid="audit-export-from"
              className="min-h-[32px] rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
            />
            <span className="text-[11.5px] text-muted">–</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              data-testid="audit-export-to"
              className="min-h-[32px] rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
            />
            <button
              onClick={() => void download()}
              disabled={busy}
              data-testid="audit-export"
              className={BTN}
            >
              CSV letöltés
            </button>
          </div>
          <span className="text-[11px] text-muted">
            Dátum nélkül a teljes napló. A letöltés maga is bekerül a naplóba.
          </span>
        </div>

        <div className="grid gap-1.5 sm:justify-items-end">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Megőrzés
          </span>
          <div className="flex items-center gap-1.5">
            <select
              value={days}
              onChange={(e) => setDays(e.target.value)}
              disabled={!retention.canEdit || busy}
              data-testid="audit-retention-days"
              className="min-h-[32px] rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
            >
              <option value="0">Örökre</option>
              <option value="90">90 nap</option>
              <option value="180">180 nap</option>
              <option value="365">1 év</option>
              <option value="730">2 év</option>
              <option value="1825">5 év</option>
              <option value="2555">7 év</option>
            </select>
            {retention.canEdit && (
              <button
                onClick={() => void saveRetention()}
                disabled={busy || Number(days) === retention.days}
                data-testid="audit-retention-save"
                className={BTN}
              >
                Mentés
              </button>
            )}
          </div>
          <span className="text-[11px] text-muted sm:text-right" data-testid="audit-retention-state">
            {describeAuditRetention(retention.days)} · {retention.total} bejegyzés
            {retention.expiring > 0 && (
              <>
                {" · "}
                <b className="text-warn">{retention.expiring}</b> a következő
                éjszakai söprésnél törlődik
              </>
            )}
          </span>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {AUDIT_LOG_CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => setCategory(c.id)}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
              category === c.id
                ? "border-accent bg-accent-soft text-[#E4D3FF]"
                : "border-line text-muted hover:border-accent"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="mb-3 flex gap-1.5">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
          placeholder="Keresés műveletre vagy azonosítóra…"
          data-testid="audit-log-search"
          className="min-w-[180px] flex-1 rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent"
        />
        <button onClick={() => load()} disabled={pending} className={BTN}>
          Keresés
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-[12.5px] text-muted">
          {pending ? "Betöltés…" : "Nincs bejegyzés ebben a szűrésben."}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-line text-left text-[10.5px] uppercase tracking-[0.1em] text-muted">
                  <th className="px-2 py-1.5 font-semibold">Mikor</th>
                  <th className="px-2 py-1.5 font-semibold">Ki</th>
                  <th className="px-2 py-1.5 font-semibold">Mit</th>
                  <th className="px-2 py-1.5 font-semibold">Mire</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0" data-testid="audit-log-row">
                    <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted">{when(r.at)}</td>
                    <td className="px-2 py-2 text-ink">{r.actorName}</td>
                    <td className="px-2 py-2">
                      <span className="text-ink">{ACTION_LABEL[r.action] ?? r.action}</span>
                      {r.detail && <span className="block text-[11px] text-muted">{r.detail}</span>}
                    </td>
                    <td className="px-2 py-2 text-muted">
                      {r.entityType ?? "—"}
                      {r.entityId && (
                        <span className="block font-mono text-[10.5px]">{r.entityId.slice(0, 12)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-2.5 flex items-center gap-2">
            <span className="text-[11.5px] text-muted">
              {rows.length} / {page?.total ?? rows.length} bejegyzés
            </span>
            {page?.nextCursor && (
              <button
                onClick={() => load(page.nextCursor!)}
                disabled={pending}
                className={BTN}
                data-testid="audit-log-more"
              >
                Továbbiak
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
