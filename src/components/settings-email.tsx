"use client";
import { attemptVoid } from "@/lib/client/server-action";
import { GoogleConnectHelp } from "./google-connect-help";

import { useEffect, useState } from "react";
import {
  listMailAccounts,
  setMailAccountEnabled,
  disconnectMailAccount,
  type MailAccountView,
} from "@/modules/email/actions";

/**
 * Settings → Email (playbook-v2 P2b).
 *
 * The health line is the point of this panel. A sync that has quietly needed
 * reconnecting for three days looks exactly like a quiet week of correspondence
 * unless something says otherwise, so the state is shown plainly rather than
 * inferred from an empty timeline.
 */
const HEALTH: Record<string, { label: string; tone: string; help?: string }> = {
  ok: { label: "syncing", tone: "text-[#3DDC97]" },
  rate_limited: {
    label: "slowed down",
    tone: "text-warn",
    help: "Google asked us to slow down. Syncing resumes on its own.",
  },
  reconnect_needed: {
    label: "reconnect needed",
    tone: "text-[#FF5C7A]",
    help: "The mailbox access expired or was revoked. Reconnect to resume.",
  },
  error: { label: "error", tone: "text-[#FF5C7A]" },
};

export function SettingsEmail() {
  const [accounts, setAccounts] = useState<MailAccountView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** This panel had nowhere to report a failure either. */
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setAccounts(await listMailAccounts());
  }

  useEffect(() => {
    let active = true;
    listMailAccounts().then((a) => {
      if (active) setAccounts(a);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!accounts) return null;

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]">
      <h2 className="mb-1 font-display text-[15px] font-bold lowercase tracking-display">
        email sync
      </h2>
      {error && (
        <p
          role="alert"
          data-testid="email-sync-error"
          className="mb-3 rounded-[8px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] px-3 py-2 text-[12.5px] text-[#FFB3C2]"
        >
          {error}
        </p>
      )}
      <p className="mb-3 max-w-prose text-[12px] leading-relaxed text-muted">
        We sync only messages involving people already in your pipeline — the search
        we send to Gmail is built from your leads&apos; addresses and their company
        domains, so unrelated mail is never fetched. Your mailbox stays yours; this is
        a copy of the correspondence that belongs to a lead.
      </p>

      {accounts.length === 0 ? (
        <div className="rounded-[10px] border border-line bg-panel-2 p-4">
          <p className="text-[12.5px] text-muted">
            No mailbox connected. Connecting Google for Calendar also grants mail
            access — reconnect from Meetings to enable it.
          </p>
          <a
            href="/api/google/connect"
            className="mt-2.5 inline-block rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] font-semibold hover:border-accent"
          >
            Connect a mailbox
          </a>
          <GoogleConnectHelp />
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map((a) => {
            const health = HEALTH[a.health] ?? HEALTH.error!;
            return (
              <div key={a.id} className="rounded-[10px] border border-line bg-panel-2 p-3.5">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-[13px] font-semibold">{a.accountEmail}</span>
                  <span className={`text-[11.5px] ${health.tone}`}>· {health.label}</span>
                  {a.lastSyncAt && (
                    <span className="ml-auto text-[11px] text-muted">
                      last sync {new Date(a.lastSyncAt).toLocaleString("hu-HU")}
                    </span>
                  )}
                </div>

                {health.help && (
                  <p className="mt-1 text-[11.5px] text-muted">{health.help}</p>
                )}
                {a.lastError && a.health !== "ok" && (
                  <p className="mt-1 truncate text-[11px] text-muted" title={a.lastError}>
                    {a.lastError}
                  </p>
                )}

                {!a.backfillDone && (
                  <div className="mt-2.5">
                    <div className="mb-1 flex justify-between text-[11px] text-muted">
                      <span>Backfilling the last 90 days</span>
                      <span className="tabular-nums">{a.backfillPercent}%</span>
                    </div>
                    <div className="h-[5px] overflow-hidden rounded-full bg-[rgba(239,241,248,0.08)]">
                      <div className="h-full bg-grad" style={{ width: `${a.backfillPercent}%` }} />
                    </div>
                  </div>
                )}

                <div className="mt-2.5 flex flex-wrap gap-x-4 text-[11.5px] text-muted">
                  <span>{a.threadCount} threads</span>
                  <span>{a.messageCount} messages</span>
                  {a.unmatchedCount > 0 && (
                    <span className="text-warn">{a.unmatchedCount} unmatched</span>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={async () => {
                      setBusy(a.id);
                      setError(null);
                      const failed = await attemptVoid(
                        setMailAccountEnabled(a.id, !a.enabled),
                      );
                      if (failed) {
                        setError(failed);
                        setBusy(null);
                        return;
                      }
                      await refresh();
                      setBusy(null);
                    }}
                    disabled={busy === a.id}
                    className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:border-accent disabled:opacity-60"
                  >
                    {a.enabled ? "Pause syncing" : "Resume syncing"}
                  </button>
                  {a.health === "reconnect_needed" && (
                    <a
                      href="/api/google/connect"
                      className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] font-semibold hover:border-accent"
                    >
                      Reconnect
                    </a>
                  )}
                  <button
                    onClick={async () => {
                      if (
                        !confirm(
                          `Disconnect ${a.accountEmail}? This deletes the ${a.threadCount} synced threads too.`,
                        )
                      ) {
                        return;
                      }
                      setBusy(a.id);
                      setError(null);
                      // Believing a mailbox is disconnected when it is still
                      // syncing is the failure that matters here.
                      const failed = await attemptVoid(disconnectMailAccount(a.id));
                      if (failed) {
                        setError(failed);
                        setBusy(null);
                        return;
                      }
                      await refresh();
                      setBusy(null);
                    }}
                    disabled={busy === a.id}
                    className="ml-auto rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] text-muted hover:border-[rgba(255,92,122,0.5)] hover:text-ink disabled:opacity-60"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
