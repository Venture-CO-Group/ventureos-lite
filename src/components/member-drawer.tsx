"use client";

import { useEffect, useState } from "react";
import { getMemberDetail, type MemberDetail } from "@/modules/members/detail-actions";
import { eventLabel } from "@/modules/members/events";
import { MEMBERSHIP_STATE_DEFS } from "@/modules/members/lifecycle";
import type { ManagedUser } from "@/modules/users/actions";

/**
 * One member, everything about them (§3).
 *
 * ── WHY A DRAWER AND NOT A PAGE ─────────────────────────────────────────────
 *
 * The question this answers is always asked FROM the table — "why can Anna do
 * that", "when did Béla stop being an Admin", "what is on Cecil's plate". A
 * route would lose the list, and the list is the context.
 *
 * ── THE TWO HALVES ──────────────────────────────────────────────────────────
 *
 * Effective permissions, resolved rather than described. Every line is the
 * grants module asked about this membership, which is what stops a settings
 * screen from disagreeing with the code the first time the code changes.
 *
 * And the timeline: what happened to them, in order, with the reason where one
 * was given. That is the question asked when somebody says "I used to be able
 * to do that", and before this there was no way to answer it.
 */
function when(iso: string): string {
  return new Date(iso).toLocaleString("hu-HU");
}

const SOURCE_LABEL: Record<string, string> = {
  role: "carries it as",
  explicit: "granted explicitly",
  withdrawn: "withdrawn explicitly",
  none: "not granted",
};

export function MemberDrawer({
  user,
  onClose,
}: {
  user: ManagedUser;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await getMemberDetail(user.userId);
      if (!live) return;
      if ("error" in res) setError(res.error);
      else setDetail(res);
    })();
    return () => {
      live = false;
    };
  }, [user.userId]);

  const state = MEMBERSHIP_STATE_DEFS[user.state as keyof typeof MEMBERSHIP_STATE_DEFS];

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[rgba(0,5,29,0.7)]"
      role="dialog"
      aria-modal="true"
      aria-label={`${user.name} — member detail`}
      onClick={onClose}
    >
      <div
        data-testid="member-drawer"
        onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-[520px] overflow-y-auto border-l border-line bg-canvas p-5"
      >
        <div className="mb-4 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="font-display text-xl font-bold lowercase tracking-display">
              {user.name}
            </h3>
            <p className="text-[12px] text-muted">{user.email}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="rounded-[5px] bg-panel-2 px-1.5 py-px text-[10.5px] text-ink">
                {user.role}
              </span>
              {state && (
                <span
                  title={state.hint}
                  data-testid="drawer-state"
                  className={`rounded-[5px] px-1.5 py-px text-[10.5px] ${
                    state.tone === "ok"
                      ? "bg-[rgba(61,220,151,0.15)] text-[#8CEFC0]"
                      : state.tone === "warn"
                        ? "bg-[rgba(245,184,65,0.15)] text-[#FFD79A]"
                        : "bg-panel-2 text-muted"
                  }`}
                >
                  {state.label}
                </span>
              )}
              {user.totpEnabled ? (
                <span className="rounded-[5px] bg-panel-2 px-1.5 py-px text-[10.5px] text-[#8CEFC0]">
                  2FA on
                </span>
              ) : (
                <span className="rounded-[5px] bg-[rgba(245,184,65,0.15)] px-1.5 py-px text-[10.5px] text-[#FFD79A]">
                  no 2FA
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-muted hover:text-ink"
          >
            ✕
          </button>
        </div>

        {/* ---- what they are carrying ---- */}
        <section className="mb-4 rounded-[11px] border border-line p-3">
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
            On their plate
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Leads", value: user.activity.leads },
              { label: "Open deals", value: user.activity.openDeals },
              { label: "Open tasks", value: user.activity.openTasks },
              { label: "Meetings", value: user.activity.meetings },
            ].map((m) => (
              <div key={m.label} className="rounded-[9px] border border-line bg-panel-2 p-2">
                <b className="block text-[16px] tabular-nums text-ink">{m.value}</b>
                <span className="text-[10.5px] text-muted">{m.label}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            Last sign-in {user.lastLoginAt ? when(user.lastLoginAt) : "never"} ·{" "}
            {user.activeSessions} active {user.activeSessions === 1 ? "device" : "devices"}
            {user.teams.length > 0 && (
              <> · {user.teams.map((t) => t.name + (t.isLead ? " (lead)" : "")).join(", ")}</>
            )}
          </p>
        </section>

        {/* ---- effective permissions, computed ---- */}
        <section className="mb-4 rounded-[11px] border border-line p-3">
          <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
            What they can actually do
          </p>
          <p className="mb-2 text-[11px] leading-relaxed text-muted">
            Resolved from the grants model, not written down here — so this
            cannot drift from what the server enforces.
          </p>
          {error && <p className="text-[12px] text-[#FFB3C2]">{error}</p>}
          {!detail && !error && <p className="text-[12px] text-muted">Loading…</p>}
          {detail && (
            <ul className="grid gap-0.5" data-testid="drawer-permissions">
              {detail.effective.map((e) => (
                <li
                  key={e.grant}
                  data-testid={`perm-${e.grant}`}
                  className="flex flex-wrap items-baseline gap-1.5 text-[11.5px]"
                >
                  <span className={e.allowed ? "text-[#8CEFC0]" : "text-muted"}>
                    {e.allowed ? "✓" : "·"}
                  </span>
                  <code className={e.allowed ? "text-ink" : "text-muted"}>{e.grant}</code>
                  <span className="ml-auto text-[10.5px] text-muted">
                    {SOURCE_LABEL[e.source]}
                    {e.source === "role" ? ` ${user.role}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---- the timeline ---- */}
        <section className="rounded-[11px] border border-line p-3">
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
            History
          </p>
          {detail && detail.timeline.length === 0 && (
            <p className="text-[12px] text-muted">
              Nothing recorded yet. Everything from here on is.
            </p>
          )}
          {detail && detail.timeline.length > 0 && (
            <ol className="grid gap-2" data-testid="drawer-timeline">
              {detail.timeline.map((t) => (
                <li
                  key={t.id}
                  data-testid="timeline-entry"
                  className="border-l-2 border-line pl-2.5"
                >
                  <b className="block text-[12px] text-ink">{eventLabel(t.kind)}</b>
                  <span className="block text-[11px] tabular-nums text-muted">
                    {when(t.at)}
                    {t.actorName && ` · by ${t.actorName}`}
                  </span>
                  {t.reason && (
                    <span className="mt-0.5 block text-[11px] italic text-muted">
                      “{t.reason}”
                    </span>
                  )}
                  {/* `Boolean(...)`: before/after are `unknown` off a JSON
                      column, and an `unknown` short-circuit is not a
                      ReactNode. */}
                  {Boolean(t.before || t.after) && (
                    <span className="mt-0.5 block break-all text-[10.5px] text-muted">
                      {t.before ? `${JSON.stringify(t.before)} → ` : null}
                      {t.after ? String(JSON.stringify(t.after)) : null}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
