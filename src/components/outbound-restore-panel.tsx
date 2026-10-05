"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import { previewRestoreAction, restoreAction } from "@/modules/outbound/history-actions";
import type { RestorePreview } from "@/modules/outbound/restore";

/**
 * Restore one candidate (tracking & recovery). The preview runs first and
 * says what blocks it today and how it would come back — requeued as it was,
 * or regenerated when the draft is older than 30 days. The button only
 * exists when nothing blocks.
 */
export function OutboundRestorePanel({ candidateId }: { candidateId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    void attempt(previewRestoreAction(candidateId)).then((r) => {
      if (live && r.ok) setPreview(r.preview);
    });
    return () => {
      live = false;
    };
  }, [candidateId]);

  if (!preview) return <p className="text-[12px] text-muted">Checking whether this can be restored…</p>;

  function restore() {
    startTransition(async () => {
      const res = await attempt(restoreAction({ candidateId, note: note || null }));
      if (!res.ok) {
        setMessage(res.error);
        return;
      }
      if (res.result.ok) {
        setMessage(
          res.result.state === "PENDING_APPROVAL"
            ? "Back in the approval queue, flagged as restored."
            : `Restored; it is now ${res.result.state.toLowerCase().replace(/_/g, " ")}.`,
        );
        setBlockers([]);
        router.refresh();
      } else {
        setBlockers(res.result.blockers);
      }
    });
  }

  const label = preview.mode === "regenerate" ? "Restore and regenerate the draft" : preview.mode === "redraft" ? "Restore and draft" : "Restore to the queue";

  return (
    <section className="grid gap-2 rounded-card border border-line bg-panel p-[18px]" data-testid="restore-panel">
      <h3 className="font-display text-[16px] font-bold lowercase">restore</h3>
      {[...preview.blockers, ...blockers].map((b) => (
        <p key={b} className="text-[12.5px] text-[#FFD27A]">{b}</p>
      ))}
      {preview.notes.map((n) => (
        <p key={n} className="text-[12px] text-muted">{n}</p>
      ))}
      {preview.restorable && (
        <>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why (optional — goes in the audit log)"
            className="min-h-[40px] rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[12.5px] text-ink outline-none focus:border-accent"
          />
          <button
            type="button"
            disabled={pending}
            onClick={restore}
            data-testid="restore-button"
            className="min-h-[44px] justify-self-start rounded-[9px] border border-accent px-3.5 py-2 text-[12.5px] font-semibold text-ink disabled:opacity-45"
          >
            {pending ? "Restoring…" : label}
          </button>
        </>
      )}
      {message && <p className="text-[12px] text-muted">{message}</p>}
    </section>
  );
}
