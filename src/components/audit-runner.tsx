"use client";
import { attemptVoid } from "@/lib/client/server-action";

import { serverActionError } from "@/lib/client/server-action";
import { useEffect, useRef, useState } from "react";
import type { AuditView } from "@/modules/audit/types";
import { auditStagesFor, currentAuditStage } from "@/modules/audit/stages";
import { JobProgress } from "./job-progress";
import { SiteStructure } from "./site-structure";
import { FieldData } from "./field-data";
import { ComparisonPanel } from "./comparison-panel";
import { PriorityMatrixPanel } from "./priority-matrix";
import { TrendStrip } from "./trend-strip";
import { ScreenshotCompare } from "./screenshot-compare";
import {
  startAudit,
  getAudit,
  createLeadFromAudit,
  exportAuditPdf,
  publishShare,
} from "@/modules/audit/actions";
import { createBoardFromAudit } from "@/modules/tasks/board-actions";

const POLL_MS = 1500;
/**
 * How long the page will keep asking.
 *
 * This was 45 seconds, and it was the second half of the "audit dies" report.
 * A single-page audit routinely runs longer than that — PageSpeed alone is a
 * real Lighthouse run on Google's hardware, and two screenshots are two more
 * page loads — so the poller regularly gave up on a HEALTHY run, stopped
 * silently, and left a spinner turning over an audit that finished fine thirty
 * seconds later. The worker's own ceiling is five minutes; the page now
 * outlasts it, and says so when it does not.
 */
const POLL_TIMEOUT_MS = 360_000;
/**
 * A static crawl adds ~75s of paced fetching; a JS-heavy site switches to
 * rendered mode, which the worker caps at three minutes (P2/9).
 */
const CRAWL_POLL_TIMEOUT_MS = 420_000;

