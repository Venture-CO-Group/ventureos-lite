"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { approveProposal, rejectProposal, type ProposalView } from "@/modules/signal/actions";

const KIND_LABEL: Record<string, string> = {
  FRAME_PROMOTION: "Frame promotion",
  SCORE_WEIGHT: "Score weight",
  STAGE_PROBABILITY: "Stage probability",
  FRAGMENT_RETIREMENT: "Retire a name fragment",
};

const STATUS_CHIP: Record<string, string> = {
  PENDING: "bg-accent-soft text-accent-ink",
  APPROVED: "bg-[rgba(61,220,151,0.12)] text-[#3DDC97]",
  REJECTED: "bg-panel text-muted",
};

export function ProposalQueue({
  proposals,
  isOwner,
}: {
  proposals: ProposalView[];
  isOwner: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    setError(null);
    const res = approve ? await approveProposal(id) : await rejectProposal(id);
    setBusy(null);
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  const pending = proposals.filter((p) => p.status === "PENDING");
  const decided = proposals.filter((p) => p.status !== "PENDING");

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-1 flex items-baseline gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Signal Engine · approval queue
        </div>
        <span className="ml-auto text-[11px] text-muted">{pending.length} pending</span>
      </div>
      <p className="mb-3 text-[11.5px] text-muted">
        Weekly proposals backed by n≥20. Approval versions the frame library or updates score
        weights — nothing self-modifies.
      </p>

      {error && <p className="mb-2 text-[12px] text-[#FFB3C2]">{error}</p>}

      {pending.length === 0 && (
        <p className="text-[12.5px] text-muted">No pending proposals.</p>
      )}

      {pending.map((p) => (
        <div key={p.id} data-proposal={p.id} className="mb-2 rounded-[11px] border border-line bg-panel-2 p-3.5">
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded-full bg-panel px-2 py-0.5 text-[10px] font-semibold text-muted">
              {KIND_LABEL[p.kind] ?? p.kind}
            </span>
            <b className="text-[13px]">{p.title}</b>
            <span className="ml-auto text-[11px] text-muted">n={p.n}</span>
          </div>
          <p className="mb-2.5 text-[12px] leading-relaxed text-[#C9CEE3]">{p.evidence}</p>
          {isOwner ? (
            <div className="flex gap-2">
              <button
                data-testid="approve"
                onClick={() => decide(p.id, true)}
                disabled={busy === p.id}
                className="rounded-[9px] border border-accent bg-accent-soft px-3 py-1.5 text-[12px] font-semibold text-[#E4D3FF] disabled:opacity-60"
              >
                Approve
              </button>
              <button
                data-testid="reject"
                onClick={() => decide(p.id, false)}
                disabled={busy === p.id}
                className="rounded-[9px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2 disabled:opacity-60"
              >
                Reject
              </button>
            </div>
          ) : (
            <p className="text-[11px] text-muted">Owner approval required.</p>
          )}
        </div>
      ))}

      {decided.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Decided
          </div>
          {decided.slice(0, 10).map((p) => (
            <div key={p.id} className="flex items-center gap-2 py-1 text-[12px]">
              <span className="text-[#C9CEE3]">{p.title}</span>
              <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_CHIP[p.status]}`}>
                {p.status.toLowerCase()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
