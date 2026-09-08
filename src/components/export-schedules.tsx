"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { serverActionError } from "@/lib/client/server-action";
import {
  deleteSchedule,
  listSchedules,
  runScheduleNow,
  saveSchedule,
  setScheduleEnabled,
  type ScheduleView,
} from "@/modules/leads/schedule-actions";
import {
  CADENCE_LABEL,
  EXPORT_CADENCES,
  WEEKDAY_LABEL,
  type ExportCadence,
} from "@/modules/leads/schedule-logic";
import { EXPORT_FORMATS, FORMAT_LABEL } from "@/modules/leads/export-formats";
import type { LeadView } from "@/modules/leads/views";
import { Modal } from "./modal";

/**
 * A saved view, emailed on a schedule (P2/2.1).
 *
 * ── WHY IT LIVES BESIDE THE TABS ────────────────────────────────────────────
 *
 * A schedule is a saved view plus a cadence. Putting it in Settings would put
 * it three clicks from the thing it is about, and would leave somebody editing
 * a filter with no idea that a colleague receives it every Monday. Here, the
 * count of live schedules sits next to the tab strip that owns them.
 */
const INPUT =
  "w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent";

function ago(iso: string | null): string {
  if (!iso) return "never";
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days > 0) return `${days}d ago`;
  return new Date(iso).toLocaleString("hu-HU", { dateStyle: "short", timeStyle: "short" });
}

function soon(iso: string | null): string {
  if (!iso) return "paused";
  return new Date(iso).toLocaleString("hu-HU", { dateStyle: "short", timeStyle: "short" });
}