function VerdictChip({ verdict }: { verdict: string }) {
  const map: Record<string, string> = {
    STRONG: "bg-[rgba(245,184,65,0.12)] text-warn",
    POSSIBLE: "bg-accent-soft text-accent-ink",
    SKIP: "bg-panel-2 text-muted",
  };
  const label =
    verdict === "STRONG" ? "Strong prospect" : verdict === "POSSIBLE" ? "Possible" : "Skip";
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${map[verdict] ?? map.SKIP}`}>
      {label}
    </span>
  );
}

export function AuditRunner({
  initialUrl,
  autoRun = false,
}: {
  initialUrl: string;
  /**
   * Start immediately, without a second click.
   *
   * Set when the operator arrived here from a lead's "Audit site" button: they
   * already asked for the audit, and making them press Run again on a prefilled
   * form is a step that carries no decision.
   */
  autoRun?: boolean;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [withPitch, setWithPitch] = useState(false);
  // Internal-only: public and self-serve audits stay single-page (P2/1).
  const [withCrawl, setWithCrawl] = useState(false);
  const [auditId, setAuditId] = useState<string | null>(null);
  const [view, setView] = useState<AuditView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<"added" | "duplicate" | null>(null);
  const [pdf, setPdf] = useState<"idle" | "generating" | string>("idle");
  const [share, setShare] = useState<{ url: string; expiresAt: string } | null>(null);
  const [sharing, setSharing] = useState(false);
  /** The board built from this audit's failing checks (P1/1.3). */
  const [plan, setPlan] = useState<{ boardId: string; tasks: number } | null>(null);
  const [planning, setPlanning] = useState(false);
  // Set when the poller gave up rather than the audit finishing. Without it,
  // "we stopped asking" and "it is still working" looked identical on screen.
  const [gaveUp, setGaveUp] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When the current run began, for the elapsed counter in JobProgress.
  const [startedAt, setStartedAt] = useState<number | null>(null);

  // Poll the audit record for progressive results.
  useEffect(() => {
    if (!auditId) return;
    let active = true;
    const started = Date.now();
    const tick = async () => {
      // A transient failure (a redeploy, a dropped connection) used to end the
      // poll permanently, because the rejection escaped the loop and no
      // further tick was ever scheduled.
      const v = await getAudit(auditId).catch(() => null);
      if (!active) return;
      if (v) setView(v);
      if (v && (v.status === "done" || v.status === "error")) return;
      if (Date.now() - started > (withCrawl ? CRAWL_POLL_TIMEOUT_MS : POLL_TIMEOUT_MS)) {
        setGaveUp(true);
        return;
      }
      timer.current = setTimeout(tick, POLL_MS);
    };
    timer.current = setTimeout(tick, 300);
    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [auditId, withCrawl]);

  // Reflect an already-rendered PDF (e.g. a cached audit).
  useEffect(() => {
    if (view?.pdfPath && pdf === "idle") setPdf(view.pdfPath);
  }, [view?.pdfPath, pdf]);

  async function run() {
    if (!url.trim()) return;
    setError(null);
    setView(null);
    setAdded(null);
    setPdf("idle");
    setShare(null);
    setPlan(null);
    setGaveUp(false);
    setBusy(true);
    setStartedAt(Date.now());
    try {
      const { auditId: id } = await startAudit({ url, withPitch, crawl: withCrawl });
      setAuditId(id);
    } catch (e) {
      // `startAudit` validates by `parse`, so a rejected URL leaves by `throw` —
      // and Next.js strips the message off anything thrown out of a Server
      // Action in production. `(e as Error).message` was therefore EMPTY there,
      // and `{error && …}` rendered nothing: the button looked broken.
      setError(serverActionError(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The one-shot auto-start. Guarded by a ref rather than by `auditId` so that
   * a failed first attempt is not retried on every render.
   */
  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoRun || autoRan.current || !initialUrl.trim()) return;
    autoRan.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, initialUrl]);

  async function exportPdf() {
    if (!view) return;
    setPdf("generating");
    // A PDF request that threw used to leave the button saying "generating…"
    // forever, with nothing on screen to say why.
    const failed = await attemptVoid(exportAuditPdf(view.id));
    if (failed) {
      setPdf("idle");
      setError(failed);
      return;
    }
    const started = Date.now();
    while (Date.now() - started < 30_000) {
      await new Promise((r) => setTimeout(r, 1500));
      const v = await getAudit(view.id);
      if (v?.pdfPath) {
        setPdf(v.pdfPath);
        return;
      }
    }
    setPdf("idle"); // timed out — let the user retry
  }

  async function publish() {
    if (!view) return;
    setSharing(true);
    try {
      setShare(await publishShare(view.id));
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setSharing(false);
    }
  }

  const running =
    !!auditId &&
    !gaveUp &&
    (!view || view.status === "queued" || view.status === "running");

  // The steps THIS run will take, and the one it is actually on — both from
  // the audit module, so the panel cannot advertise a step the worker never
  // reports. It used to list three and could only reach two.
  const AUDIT_STAGES = auditStagesFor({ crawl: withCrawl, withPitch });
  const stage = view ? currentAuditStage(view) : "queued";

  return (
    <div className="max-w-[1400px]">
      {error && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3.5 py-2.5 text-[12.5px] text-[#FFB3C2]">
          {error}
        </div>
      )}

      <div className="mb-4 rounded-card border border-line bg-panel p-[18px]">
        <div className="flex flex-wrap gap-2.5">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Website URL"
            className="min-w-[220px] flex-1 rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent"
          />
          <button
            onClick={run}
            disabled={busy || !!running}
            className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
          >
            {running ? "Auditing…" : "Run audit"}
          </button>
        </div>
        <label className="mt-2.5 flex items-center gap-2 text-[11.5px] text-muted">
          <input
            type="checkbox"
            checked={withPitch}
            onChange={(e) => setWithPitch(e.target.checked)}
            style={{ accentColor: "#7427C6" }}
          />
          Add Claude pitch angle · 1 Haiku call (off by default)
          <span className="ml-auto">
            Checks run locally + PageSpeed API ·{" "}
            <b className="text-[#C9CEE3]">
              {withPitch ? "1 Claude call" : "0 Claude calls"}
            </b>
          </span>
        </label>
        <label className="mt-1.5 flex items-center gap-2 text-[11.5px] text-muted">
          <input
            type="checkbox"
            checked={withCrawl}
            onChange={(e) => setWithCrawl(e.target.checked)}
            style={{ accentColor: "#7427C6" }}
          />
          Crawl up to 15 pages · finds broken links and duplicate titles
          <span className="ml-auto">
            Internal only · ~75s, JS-heavy sites up to 3 min · 1 req/sec, robots.txt obeyed
          </span>
        </label>
      </div>

      <JobProgress
        stages={AUDIT_STAGES}
        current={running ? stage : null}
        startedAt={running ? startedAt : null}
        slowAfterMs={60_000}
        note="PageSpeed is a real Lighthouse run on Google's hardware, and the two screenshots are two more page loads — a minute is normal."
      />

      {/*
        A failed audit now says what happened. It used to render the word
        "failed" in the header line and nothing else, which told the operator
        neither whether to retry nor whether the prospect's site is the
        problem.
      */}
      {view?.status === "error" && (
        <div
          data-testid="audit-error"
          className="mb-4 rounded-card border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-4 py-3"
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#FFB3C2]">
            Audit failed
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[#FFD7DF]">
            {view.errorMessage ??
              "The audit stopped before it finished, and did not record a reason."}
          </p>
          <button
            onClick={run}
            className="mt-2.5 rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-panel-2"
          >
            Try again
          </button>
        </div>
      )}

      {/*
        We stopped asking; the worker may well still be going. Say exactly
        that — the old code just stopped polling, leaving a spinner that would
        turn until the tab was closed.
      */}
      {gaveUp && view?.status !== "done" && view?.status !== "error" && (
        <div
          data-testid="audit-gave-up"
          className="mb-4 rounded-card border border-[rgba(245,184,65,0.35)] bg-[rgba(245,184,65,0.1)] px-4 py-3"
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-warn">
            Still running
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[#F5D9A0]">
            This audit has been going for several minutes, so the page has
            stopped checking. It runs in the background — reload in a minute, or
            keep watching.
          </p>
          <button
            onClick={() => {
              setGaveUp(false);
              setStartedAt(Date.now());
              // Re-mount the poll effect by re-setting the same id.
              const id = auditId;
              setAuditId(null);
              setTimeout(() => setAuditId(id), 0);
            }}
            className="mt-2.5 rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-panel-2"
          >
            Keep checking
          </button>
        </div>
      )}

      {share && (
        <div className="mb-4 rounded-card border border-accent-soft bg-accent-soft px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent-ink">
            Public share link · unlisted · expires {share.expiresAt.slice(0, 10)}
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              readOnly
              value={share.url}
              className="flex-1 rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[12px] text-ink"
            />
            <a
              href={share.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2"
            >
              Open
            </a>
          </div>
          <p className="mt-1.5 text-[11px] text-muted">
            Opens are tracked to the lead timeline.
          </p>
        </div>
      )}

      {/*
        A failed run has no report. It used to render the whole panel — a big
        gradient score, a verdict chip, a check list — over a probe that never
        completed, which reads as a finding rather than as a failure.
      */}
      {view && view.status !== "error" && (
        <div className="grid grid-cols-1 items-start gap-[18px] lg:grid-cols-[220px_1fr]">
          {/* score panel */}
          <div className="rounded-card border border-line bg-panel p-[18px] text-center">
            <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              Opportunity score
            </div>
            <div className="bg-grad bg-clip-text font-display text-[64px] font-extrabold leading-none tracking-[-0.03em] text-transparent">
              {view.status === "queued" ? "…" : view.score}
            </div>
            <div className="my-3">
              <VerdictChip verdict={view.verdict} />
            </div>
            <p className="text-[11.5px] leading-relaxed text-muted">
              High score = weak site, strong sales opportunity. Thresholds set in
              Settings, not by AI.
            </p>
            {view.status === "done" && (
              <>
                <button
                  onClick={async () => {
                    const res = await createLeadFromAudit(view.id);
                    setAdded(res.ok ? "added" : "duplicate");
                  }}
                  disabled={added !== null}
                  className="mt-3.5 w-full rounded-[10px] border-[1.5px] border-transparent bg-canvas px-3 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
                >
                  {added === "added"
                    ? "Lead created ✓"
                    : added === "duplicate"
                      ? "Already a lead"
                      : "Create lead with signals"}
                </button>
                {pdf === "generating" ? (
                  <button
                    disabled
                    className="mt-2 w-full rounded-[10px] border border-line bg-panel px-3 py-2 text-[13px] text-muted"
                  >
                    Generating PDF…
                  </button>
                ) : pdf !== "idle" ? (
                  <a
                    href={`/api/files/${pdf}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 block w-full rounded-[10px] border border-line bg-panel px-3 py-2 text-center text-[13px] font-semibold text-ink hover:bg-panel-2"
                  >
                    Download branded PDF
                  </a>
                ) : (
                  <button
                    onClick={exportPdf}
                    className="mt-2 w-full rounded-[10px] border border-line bg-panel px-3 py-2 text-[13px] font-semibold text-ink hover:bg-panel-2"
                  >
                    Export branded PDF
                  </button>
                )}
                {/*
                  The priority matrix already decides what to do first; this
                  carries that decision into work instead of leaving it as a
                  chart somebody re-types by hand.
                */}
                {plan ? (
                  <a
                    href={`/tasks?board=${plan.boardId}`}
                    data-testid="open-audit-plan"
                    className="mt-2 block w-full rounded-[10px] border border-accent bg-accent-soft px-3 py-2 text-center text-[13px] font-semibold text-[#E4D3FF]"
                  >
                    Open the plan · {plan.tasks} tasks
                  </a>
                ) : (
                  <button
                    onClick={async () => {
                      setPlanning(true);
                      setError(null);
                      try {
                        const res = await createBoardFromAudit(view.id);
                        if (res.ok) setPlan({ boardId: res.boardId, tasks: res.tasks });
                        else setError(res.error);
                      } catch (e) {
                        setError(serverActionError(e));
                      } finally {
                        setPlanning(false);
                      }
                    }}
                    disabled={planning}
                    data-testid="make-audit-plan"
                    className="mt-2 w-full rounded-[10px] border border-line bg-panel px-3 py-2 text-[13px] font-semibold text-ink hover:bg-panel-2 disabled:opacity-60"
                  >
                    {planning ? "Building…" : "Make a plan from this"}
                  </button>
                )}
                <button
                  onClick={publish}
                  disabled={sharing}
                  className="mt-2 w-full rounded-[10px] border border-line bg-panel px-3 py-2 text-[13px] font-semibold text-ink hover:bg-panel-2 disabled:opacity-60"
                >
                  {sharing ? "Publishing…" : "Publish share link"}
                </button>
              </>
            )}
          </div>

          {/* details */}
          <div>
            <div className="rounded-card border border-line bg-panel p-[18px]">
              <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                {view.url} ·{" "}
                {running ? "auditing…" : "cached 30 days"}
              </div>
              {view.checks.length === 0 ? (
                <p className="text-[12.5px] text-muted">Running deterministic checks…</p>
              ) : (
                <div className="grid grid-cols-1 gap-x-[18px] gap-y-1.5 sm:grid-cols-2">
                  {view.checks.map((c) => (
                    <div
                      key={c.key}
                      className="flex items-center gap-2.5 py-1.5 text-[12.5px] text-[#C9CEE3]"
                    >
                      <span
                        className={`grid h-[17px] w-[17px] flex-none place-items-center rounded-full text-[10px] ${
                          c.pass
                            ? "bg-[rgba(61,220,151,0.15)] text-[#3DDC97]"
                            : "bg-[rgba(255,92,122,0.15)] text-[#FF5C7A]"
                        }`}
                      >
                        {c.pass ? "✓" : "✗"}
                      </span>
                      {c.label}
                      {c.detail ? <span className="text-muted">· {c.detail}</span> : null}
                    </div>
                  ))}
                </div>
              )}

              {view.flags.length > 0 && (
                <div className="mt-3.5">
                  {view.flags.map((f) => (
                    <span
                      key={f}
                      className="mr-1 mb-1 inline-flex items-center rounded-full border-[1.5px] border-transparent bg-grad px-2.5 py-0.5 text-[11px] font-semibold text-ink"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              )}

              {/*
                The captures are real PNGs on the files volume; show them
                rather than a "✓" placeholder. /api/files checks the session
                and the owning workspace before serving, so these only load
                for someone entitled to see them. Clicking opens the full
                capture — the thumbnail is cropped to the top of the page.
              */}
              <div className="mt-3.5 grid grid-cols-2 gap-2.5">
                {(["desktop", "mobile"] as const).map((k) => {
                  const shot = view.screenshots[k];
                  return (
                    <div key={k}>
                      {shot ? (
                        <a
                          href={`/api/files/${shot}`}
                          target="_blank"
                          rel="noreferrer"
                          className="block overflow-hidden rounded-[10px] border border-line bg-panel-2 hover:border-accent"
                          title={`Open the full ${k} capture`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element --
                              next/image cannot help here: these are
                              session-authenticated blobs behind /api/files, not
                              optimisable static assets, and the loader would
                              strip the cookie. */}
                          <img
                            src={`/api/files/${shot}`}
                            alt={`${k} screenshot`}
                            loading="lazy"
                            className="h-[110px] w-full object-cover object-top"
                          />
                        </a>
                      ) : (
                        <div className="grid h-[110px] place-items-center rounded-[10px] border border-line bg-panel-2 text-[11px] text-muted">
                          no {k} capture
                        </div>
                      )}
                      <div className="mt-1 text-center text-[10.5px] text-muted">{k}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {view.status === "done" && (
              <FieldData
                crux={view.crux}
                lang="en"
                labDetail={
                  view.checks.find((c) => c.key === "psiPerformance")?.detail ?? null
                }
              />
            )}

            <TrendStrip delta={view.delta} />

            {/* Renders itself away when there is no previous run to compare
                against, so it costs nothing on a first audit. */}
            {view.status === "done" && <ScreenshotCompare auditId={view.id} />}

            {view.status === "done" && <PriorityMatrixPanel auditId={view.id} />}

            {view.status === "done" && <ComparisonPanel auditId={view.id} />}

            {view.crawl && <SiteStructure crawl={view.crawl} />}

            {view.pitchSummary && (
              <div className="mt-3.5 rounded-card border-[1.5px] border-transparent bg-[linear-gradient(rgba(4,8,34,0.92),rgba(4,8,34,0.92))_padding-box,linear-gradient(135deg,#310B59,#7427C6)_border-box] p-[18px] shadow-glow-lg">
                <div className="mb-2 flex items-center gap-2">
                  <div className="grid h-[22px] w-[22px] place-items-center rounded-[7px] bg-grad text-[12px]">
                    ✦
                  </div>
                  <b className="text-[13px]">Pitch angle</b>
                  <span className="ml-auto text-[11px] text-muted">1 Haiku call</span>
                </div>
                <p className="text-[12.5px] leading-relaxed text-[#D8DCEF]">
                  {view.pitchSummary}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
