"use client";

import { useState, useTransition } from "react";
import { serverActionError } from "@/lib/client/server-action";
import { exportEmployeeData, getAccessReview } from "@/modules/members/review-actions";
import { DORMANT_DAYS, type AccessReview } from "@/modules/members/review-logic";
import {
  ACCOUNT_LOCK_MS,
  ACCOUNT_MAX_FAILURES,
} from "@/lib/auth/throttle";
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
} from "@/lib/auth/session-policy";

/**
 * The access review, and the sign-in policy it sits under (§7).
 *
 * ── WHY THE THREE LISTS ─────────────────────────────────────────────────────
 *
 * Every access review opens with the same three questions: who has access they
 * are not using, who holds the capabilities that bind the company, and what
 * invitations are outstanding. They are findings rather than failures — a
 * dormant account may be somebody on leave — so each row carries the fact that
 * prompted it rather than a verdict.
 *
 * ── WHY THE TIMEOUTS ARE SHOWN AND NOT EDITED ───────────────────────────────
 *
 * Session lifetimes and lockout thresholds already exist as installation-wide
 * constants, and the spec is explicit about reusing the existing mechanism
 * rather than adding a second one. Making them per-workspace would put a
 * workspace read on the session resolver — the hottest path in the app, on
 * every single request — for a setting nobody changes twice. So they are
 * surfaced, with their values, and mandatory 2FA stays the one part of the
 * policy that IS per workspace, because that is the part a workspace actually
 * has an opinion about.
 */
const BTN =
  "min-h-[30px] rounded-[8px] border border-line px-2 py-0.5 text-[11px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";

function days(ms: number): string {
  return `${Math.round(ms / 86_400_000)} days`;
}

export function SettingsAccessReview() {
  const [pending, startTransition] = useTransition();
  const [review, setReview] = useState<AccessReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function run() {
    setError(null);
    setNote(null);
    startTransition(async () => {
      try {
        const res = await getAccessReview();
        if ("error" in res) setError(res.error);
        else setReview(res);
      } catch (e) {
        setError(serverActionError(e));
      }
    });
  }

  function exportOne(userId: string, label: string) {
    setError(null);
    setNote(null);
    startTransition(async () => {
      try {
        const res = await exportEmployeeData(userId);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        const url = URL.createObjectURL(new Blob([res.json], { type: "application/json" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = res.filename;
        a.click();
        URL.revokeObjectURL(url);
        setNote(`Downloaded what we hold about ${label}. The export is audit-logged.`);
      } catch (e) {
        setError(serverActionError(e));
      }
    });
  }

  return (
    <section
      data-testid="settings-access-review"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-2xl font-bold lowercase tracking-display">
          access review
        </h2>
        <button onClick={run} disabled={pending} data-testid="review-run" className={BTN}>
          {pending ? "Checking…" : review ? "Check again" : "Run the review"}
        </button>
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-muted">
        The three lists an auditor asks for. They are findings, not failures —
        somebody dormant may be on leave, and a person holding{" "}
        <code>documents.send</code> is doing their job.
      </p>

      {/* ---- the policy this all sits under ---- */}
      <div className="mb-3 grid gap-1 rounded-[10px] border border-line bg-panel-2 p-3 text-[11.5px]">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          Sign-in policy
        </span>
        <span className="text-muted">
          Sessions expire <b className="text-ink">{days(SESSION_ABSOLUTE_TTL_MS)}</b> after
          sign-in, or <b className="text-ink">{days(SESSION_IDLE_TTL_MS)}</b> of not being
          used.
        </span>
        <span className="text-muted">
          <b className="text-ink">{ACCOUNT_MAX_FAILURES}</b> failed attempts locks an
          account for <b className="text-ink">{Math.round(ACCOUNT_LOCK_MS / 60_000)} minutes</b>,
          doubling on each repeat.
        </span>
        <span className="text-muted">
          Two-factor authentication is the one part of this a workspace sets for
          itself — under <b className="text-ink">security policy</b> above.
        </span>
        <span className="mt-1 text-[11px] leading-relaxed text-muted">
          The timeouts are installation-wide rather than per workspace on
          purpose: making them per workspace would put a database read on the
          session resolver, which runs on every request, for a setting nobody
          changes twice.
        </span>
      </div>

      {error && (
        <p role="alert" data-testid="review-error" className="mb-3 text-[12px] text-[#FFB3C2]">
          {error}
        </p>
      )}
      {note && (
        <p
          data-testid="review-note"
          className="mb-3 rounded-[8px] border border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] px-3 py-2 text-[12px] text-[#8CEFC0]"
        >
          {note}
        </p>
      )}

      {review && (
        <div className="grid gap-3">
          <Group
            title={`Not signed in for ${DORMANT_DAYS} days or more`}
            testId="review-dormant"
            empty="Everybody has signed in recently."
            rows={review.dormant.map((r) => ({
              key: r.userId,
              main: `${r.name} · ${r.email}`,
              detail: `${r.role} · ${r.detail}`,
              action: (
                <button
                  onClick={() => exportOne(r.userId, r.name)}
                  disabled={pending}
                  data-testid={`review-export-${r.userId}`}
                  className={BTN}
                >
                  Export their data
                </button>
              ),
            }))}
          />
          <Group
            title="Holding the capabilities that bind the company"
            testId="review-documents"
            empty="Nobody holds a document capability."
            rows={review.documentHolders.map((r) => ({
              key: r.userId,
              main: `${r.name} · ${r.role}`,
              detail: r.detail,
            }))}
          />
          <Group
            title="Invitations older than the window"
            testId="review-invitations"
            empty="No invitation has been out longer than it should be."
            rows={review.staleInvitations.map((r) => ({
              key: r.id,
              main: r.email,
              detail: `${r.role} · ${r.detail}`,
            }))}
          />
          {review.clean && (
            <p className="text-[12.5px] text-[#8CEFC0]" data-testid="review-clean">
              Nothing to review. Everybody is active and no invitation is stale.
            </p>
          )}
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        <b>Exporting a member&apos;s data</b> gives what the system holds about
        them as a person: profile, memberships, sign-in history, their timeline,
        notification settings, teams. Not the leads they worked — those are
        somebody else&apos;s personal data, and handing over four hundred
        prospects&apos; details because an employee asked what we hold about
        them would be a breach dressed as a subject-access response. Every
        export is audit-logged.
      </p>
    </section>
  );
}

function Group({
  title,
  testId,
  empty,
  rows,
}: {
  title: string;
  testId: string;
  empty: string;
  rows: { key: string; main: string; detail: string; action?: React.ReactNode }[];
}) {
  return (
    <div data-testid={testId}>
      <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
        {title} · {rows.length}
      </p>
      {rows.length === 0 ? (
        <p className="text-[11.5px] text-muted">{empty}</p>
      ) : (
        <ul className="grid gap-1">
          {rows.map((r) => (
            <li
              key={r.key}
              className="flex flex-wrap items-center gap-2 rounded-[9px] border border-line bg-panel-2 px-2.5 py-1.5 text-[11.5px]"
            >
              <span className="text-ink">{r.main}</span>
              <span className="text-muted">{r.detail}</span>
              {r.action && <span className="ml-auto">{r.action}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
