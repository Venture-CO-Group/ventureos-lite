"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { serverActionError } from "@/lib/client/server-action";
import {
  getGoogleClientPanel,
  previewGoogleClientChange,
  removeWorkspaceGoogleClient,
  saveWorkspaceGoogleClient,
} from "@/modules/google/client-actions";
import type { GoogleClientPanel as Panel } from "@/modules/google/client-admin";
import { googleErrorMessage } from "@/modules/google/errors";

/**
 * Settings → "Google connection" (per-workspace Google clients, item 3).
 *
 * For a company with its own Google Workspace: the installation's Google app
 * is Internal to Venture's organisation, so Google turns their people away
 * with `org_internal`. They create an Internal client in THEIR organisation
 * and paste it here; everything the Google admin needs to copy is on this
 * panel, verbatim.
 *
 * Owner-only: the panel renders nothing for anybody else (the action returns
 * null), and every save re-checks on the server.
 */
const INPUT =
  "min-h-[40px] w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[12.5px] text-ink outline-none placeholder:text-muted focus:border-accent";
const LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted";
const BTN =
  "min-h-[40px] rounded-[8px] border border-line bg-panel px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-panel-2 disabled:opacity-60";
const BTN_PRIMARY =
  "min-h-[40px] rounded-[8px] border border-accent bg-accent-soft px-3 py-1.5 text-[12px] font-semibold text-[#E4D3FF] disabled:opacity-60";

const CLIENT_LABEL = {
  workspace: { text: "this workspace's client", tone: "text-[#3DDC97]" },
  installation: { text: "installation client", tone: "text-muted" },
  replaced: { text: "client replaced — reconnect", tone: "text-[#FF5C7A]" },
} as const;

type Msg = { kind: "ok" | "err"; text: string } | null;

