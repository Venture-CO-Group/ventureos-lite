"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { serverActionError } from "@/lib/client/server-action";
import {
  resetAuditScoring,
  saveAuditScoring,
  type AuditScoringView,
} from "@/modules/audit/config-actions";

/**
 * What the opportunity score is made of.
 *
 * ── WHY THIS PANEL EXISTS ───────────────────────────────────────────────────
 *
 * The audit screen prints "Thresholds set in Settings, not by AI" and there
 * was no such setting: `Workspace.auditConfig` was read by the scorer and
 * written by nothing at all. Every workspace ran on the defaults and the
 * sentence on the audit page was an aspiration.
 *
 * The knob is the CATEGORY, not the individual check, because that is the
 * level people think at — "this list cares more about legal compliance than
 * about speed" — and because there are thirty-three checks and eight
 * categories.
 */
const INPUT =
  "w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent tabular-nums";

export function SettingsAuditScoring({ view }: { view: AuditScoringView }) {
  const router = useRouter();
  const [strong, setStrong] = useState(String(view.verdict.strong));
  const [possible, setPossible] = useState(String(view.verdict.possible));
  const [heavyMb, setHeavyMb] = useState(String(view.heavyPageMb));
  const [weights, setWeights] = useState<Record<string, string>>(
    Object.fromEntries(view.categories.map((c) => [c.key, String(c.weight)])),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const total = Object.values(weights).reduce((n, v) => n + (Number(v) || 0), 0);

  async function save() {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const res = await saveAuditScoring({ strong, possible, heavyPageMb: heavyMb, weights });
      if (res.ok) {
        setMsg("Saved. New audits use these numbers; audits already stored keep the scoring they were run under.");
        router.refresh();
      } else setError(res.error);
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]" id="audit-scoring">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        Audit scoring
      </div>
      <p className="mb-3 text-[11.5px] leading-relaxed text-muted">
        The opportunity score is a weighted average of how much of each
        category&apos;s checks a site FAILS — high means a weak site and
        therefore a strong sales opportunity. Weights are relative, so they do
        not have to add up to anything in particular.
      </p>

      {!view.canEdit && (
        <p className="mb-3 text-[12px] text-muted">
          Read-only — needs the <code>settings.manage</code> capability.
        </p>
      )}
      {msg && (
        <p
          data-testid="scoring-saved"
          className="mb-3 rounded-[8px] border border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] px-3 py-2 text-[12px] text-[#8CEFC0]"
        >
          {msg}
        </p>
      )}
      {error && (
        <p
          role="alert"
          data-testid="scoring-error"
          className="mb-3 rounded-[8px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3 py-2 text-[12px] text-[#FFB3C2]"
        >
          {error}
        </p>
      )}

      {/* ---- category weights ---- */}
      <div className="grid gap-1.5 sm:grid-cols-2">
        {view.categories.map((c) => (
          <label
            key={c.key}
            className="flex items-center gap-2.5 rounded-[10px] border border-line bg-panel-2 px-3 py-2"
          >
            <span className="min-w-0 flex-1">
              <b className="block text-[12.5px]">{c.label}</b>
              {c.internalOnly && (
                <span className="text-[10.5px] text-muted">
                  Only on a crawled internal audit — never moves the score, so a
                  crawled and an uncrawled run stay comparable.
                </span>
              )}
            </span>
            <input
              value={weights[c.key] ?? "0"}
              onChange={(e) => setWeights((w) => ({ ...w, [c.key]: e.target.value }))}
              disabled={!view.canEdit || busy}
              inputMode="numeric"
              data-testid={`weight-${c.key}`}
              className={`${INPUT} w-16 text-right`}
            />
          </label>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-muted">
        Total <b className="tabular-nums text-ink">{total}</b> · set a category to
        0 to leave it out of the score entirely.
      </p>

      {/* ---- verdict bands ---- */}
      <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
        <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
          Strong prospect at
          <input
            value={strong}
            onChange={(e) => setStrong(e.target.value)}
            disabled={!view.canEdit || busy}
            inputMode="numeric"
            data-testid="verdict-strong"
            className={`${INPUT} mt-1`}
          />
        </label>
        <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
          Possible at
          <input
            value={possible}
            onChange={(e) => setPossible(e.target.value)}
            disabled={!view.canEdit || busy}
            inputMode="numeric"
            data-testid="verdict-possible"
            className={`${INPUT} mt-1`}
          />
        </label>
        <label className="text-[11px] uppercase tracking-[0.1em] text-muted">
          Heavy page (MB)
          <input
            value={heavyMb}
            onChange={(e) => setHeavyMb(e.target.value)}
            disabled={!view.canEdit || busy}
            inputMode="decimal"
            data-testid="heavy-page-mb"
            className={`${INPUT} mt-1`}
          />
        </label>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        Calibrated against fourteen live Hungarian sites: professional builds
        land at 20-28, mixed ones at 36-44, genuinely weak ones at 45-50. Move
        the bands if your list sits somewhere else.
      </p>

      {view.canEdit && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={save}
            disabled={busy}
            data-testid="scoring-save"
            className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save scoring"}
          </button>
          {!view.isDefault && (
            <button
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const res = await resetAuditScoring();
                  if (res.ok) router.refresh();
                  else setError(res.error);
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
              data-testid="scoring-reset"
              className="text-[12px] text-muted underline hover:text-ink"
            >
              Back to the defaults
            </button>
          )}
          {view.isDefault && (
            <span className="text-[11.5px] text-muted">Currently on the defaults.</span>
          )}
        </div>
      )}
    </div>
  );
}
