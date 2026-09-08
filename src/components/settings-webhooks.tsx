"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { serverActionError } from "@/lib/client/server-action";
import {
  deleteWebhook,
  rotateWebhookSecret,
  saveWebhook,
  sendTestWebhook,
  setWebhookEnabled,
  type WebhookRow,
  type WebhookView,
} from "@/modules/webhooks/actions";
import { WEBHOOK_EVENTS, labelFor } from "@/modules/webhooks/events";

/**
 * Settings → Outbound webhooks (P5/5.2).
 *
 * The software could already receive one (`api/webhooks/mailgun`). It could not
 * tell anything else that a lead moved or an offer was accepted — the
 * difference between a tool and an island.
 *
 * Three things this panel insists on:
 *
 *   - the secret is shown ONCE, on creation or rotation. Not because it cannot
 *     be read back, but because a screen that re-displays it for ever is a
 *     screen somebody eventually screenshots;
 *   - a test button, because otherwise the only way to find out whether an
 *     endpoint works is to wait for a real lead to move and then guess whether
 *     the silence means "no events" or "wrong URL";
 *   - the last five deliveries per endpoint, with the response code. "Did it
 *     arrive" is the first question anybody asks about an integration.
 */
const BTN =
  "min-h-[32px] rounded-[8px] border border-line px-2.5 py-1 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
const INPUT =
  "w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent";

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("hu-HU") : "—";
}

const STATUS_COLOUR: Record<string, string> = {
  delivered: "text-[#8CEFC0]",
  pending: "text-muted",
  failed: "text-[#FFB3C2]",
  dropped: "text-muted",
};

