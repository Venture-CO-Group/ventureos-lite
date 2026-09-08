"use client";
import { attempt } from "@/lib/client/server-action";
import { serverActionError } from "@/lib/client/server-action";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  registerPushDevice,
  setNotificationPreference,
  unregisterPushDevice,
  type PreferenceMatrix,
  type PreferenceRow,
} from "@/modules/notifications/preference-actions";

/**
 * Settings → Notifications (playbook-v2 P6/1): the per-type × per-channel
 * matrix, plus enabling push on this device.
 *
 * The three channels are deliberately not equivalent, and the copy says so:
 * in-app is the bell, push needs a browser permission, and "email" is a line
 * in the existing Monday digest rather than a message per event — the playbook
 * is explicit that this must not become per-event mail.
 */

/**
 * base64url → ArrayBuffer, the form the Push API wants the VAPID key in.
 *
 * Returns the buffer rather than the view because `applicationServerKey` is
 * typed as BufferSource over a plain ArrayBuffer, and a Uint8Array over
 * ArrayBufferLike does not satisfy it.
 */
function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalised);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) view[i] = raw.charCodeAt(i);
  return buffer;
}

function Toggle({
  on,
  disabled,
  label,
  testId,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  testId: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center justify-center">
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        aria-label={label}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[#7427C6] disabled:opacity-40"
      />
    </label>
  );
}

export function SettingsNotifications({ initial }: { initial: PreferenceMatrix }) {
  const router = useRouter();
  const [rows, setRows] = useState<PreferenceRow[]>(initial.rows);
  const [devices, setDevices] = useState(initial.devices);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Writes still in flight. Surfaced as `data-saving` for the operator and for tests. */
  const [saving, setSaving] = useState(0);

  async function toggle(
    type: string,
    channel: "inApp" | "push" | "emailDigest" | "emailNow",
    value: boolean,
  ) {
    setError(null);
    // Optimistic: a checkbox that waits for a round trip feels broken.
    setRows((r) => r.map((row) => (row.type === type ? { ...row, [channel]: value } : row)));
    /**
     * `attempt`, and an in-flight count.
     *
     * An optimistic checkbox whose write THREW left the tick in place and said
     * nothing — the operator walks away believing a preference is set that was
     * never stored. That is worse than a checkbox that feels slow. A refusal
     * already reverted; now so does an unexpected failure.
     *
     * The in-flight count is also what makes this testable: the tick flips
     * before the server has answered, so a test that reloads immediately can
     * race the write it is trying to verify.
     */
    setSaving((n) => n + 1);
    const res = await attempt(setNotificationPreference({ type, channel, value }));
    setSaving((n) => n - 1);
    if (!res.ok) {
      setRows((r) => r.map((row) => (row.type === type ? { ...row, [channel]: !value } : row)));
      setError(res.error);
    }
  }

  async function enablePush() {
    setError(null);
    setBusy(true);
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setError("This browser cannot receive push notifications.");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setError(
          permission === "denied"
            ? "Notifications are blocked for this site — allow them in the browser's site settings first."
            : "Permission was dismissed.",
        );
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.subscribe({
        // Required by Chrome: a push that is not shown to the user is refused.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBuffer(initial.vapidPublicKey!),
      });

      const json = sub.toJSON() as { endpoint?: string; keys?: Record<string, string> };
      const res = await registerPushDevice({
        endpoint: json.endpoint,
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
        userAgent: navigator.userAgent.slice(0, 400),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDevices((d) => d + 1);
      router.refresh();
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(false);
    }
  }

  async function disablePush() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const sub = await registration?.pushManager.getSubscription();
      if (sub) {
        await unregisterPushDevice(sub.endpoint);
        await sub.unsubscribe();
        setDevices((d) => Math.max(0, d - 1));
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const headerClass =
    "px-2 py-2 text-center text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted";

  return (
    <section
      data-testid="settings-notifications"
      data-saving={saving > 0 ? "true" : "false"}
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <h2 className="mb-1 font-display text-lg font-bold lowercase">notifications</h2>
      <p className="mb-3 text-[12.5px] text-muted">
        What reaches you, and how. <b>In-app</b> is the bell. <b>Push</b> needs
        this browser&apos;s permission. <b>Email</b> adds a line to the Monday
        digest — never a message per event.
      </p>

      {error && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3 py-2 text-[12.5px] text-[#FFB3C2]">
          {error}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-[10px] border border-line bg-[rgba(0,5,29,0.35)] px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <b className="text-[12.5px]">Push on this device</b>
          <span className="block text-[11.5px] text-muted">
            {!initial.pushAvailable
              ? "Unavailable — no VAPID keys are configured on this server."
              : devices > 0
                ? `${devices} device${devices === 1 ? "" : "s"} registered.`
                : "Not registered yet."}
          </span>
        </div>
        <button
          type="button"
          onClick={enablePush}
          disabled={!initial.pushAvailable || busy}
          data-testid="push-enable"
          className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2 disabled:opacity-50"
        >
          {busy ? "Working…" : "Enable push"}
        </button>
        {devices > 0 && (
          <button
            type="button"
            onClick={disablePush}
            disabled={busy}
            data-testid="push-disable"
            className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="px-2 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted">
                Notification
              </th>
              <th className={headerClass}>In-app</th>
              <th className={headerClass}>Push</th>
              {/*
                Two email columns, because they are two different promises.

                "Straight away" is one message per event and defaults on for
                exactly one type — a task somebody just put on your plate,
                where the whole value is arriving before you next open the app.
                "Digest" batches into the Monday summary and the start-of-day
                task email. A product that mails on every notification is a
                product whose mail gets filtered.
              */}
              <th className={headerClass}>
                Email
                <span className="block text-[9.5px] normal-case tracking-normal">
                  straight away
                </span>
              </th>
              <th className={headerClass}>
                Email
                <span className="block text-[9.5px] normal-case tracking-normal">digest</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.type} data-testid="preference-row" data-type={row.type}>
                <td className="border-t border-line px-2 py-2.5">
                  <b className="text-[12.5px]">{row.label}</b>
                  <span className="block text-[11.5px] text-muted">{row.description}</span>
                </td>
                <td className="border-t border-line px-2 py-2.5 text-center">
                  <Toggle
                    on={row.inApp}
                    label={`${row.label} in-app`}
                    testId={`pref-${row.type}-inApp`}
                    onChange={(v) => toggle(row.type, "inApp", v)}
                  />
                </td>
                <td className="border-t border-line px-2 py-2.5 text-center">
                  <Toggle
                    on={row.push}
                    disabled={!initial.pushAvailable}
                    label={`${row.label} push`}
                    testId={`pref-${row.type}-push`}
                    onChange={(v) => toggle(row.type, "push", v)}
                  />
                </td>
                <td className="border-t border-line px-2 py-2.5 text-center">
                  <Toggle
                    on={row.emailNow}
                    label={`${row.label} email straight away`}
                    testId={`pref-${row.type}-emailNow`}
                    onChange={(v) => toggle(row.type, "emailNow", v)}
                  />
                </td>
                <td className="border-t border-line px-2 py-2.5 text-center">
                  <Toggle
                    on={row.emailDigest}
                    label={`${row.label} email digest`}
                    testId={`pref-${row.type}-emailDigest`}
                    onChange={(v) => toggle(row.type, "emailDigest", v)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