export function ExportSchedules({
  views,
  activeViewId,
  canExport,
}: {
  views: LeadView[];
  activeViewId: string | null;
  canExport: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ScheduleView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Form state.
  const [editing, setEditing] = useState<string | null>(null);
  const [viewId, setViewId] = useState(activeViewId ?? views[0]?.id ?? "");
  const [format, setFormat] = useState<string>("xlsx");
  const [cadence, setCadence] = useState<ExportCadence>("weekly");
  const [dayOfWeek, setDayOfWeek] = useState("1");
  const [dayOfMonth, setDayOfMonth] = useState("1");
  const [hour, setHour] = useState("8");
  const [recipients, setRecipients] = useState("");

  const load = async () => setRows(await listSchedules().catch(() => []));

  useEffect(() => {
    if (open) void load();
  }, [open]);

  // The badge is worth showing before the dialog is ever opened: a schedule
  // nobody remembers setting up is exactly the one that should be visible.
  useEffect(() => {
    void load();
  }, []);

  function reset() {
    setEditing(null);
    setViewId(activeViewId ?? views[0]?.id ?? "");
    setFormat("xlsx");
    setCadence("weekly");
    setDayOfWeek("1");
    setDayOfMonth("1");
    setHour("8");
    setRecipients("");
  }

  async function guard(fn: () => Promise<{ ok: boolean; error?: string }>, okText?: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fn();
      if (!res.ok) {
        setError(res.error ?? "That did not work.");
        return false;
      }
      if (okText) setNote(okText);
      await load();
      router.refresh();
      return true;
    } catch (e) {
      setError(serverActionError(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const live = (rows ?? []).filter((r) => r.enabled).length;

  if (views.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="open-schedules"
        className="rounded-[9px] border border-line bg-panel px-2.5 py-1 text-[11.5px] text-muted hover:text-ink"
      >
        Scheduled exports
        {live > 0 && (
          <span
            data-testid="schedule-count"
            className="ml-1.5 rounded-full bg-accent-soft px-1.5 text-[10px] font-semibold text-accent-ink tabular-nums"
          >
            {live}
          </span>
        )}
      </button>

      {open && (
        <Modal onClose={() => setOpen(false)} labelledBy="schedules-title">
          <div className="mb-3 flex items-center">
            <h3 id="schedules-title" className="font-display text-lg font-bold lowercase">
              scheduled exports
            </h3>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="ml-auto text-muted hover:text-ink"
            >
              ✕
            </button>
          </div>

          <p className="mb-3 text-[11.5px] leading-relaxed text-muted">
            A saved view, emailed on a schedule, with the columns that view is
            set to show. Nothing is sent when the view matches no leads — a
            weekly &ldquo;nothing&rdquo; is how a sender ends up in a folder.
          </p>

          {error && (
            <p role="alert" className="mb-2 text-[12px] text-[#FFB3C2]">
              {error}
            </p>
          )}
          {note && <p className="mb-2 text-[12px] text-[#8CEFC0]">{note}</p>}

          {/* ---- existing ---- */}
          {rows && rows.length > 0 && (
            <ul className="mb-4 grid gap-1.5" data-testid="schedule-list">
              {rows.map((r) => (
                <li
                  key={r.id}
                  data-testid="schedule-row"
                  className={`rounded-[10px] border px-3 py-2 ${
                    r.enabled ? "border-line bg-panel-2" : "border-line bg-panel-2/40 opacity-70"
                  }`}
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <b className="text-[12.5px]">{r.viewName}</b>
                    <span className="rounded-full bg-panel px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted">
                      {r.format}
                    </span>
                    <span className="text-[11.5px] text-muted">{r.description}</span>
                    {!r.enabled && (
                      <span className="rounded-full bg-[rgba(245,184,65,0.15)] px-2 py-0.5 text-[10px] font-semibold text-warn">
                        paused
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted">
                    {r.recipients.length > 0 ? r.recipients.join(", ") : "to whoever set it up"} ·
                    last {ago(r.lastRunAt)} · next {soon(r.nextRunAt)}
                  </div>
                  {r.lastError && (
                    <p
                      data-testid="schedule-error"
                      className="mt-1 rounded-[6px] border border-[rgba(255,92,122,0.3)] bg-[rgba(255,92,122,0.08)] px-2 py-1 text-[11px] text-[#FFB3C2]"
                    >
                      Last run failed: {r.lastError}
                    </p>
                  )}
                  {canExport && (
                    <div className="mt-1.5 flex flex-wrap gap-2 text-[11.5px]">
                      <button
                        onClick={() => void guard(() => runScheduleNow(r.id), "Queued — it will arrive within the hour.")}
                        disabled={busy}
                        data-testid="schedule-run-now"
                        className="text-muted underline hover:text-ink"
                      >
                        Send it now
                      </button>
                      <button
                        onClick={() => void guard(() => setScheduleEnabled(r.id, !r.enabled))}
                        disabled={busy}
                        data-testid="schedule-toggle"
                        className="text-muted underline hover:text-ink"
                      >
                        {r.enabled ? "Pause" : "Resume"}
                      </button>
                      <button
                        onClick={() => {
                          setEditing(r.id);
                          setViewId(r.viewId);
                          setFormat(r.format);
                          setCadence(r.cadence as ExportCadence);
                          setDayOfWeek(String(r.dayOfWeek));
                          setDayOfMonth(String(r.dayOfMonth));
                          setHour(String(r.hour));
                          setRecipients(r.recipients.join(", "));
                        }}
                        className="text-muted underline hover:text-ink"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => void guard(() => deleteSchedule(r.id), "Removed.")}
                        disabled={busy}
                        data-testid="schedule-delete"
                        className="text-muted underline hover:text-[#FFB3C2]"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* ---- form ---- */}
          {canExport ? (
            <div className="grid gap-2.5 rounded-[11px] border border-line bg-panel-2 p-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                {editing ? "Edit this schedule" : "New schedule"}
              </div>

              <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
                View
                <select
                  value={viewId}
                  onChange={(e) => setViewId(e.target.value)}
                  data-testid="schedule-view"
                  className={INPUT}
                >
                  {views.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                      {v.shared ? " (shared)" : ""}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid gap-2.5 sm:grid-cols-2">
                <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
                  Format
                  <select
                    value={format}
                    onChange={(e) => setFormat(e.target.value)}
                    data-testid="schedule-format"
                    className={INPUT}
                  >
                    {EXPORT_FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {FORMAT_LABEL[f]}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
                  How often
                  <select
                    value={cadence}
                    onChange={(e) => setCadence(e.target.value as ExportCadence)}
                    data-testid="schedule-cadence"
                    className={INPUT}
                  >
                    {EXPORT_CADENCES.map((c) => (
                      <option key={c} value={c}>
                        {CADENCE_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </label>

                {cadence === "weekly" && (
                  <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
                    Day
                    <select
                      value={dayOfWeek}
                      onChange={(e) => setDayOfWeek(e.target.value)}
                      data-testid="schedule-weekday"
                      className={INPUT}
                    >
                      {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                        <option key={d} value={String(d)}>
                          {WEEKDAY_LABEL[d]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {cadence === "monthly" && (
                  <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
                    Day of month
                    <select
                      value={dayOfMonth}
                      onChange={(e) => setDayOfMonth(e.target.value)}
                      data-testid="schedule-monthday"
                      className={INPUT}
                    >
                      {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                        <option key={d} value={String(d)}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
                  Hour
                  <select
                    value={hour}
                    onChange={(e) => setHour(e.target.value)}
                    data-testid="schedule-hour"
                    className={INPUT}
                  >
                    {Array.from({ length: 24 }, (_, i) => i).map((h) => (
                      <option key={h} value={String(h)}>
                        {String(h).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
                Send to · comma separated, blank means you
                <input
                  value={recipients}
                  onChange={(e) => setRecipients(e.target.value)}
                  placeholder="me@example.com, colleague@example.com"
                  data-testid="schedule-recipients"
                  className={INPUT}
                />
              </label>
              <p className="text-[10.5px] leading-relaxed text-muted">
                Anybody on the suppression list is skipped, whatever a schedule
                says — an unsubscribe outranks a colleague&apos;s setup.
              </p>

              <div className="flex gap-2">
                <button
                  disabled={busy || !viewId}
                  data-testid="schedule-save"
                  onClick={async () => {
                    const ok = await guard(
                      () =>
                        saveSchedule({
                          id: editing ?? undefined,
                          viewId,
                          format,
                          cadence,
                          dayOfWeek,
                          dayOfMonth,
                          hour,
                          recipients: recipients
                            .split(",")
                            .map((r) => r.trim())
                            .filter(Boolean),
                        }),
                      editing ? "Schedule updated." : "Schedule created.",
                    );
                    if (ok) reset();
                  }}
                  className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-3.5 py-2 text-[12.5px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
                >
                  {editing ? "Save changes" : "Schedule it"}
                </button>
                {editing && (
                  <button onClick={reset} className="text-[12px] text-muted underline hover:text-ink">
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-muted">
              Needs the <code>exports.run</code> capability — a schedule is an
              export that happens without anybody pressing the button.
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