function Copyable({ value, testId }: { value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <code
        data-testid={testId}
        className="block min-w-0 flex-1 break-all rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[11.5px] text-ink"
      >
        {value}
      </code>
      <button
        type="button"
        className={BTN}
        onClick={() =>
          navigator.clipboard
            .writeText(value)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {})
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function GoogleClientPanel({ testResult }: { testResult?: string | null }) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel | null | undefined>(undefined);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(
    testResult
      ? testResult === "ok"
        ? { kind: "ok", text: "Test passed: Google accepted this workspace's client for your account." }
        : { kind: "err", text: `Test failed. ${googleErrorMessage(testResult).message}` }
      : null,
  );
  /** Set when a save would cut live connections and is waiting for a yes. */
  const [confirm, setConfirm] = useState<{ action: "save" | "delete"; affected: number } | null>(null);

  async function load() {
    const p = await getGoogleClientPanel();
    setPanel(p);
    setClientId(p?.clientId ?? "");
    setSecret("");
  }

  useEffect(() => {
    void load().catch((e) => setMsg({ kind: "err", text: serverActionError(e) }));
  }, []);

  if (panel === undefined || panel === null) return null;

  async function save(confirmAffected?: number) {
    setBusy(true);
    setMsg(null);
    try {
      if (confirmAffected === undefined) {
        // Ask first when the change would disconnect people.
        const { affected } = await previewGoogleClientChange({ clientId });
        if (affected > 0) {
          setConfirm({ action: "save", affected });
          return;
        }
      }
      const res = await saveWorkspaceGoogleClient({ clientId, clientSecret: secret, confirmAffected: confirmAffected ?? 0 });
      if (!res.ok) {
        if ("needsConfirm" in res) setConfirm({ action: "save", affected: res.affected });
        else setMsg({ kind: "err", text: res.error });
        return;
      }
      setConfirm(null);
      setMsg({
        kind: "ok",
        text: res.replaced
          ? `Saved. ${res.invalidated} connection(s) made through the old client must reconnect; their owners were notified.`
          : "Saved. Run “Test connection” to check it end to end.",
      });
      await load();
      router.refresh();
    } catch (e) {
      setMsg({ kind: "err", text: serverActionError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(confirmAffected?: number) {
    setBusy(true);
    setMsg(null);
    try {
      if (confirmAffected === undefined) {
        const { affected } = await previewGoogleClientChange(null);
        setConfirm({ action: "delete", affected });
        return;
      }
      const res = await removeWorkspaceGoogleClient({ confirmAffected });
      if (!res.ok) {
        if ("needsConfirm" in res) setConfirm({ action: "delete", affected: res.affected });
        else setMsg({ kind: "err", text: res.error });
        return;
      }
      setConfirm(null);
      setMsg({
        kind: "ok",
        text: `Removed. ${res.invalidated} connection(s) must reconnect${panel?.envFallback ? " — new connections use the installation's client" : ""}.`,
      });
      await load();
      router.refresh();
    } catch (e) {
      setMsg({ kind: "err", text: serverActionError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]" data-testid="google-client-panel">
      <h2 className="mb-1 font-display text-[15px] font-bold lowercase tracking-display">google connection</h2>
      <p className="mb-3 max-w-prose text-[12px] leading-relaxed text-muted">
        If this company has its own Google Workspace, give the workspace its own Google
        client — created as an <b className="text-ink">Internal</b> app in your organisation —
        so your people can connect Gmail and Calendar.{" "}
        {panel.envFallback
          ? "Without one, connections go through the installation's client, which only admits accounts from the installation's own organisation."
          : "Without one, nobody in this workspace can connect Google."}{" "}
        Owner-only; every change is audit-logged.
      </p>

      {msg && (
        <p
          role={msg.kind === "err" ? "alert" : "status"}
          data-testid="google-client-message"
          className={`mb-3 rounded-[8px] px-3 py-2 text-[12px] ${
            msg.kind === "err"
              ? "border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] text-[#FFB3C2]"
              : "border border-accent-soft bg-accent-soft text-[#E4D3FF]"
          }`}
        >
          {msg.text}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid content-start gap-2">
          <label className="grid gap-1">
            <span className={LABEL}>Client id</span>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="1234567890-abc.apps.googleusercontent.com"
              className={INPUT}
              data-testid="google-client-id"
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>Client secret</span>
            <input
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              type="password"
              // Never shown back: the stored secret does not leave the server.
              placeholder={panel.secretSet ? "•••••••• (stored — paste a new one to rotate)" : "GOCSPX-…"}
              className={INPUT}
              data-testid="google-client-secret"
              autoComplete="new-password"
            />
          </label>
          {panel.configured && (
            <p className="text-[11.5px] text-muted" data-testid="google-client-status">
              Status: <b className="text-ink">{panel.status}</b>
              {panel.lastTestedAt && <> · last tested {panel.lastTestedAt.slice(0, 16).replace("T", " ")}</>}
              {panel.lastError && <> · last error: {panel.lastError}</>}
            </p>
          )}

          {confirm ? (
            <div className="grid gap-2 rounded-[9px] border border-[rgba(245,184,65,0.35)] bg-[rgba(245,184,65,0.08)] p-3" data-testid="google-client-confirm">
              <p className="text-[12px] leading-relaxed text-[#F5D9A0]">
                {confirm.affected === 0
                  ? confirm.action === "delete"
                    ? "Remove this workspace's Google client? Nobody is connected through it."
                    : "Save?"
                  : `${confirm.affected} connected mailbox/calendar connection(s) were made through the current client. ${
                      confirm.action === "delete" ? "Removing" : "Replacing"
                    } it disconnects them: they will be marked “reconnect needed” and their owners notified.`}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  data-testid="google-client-confirm-yes"
                  className={BTN_PRIMARY}
                  onClick={() => (confirm.action === "delete" ? remove(confirm.affected) : save(confirm.affected))}
                >
                  {confirm.action === "delete" ? "Remove client" : "Replace client"}
                </button>
                <button type="button" className={BTN} onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || !clientId.trim() || (!panel.configured && !secret.trim())}
                data-testid="google-client-save"
                className={BTN_PRIMARY}
                onClick={() => save()}
              >
                Save
              </button>
              {panel.configured && (
                <>
                  {/* A plain link: the round-trip is a top-level navigation to Google. */}
                  <a href="/api/google/connect?purpose=test" className={`${BTN} inline-flex items-center`} data-testid="google-client-test">
                    Test connection
                  </a>
                  <button type="button" disabled={busy} className={BTN} onClick={() => remove()} data-testid="google-client-remove">
                    Remove
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="grid content-start gap-2.5">
          <div className="grid gap-1">
            <span className={LABEL}>Authorised redirect URI — copy exactly</span>
            {panel.redirectUri ? (
              <Copyable value={panel.redirectUri} testId="google-redirect-uri" />
            ) : (
              <p className="text-[11.5px] text-[#FFB3C2]">GOOGLE_REDIRECT_URI is not set on this installation.</p>
            )}
          </div>
          <div className="grid gap-1">
            <span className={LABEL}>APIs to enable</span>
            <ul className="text-[12px] text-ink">
              {panel.requiredApis.map((a) => (
                <li key={a}>• {a}</li>
              ))}
            </ul>
          </div>
          <div className="grid gap-1">
            <span className={LABEL}>Scopes the consent screen must allow</span>
            <Copyable value={panel.scopes.join("\n")} testId="google-scopes" />
          </div>
          <p className="text-[11px] leading-relaxed text-muted">
            Step-by-step for your Google admin: Handbook → “Connecting a company&apos;s own Google
            Workspace”.
          </p>
        </div>
      </div>

      <div className="mt-4">
        <div className={`${LABEL} mb-1.5`}>Connected mailboxes and calendars ({panel.connections.length})</div>
        {panel.connections.length === 0 ? (
          <p className="text-[12px] text-muted">Nobody in this workspace has connected Google yet.</p>
        ) : (
          <ul className="grid gap-1" data-testid="google-connections">
            {panel.connections.map((c) => (
              <li key={c.credentialId} className="flex flex-wrap items-center gap-x-2 text-[12px]">
                <span className="text-ink">{c.userName}</span>
                <span className="text-muted">{c.accountEmail ?? "Google account"}</span>
                <span className="text-muted">
                  · {c.purpose === "WRITE" ? "calendar (bookings)" : "calendar (busy times)"}
                  {c.mailbox ? " + mailbox" : ""}
                </span>
                <span className={CLIENT_LABEL[c.client].tone}>· {CLIENT_LABEL[c.client].text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