export function SettingsWebhooks({ view }: { view: WebhookView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [editing, setEditing] = useState<WebhookRow | "new" | null>(null);

  if (!view.canManage) return null;

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fn();
      if (!res.ok) {
        setError(res.error ?? "Nem sikerült.");
        return false;
      }
      if (ok) setNote(ok);
      router.refresh();
      return true;
    } catch (e) {
      setError(serverActionError(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="settings-webhooks"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-bold lowercase">kimenő webhookok</h2>
        <button
          onClick={() => {
            setEditing("new");
            setSecret(null);
            setError(null);
            setNote(null);
          }}
          className={BTN}
          data-testid="webhook-new"
        >
          + Új végpont
        </button>
      </div>
      <p className="mb-3 text-[12.5px] text-muted">
        Amikor egy lead stádiumot vált vagy egy ajánlatot elfogadnak, elküldjük
        egy általad megadott https címre. Minden kérés alá van írva — a{" "}
        <code className="text-[11.5px]">X-Venture-Signature</code> fejlécben.
        Ez teszi a szoftvert integrálhatóvá ahelyett, hogy sziget lenne.
      </p>

      {note && (
        <p
          data-testid="webhook-note"
          className="mb-3 rounded-[8px] border border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] px-3 py-2 text-[12px] text-[#8CEFC0]"
        >
          {note}
        </p>
      )}
      {error && (
        <p role="alert" data-testid="webhook-error" className="mb-3 text-[12px] text-[#FFB3C2]">
          {error}
        </p>
      )}
      {secret && (
        <div
          data-testid="webhook-secret"
          className="mb-3 rounded-[10px] border border-accent bg-accent-soft px-3 py-2.5"
        >
          <b className="block text-[12px] text-[#E4D3FF]">
            Írd fel most — ezt többé nem mutatjuk meg.
          </b>
          <code className="mt-1 block break-all font-mono text-[11.5px] text-ink">{secret}</code>
          <span className="mt-1 block text-[11px] text-muted">
            A fogadó oldal ezzel ellenőrzi az aláírást:{" "}
            <code>HMAC-SHA256(secret, `${"${timestamp}"}.${"${body}"}`)</code>.
          </span>
          <button onClick={() => setSecret(null)} className={`${BTN} mt-2`}>
            Felírtam
          </button>
        </div>
      )}

      {editing && (
        <WebhookForm
          row={editing === "new" ? null : editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={async (payload) => {
            setBusy(true);
            setError(null);
            setNote(null);
            try {
              const res = await saveWebhook(payload);
              if (!res.ok) {
                setError(res.error);
                return;
              }
              if (res.secret) setSecret(res.secret);
              setNote(payload.id ? "Mentve." : "Létrehozva.");
              setEditing(null);
              router.refresh();
            } catch (e) {
              setError(serverActionError(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {view.hooks.length === 0 ? (
        <p className="text-[12.5px] text-muted">
          Nincs beállított végpont. Az események addig nem mennek sehova.
        </p>
      ) : (
        <ul className="grid gap-2.5">
          {view.hooks.map((h) => (
            <li
              key={h.id}
              data-testid="webhook-row"
              className="rounded-[10px] border border-line bg-panel-2 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <code className="block break-all font-mono text-[12px] text-ink">{h.url}</code>
                  {h.description && (
                    <span className="mt-0.5 block text-[11.5px] text-muted">{h.description}</span>
                  )}
                </div>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] ${
                    h.enabled
                      ? "border-[rgba(61,220,151,0.35)] text-[#8CEFC0]"
                      : "border-line text-muted"
                  }`}
                >
                  {h.enabled ? "aktív" : "kikapcsolva"}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap gap-1">
                {h.events.map((e) => (
                  <span
                    key={e}
                    className="rounded-full border border-line px-2 py-0.5 text-[10.5px] text-muted"
                  >
                    {labelFor(e)}
                  </span>
                ))}
              </div>

              {h.disabledReason && (
                <p
                  data-testid="webhook-tripped"
                  className="mt-2 rounded-[8px] border border-[rgba(255,179,194,0.3)] bg-[rgba(255,179,194,0.07)] px-2.5 py-1.5 text-[11.5px] text-[#FFB3C2]"
                >
                  {h.disabledReason}
                </p>
              )}

              <p className="mt-2 text-[11px] text-muted tabular-nums">
                Utolsó kísérlet: {when(h.lastAttemptAt)}
                {h.lastStatus !== null && ` · HTTP ${h.lastStatus}`}
                {" · "}Utolsó siker: {when(h.lastSuccessAt)}
                {h.failureCount > 0 && (
                  <>
                    {" · "}
                    <b className="text-warn">{h.failureCount}</b> egymást követő hiba
                  </>
                )}
              </p>

              {h.recent.length > 0 && (
                <ul className="mt-2 grid gap-0.5">
                  {h.recent.map((d) => (
                    <li
                      key={d.id}
                      data-testid="webhook-delivery"
                      className="flex flex-wrap items-baseline gap-1.5 text-[11px]"
                    >
                      <span className="tabular-nums text-muted">{when(d.at)}</span>
                      <span className="text-ink">{labelFor(d.event)}</span>
                      <span className={STATUS_COLOUR[d.status] ?? "text-muted"}>
                        {d.status}
                        {d.responseStatus !== null && ` (${d.responseStatus})`}
                      </span>
                      {d.error && <span className="text-muted">— {d.error}</span>}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <button
                  onClick={() => {
                    setEditing(h);
                    setSecret(null);
                  }}
                  className={BTN}
                  disabled={busy}
                >
                  Szerkesztés
                </button>
                <button
                  onClick={() => void run(() => setWebhookEnabled(h.id, !h.enabled))}
                  className={BTN}
                  disabled={busy}
                  data-testid="webhook-toggle"
                >
                  {h.enabled ? "Kikapcsolás" : "Bekapcsolás"}
                </button>
                <button
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    setNote(null);
                    try {
                      const res = await sendTestWebhook(h.id);
                      if (!res.ok) setError(res.error);
                      else setNote(res.detail);
                      router.refresh();
                    } catch (e) {
                      setError(serverActionError(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className={BTN}
                  disabled={busy}
                  data-testid="webhook-test"
                >
                  Teszt küldése
                </button>
                <button
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    setNote(null);
                    try {
                      const res = await rotateWebhookSecret(h.id);
                      if (!res.ok) setError(res.error);
                      else {
                        setSecret(res.secret);
                        setNote("Új titok. A régi azonnal érvénytelen.");
                      }
                    } catch (e) {
                      setError(serverActionError(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className={BTN}
                  disabled={busy}
                >
                  Titok újragenerálása
                </button>
                <button
                  onClick={() => {
                    if (!confirm(`Törlöd ezt a végpontot?\n${h.url}`)) return;
                    void run(() => deleteWebhook(h.id), "Törölve.");
                  }}
                  className={`${BTN} hover:border-[#FFB3C2]`}
                  disabled={busy}
                >
                  Törlés
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WebhookForm({
  row,
  busy,
  onCancel,
  onSave,
}: {
  row: WebhookRow | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (payload: {
    id?: string;
    url: string;
    description?: string;
    events: string[];
  }) => Promise<void>;
}) {
  const [url, setUrl] = useState(row?.url ?? "https://");
  const [description, setDescription] = useState(row?.description ?? "");
  const [events, setEvents] = useState<string[]>(row?.events ?? []);

  return (
    <div
      data-testid="webhook-form"
      className="mb-3 grid gap-2.5 rounded-[10px] border border-accent bg-panel-2 p-3"
    >
      <label className="grid gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Cél URL
        </span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          data-testid="webhook-url"
          placeholder="https://example.com/hooks/venture"
          className={INPUT}
        />
        <span className="text-[11px] text-muted">
          Csak https, és nyilvános tartománynév — a payload ügyféladatot
          tartalmaz, és a szerver belső címeire nem küldünk.
        </span>
      </label>

      <label className="grid gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Megjegyzés
        </span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          data-testid="webhook-description"
          placeholder="Mi ez a végpont?"
          className={INPUT}
        />
      </label>

      <div className="grid gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Események
        </span>
        <ul className="grid gap-1">
          {WEBHOOK_EVENTS.map((e) => (
            <li key={e.id}>
              <label className="flex items-start gap-2 rounded-[8px] border border-line px-2.5 py-1.5">
                <input
                  type="checkbox"
                  checked={events.includes(e.id)}
                  onChange={(ev) =>
                    setEvents((prev) =>
                      ev.target.checked ? [...prev, e.id] : prev.filter((x) => x !== e.id),
                    )
                  }
                  data-testid={`webhook-event-${e.id}`}
                  style={{ accentColor: "#7427C6" }}
                  className="mt-[3px]"
                />
                <span className="min-w-0">
                  <b className="block text-[12px]">{e.label}</b>
                  <code className="block font-mono text-[10.5px] text-muted">{e.id}</code>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
                    {e.hint}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() =>
            void onSave({
              ...(row ? { id: row.id } : {}),
              url,
              description: description || undefined,
              events,
            })
          }
          disabled={busy}
          data-testid="webhook-save"
          className="min-h-[36px] rounded-[9px] border border-accent bg-accent-soft px-3.5 py-2 text-[12.5px] font-semibold text-[#E4D3FF] disabled:opacity-45"
        >
          {row ? "Mentés" : "Létrehozás"}
        </button>
        <button onClick={onCancel} disabled={busy} className={BTN}>
          Mégse
        </button>
      </div>
    </div>
  );
}
