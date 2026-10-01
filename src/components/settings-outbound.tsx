"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import { saveOutboundSettings, resumeSending, type MailboxStatus } from "@/modules/outbound/settings-actions";
import type { OutboundConfig } from "@/modules/outbound/config";
import { COLD_OUTBOUND_ADDRESS } from "@/modules/outbound/config";

/**
 * Admin → Outbound (playbook-v6). One form per concern — quota, schedule,
 * caps, sending — saved together, because they only make sense as a set: a
 * cap of 25 with a warm-up of 10 is a backlog, and the form says so.
 */

const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] tabular-nums text-ink outline-none focus:border-accent";
const LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted";
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function Num({
  label,
  value,
  onChange,
  min = 0,
  max,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  disabled: boolean;
}) {
  return (
    <label className="grid gap-1">
      <span className={LABEL}>{label}</span>
      <input
        type="number"
        className={INPUT}
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </label>
  );
}

export function SettingsOutbound({ config, isOwner, mailbox }: { config: OutboundConfig; isOwner: boolean; mailbox: MailboxStatus }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [c, setC] = useState(config);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const disabled = !isOwner || pending;

  function patch<K extends keyof OutboundConfig>(k: K, v: Partial<OutboundConfig[K]>) {
    setSaved(false);
    setC((cur) => ({ ...cur, [k]: { ...cur[k], ...v } }));
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await attempt(saveOutboundSettings(c));
      if (!res.ok) setError(res.error);
      else {
        setSaved(true);
        router.refresh();
      }
    });
  }

  const backlog = c.cap.after > c.warmup.ceiling || c.cap.initial > c.warmup.start;

  return (
    <section className="grid gap-5 rounded-card border border-line bg-panel p-[18px]" data-testid="settings-outbound">
      {error && <p className="text-[12px] text-[#FFB3C2]">{error}</p>}

      <div className="grid gap-2">
        <h3 className="font-display text-[16px] font-bold lowercase">registry quota</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Num label="Datasheets per month (plan)" value={c.registry.monthlyLimit} onChange={(n) => patch("registry", { monthlyLimit: n })} disabled={disabled} />
          <Num label="Interactive reserve (%)" value={c.registry.reservePct} max={90} onChange={(n) => patch("registry", { reservePct: n })} disabled={disabled} />
        </div>
      </div>

      <div className="grid gap-2">
        <h3 className="font-display text-[16px] font-bold lowercase">nightly run</h3>
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={c.schedule.enabled} disabled={disabled} onChange={(e) => patch("schedule", { enabled: e.target.checked })} />
          Fill the approval queue overnight
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <Num label="Hour" value={c.schedule.hour} max={23} onChange={(n) => patch("schedule", { hour: n })} disabled={disabled} />
          <Num label="Minute" value={c.schedule.minute} max={59} onChange={(n) => patch("schedule", { minute: n })} disabled={disabled} />
          <label className="grid gap-1">
            <span className={LABEL}>Timezone</span>
            <input className={INPUT} value={c.schedule.timezone} disabled={disabled} onChange={(e) => patch("schedule", { timezone: e.target.value })} />
          </label>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((d, i) => {
            const day = i + 1;
            const on = c.schedule.days.includes(day);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                onClick={() =>
                  patch("schedule", { days: on ? c.schedule.days.filter((x) => x !== day) : [...c.schedule.days, day].sort() })
                }
                className={`min-h-[36px] min-w-[44px] rounded-full border px-2.5 text-[12px] ${on ? "border-accent text-ink" : "border-line text-muted"}`}
              >
                {d}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-2">
        <h3 className="font-display text-[16px] font-bold lowercase">daily caps</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <Num label="Drafts / day at launch" value={c.cap.initial} onChange={(n) => patch("cap", { initial: n })} disabled={disabled} />
          <Num label="Drafts / day after ramp" value={c.cap.after} onChange={(n) => patch("cap", { after: n })} disabled={disabled} />
          <Num label="Ramp length (days)" value={c.cap.rampDays} onChange={(n) => patch("cap", { rampDays: n })} disabled={disabled} />
          <Num label="Sends on day one" value={c.warmup.start} min={1} onChange={(n) => patch("warmup", { start: n })} disabled={disabled} />
          <Num label="+ sends per step" value={c.warmup.step} onChange={(n) => patch("warmup", { step: n })} disabled={disabled} />
          <Num label="Step every (days)" value={c.warmup.everyDays} min={1} onChange={(n) => patch("warmup", { everyDays: n })} disabled={disabled} />
          <Num label="Send ceiling / day" value={c.warmup.ceiling} min={1} onChange={(n) => patch("warmup", { ceiling: n })} disabled={disabled} />
        </div>
        {backlog && (
          <p className="text-[11.5px] text-muted">
            More drafts can be approved than the mailbox may send while it warms up. Approved messages wait and go
            out on the following days — nothing is dropped, but replies will lag approvals.
          </p>
        )}
      </div>

      <div className="grid gap-2">
        <h3 className="font-display text-[16px] font-bold lowercase">sending</h3>
        <p className="text-[12px] text-muted">
          Cold outbound sends only from <b className="text-ink">{COLD_OUTBOUND_ADDRESS}</b>, through that account&apos;s own
          Gmail. Connect it under Settings → Email while signed in as that user.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Num label="Min seconds between sends" value={c.sending.spacingMinSec} onChange={(n) => patch("sending", { spacingMinSec: n })} disabled={disabled} />
          <Num label="Max seconds between sends" value={c.sending.spacingMaxSec} onChange={(n) => patch("sending", { spacingMaxSec: n })} disabled={disabled} />
          <Num label="Send window from (hour)" value={c.sending.windowStartHour} max={23} onChange={(n) => patch("sending", { windowStartHour: n })} disabled={disabled} />
          <Num label="Send window until (hour)" value={c.sending.windowEndHour} min={1} max={24} onChange={(n) => patch("sending", { windowEndHour: n })} disabled={disabled} />
          <label className="grid gap-1">
            <span className={LABEL}>Pause above bounce rate (%)</span>
            <input
              type="number"
              className={INPUT}
              value={Math.round(c.sending.bounceThreshold * 1000) / 10}
              step={0.5}
              min={0}
              max={100}
              disabled={disabled}
              onChange={(e) => patch("sending", { bounceThreshold: (Number(e.target.value) || 0) / 100 })}
            />
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>Follow-up offsets (days, max two)</span>
            <input
              className={INPUT}
              value={c.followups.offsetsDays.join(", ")}
              disabled={disabled}
              onChange={(e) =>
                patch("followups", {
                  offsetsDays: e.target.value
                    .split(",")
                    .map((x) => Number(x.trim()))
                    .filter((n) => Number.isInteger(n) && n > 0)
                    .slice(0, 2),
                })
              }
            />
          </label>
        </div>
        <p className="text-[11.5px] text-muted">
          Cold outbound leaves as plain text with no tracking pixel and no rewritten links.
        </p>
        <label className="grid gap-1">
          <span className={LABEL}>Fallback signature (used when the Gmail account has none)</span>
          <textarea
            className={`${INPUT} min-h-[72px] tabular-nums`}
            value={c.sending.fallbackSignature}
            disabled={disabled}
            onChange={(e) => patch("sending", { fallbackSignature: e.target.value })}
          />
        </label>
        <p className="text-[12px] tabular-nums" data-testid="outbound-mailbox">
          {mailbox.connected ? (
            <>
              Mailbox connected{mailbox.connectedBy ? ` by ${mailbox.connectedBy}` : ""} · {mailbox.sentToday} / {mailbox.sendCapToday} sent today
              {mailbox.signatureFetchedAt ? ` · signature read ${mailbox.signatureFetchedAt.slice(0, 10)}` : " · signature not read yet"}
            </>
          ) : (
            <span className="text-[#FFD27A]">
              {mailbox.health === "reconnect_needed" ? "The mailbox needs reconnecting" : "The mailbox is not connected"} — nothing is sent until it is.
            </span>
          )}
        </p>
        {c.sending.pausedAt && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[12px] text-[#FFB3C2]">
              Sending is paused since {c.sending.pausedAt.slice(0, 16).replace("T", " ")}: {c.sending.pausedReason}
            </p>
            {isOwner && (
              <button
                type="button"
                disabled={pending}
                className="min-h-[36px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink hover:border-accent"
                onClick={() =>
                  startTransition(async () => {
                    const res = await attempt(resumeSending());
                    if (!res.ok) setError(res.error);
                    else router.refresh();
                  })
                }
              >
                Resume sending
              </button>
            )}
          </div>
        )}
      </div>

      {isOwner ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="min-h-[40px] rounded-[9px] border border-line px-3 py-2 text-[12.5px] font-semibold text-ink hover:border-accent disabled:opacity-45"
            data-testid="settings-outbound-save"
          >
            {pending ? "Saving…" : "Save outbound settings"}
          </button>
          {saved && <span className="text-[11.5px] text-pos">saved</span>}
        </div>
      ) : (
        <p className="text-[11.5px] text-muted">Only an Owner changes these.</p>
      )}
    </section>
  );
}
