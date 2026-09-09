"use client";
import { attemptVoid, serverActionError } from "@/lib/client/server-action";

import { useEffect, useState } from "react";
import { overrideScore } from "@/modules/leads/actions";
import { enrichCompanyLookup, confirmEnrichment } from "@/modules/registry/actions";
import type { RegistryCandidate } from "@/modules/registry/provider";
import { companyUnderProceedings } from "@/modules/registry/risk";
import { RiskChip } from "./risk-chip";
import { Modal } from "./modal";

/**
 * The two per-lead dialogs, lifted out of `lead-engine.tsx` when the table
 * moved into its own component (playbook-v2 P3/2). Both surfaces open them, so
 * neither can own them.
 */

export function EnrichDialog({
  companyId,
  onClose,
  onDone,
}: {
  companyId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [candidates, setCandidates] = useState<RegistryCandidate[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    enrichCompanyLookup(companyId)
      .then((r) => active && setCandidates(r.candidates))
      .catch((e) => active && setMsg(serverActionError(e)));
    return () => {
      active = false;
    };
  }, [companyId]);

  async function pick(c: RegistryCandidate) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await confirmEnrichment(companyId, c);
      if (res.ok) onDone();
      else setMsg(res.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal>
      <div className="mb-3 flex items-center">
        <h3 className="font-display text-lg font-bold lowercase">registry enrichment</h3>
        <button aria-label="Close" onClick={onClose} className="ml-auto text-muted hover:text-ink">
          ✕
        </button>
      </div>
      <p className="mb-3 text-[12px] text-muted">
        Confirm the matching company. adószám becomes the dedupe key; a company
        under proceedings is flagged.
      </p>
      {msg && <p className="mb-2 text-[12px] text-[#FFB3C2]">{msg}</p>}
      {candidates === null && !msg ? (
        <p className="text-[13px] text-muted">Looking up…</p>
      ) : candidates && candidates.length === 0 ? (
        <p className="text-[13px] text-muted">No registry matches found.</p>
      ) : (
        <div className="grid gap-2">
          {candidates?.map((c) => (
            <div
              key={c.taxId}
              className="flex items-center gap-3 rounded-[10px] border border-line bg-panel p-3"
            >
              <div className="min-w-0 flex-1">
                <b className="text-[13px]">{c.legalName}</b>
                <span className="block text-[11.5px] text-muted">
                  adószám {c.taxId}
                  {c.headcountBand ? ` · ${c.headcountBand}` : ""}
                  {c.revenueBand ? ` · ${c.revenueBand}` : ""}
                </span>
                {companyUnderProceedings(c.statusFlags) && (
                  <span className="mt-1 inline-block">
                    <RiskChip label="Under proceedings" />
                  </span>
                )}
              </div>
              <button
                onClick={() => pick(c)}
                disabled={busy}
                className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2 disabled:opacity-60"
              >
                Use this
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function OverrideDialog({
  leadId,
  onClose,
  onDone,
}: {
  leadId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [score, setScore] = useState(3);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * This dialog had nowhere to report a failure, and the override is an AUDITED
   * action against the score gate — the operator has to know whether it landed.
   */
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal>
      <div className="mb-3 flex items-center">
        <h3 className="font-display text-lg font-bold lowercase">override icp score</h3>
        <button aria-label="Close" onClick={onClose} className="ml-auto text-muted hover:text-ink">
          ✕
        </button>
      </div>
      <p className="mb-2 text-[12px] text-muted">
        Overrides are recorded in the audit log with your reason.
      </p>
      <div className="mb-3 flex gap-2">
        {[0, 1, 2, 3, 4, 5].map((s) => (
          <button
            key={s}
            onClick={() => setScore(s)}
            className={`h-9 w-9 rounded-[8px] border text-[13px] font-semibold ${
              score === s
                ? "border-accent bg-accent-soft text-[#E4D3FF]"
                : "border-line bg-panel text-ink"
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (required)"
        className="mb-3 w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent"
      />
      {error && (
        <p
          role="alert"
          data-testid="override-error"
          className="mb-3 rounded-[8px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] px-3 py-2 text-[12.5px] text-[#FFB3C2]"
        >
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2"
        >
          Cancel
        </button>
        <button
          disabled={busy || !reason.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const failed = await attemptVoid(overrideScore(leadId, score, reason.trim()));
            setBusy(false);
            if (failed) {
              setError(failed);
              return;
            }
            onDone();
          }}
          className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save override"}
        </button>
      </div>
    </Modal>
  );
}
