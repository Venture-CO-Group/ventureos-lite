"use client";

import { useState } from "react";
import { prepareInvoice, submitInvoice, type InvoicePreview } from "@/modules/invoicing/actions";

const BTN = "rounded-[8px] border border-line bg-panel px-2.5 py-1 text-[11.5px] hover:bg-panel-2 disabled:opacity-60";

function huf(n: number): string {
  return `${n.toLocaleString("hu-HU")} Ft`;
}

export function InvoiceButton({ certificateId }: { certificateId: string }) {
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function prepare() {
    setBusy(true);
    setError(null);
    const res = await prepareInvoice(certificateId);
    setBusy(false);
    if (res.ok) setPreview(res.preview);
    else setError(res.error);
  }

  async function submit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    const res = await submitInvoice({ certificateId, confirmedHash: preview.confirmationHash });
    setBusy(false);
    if (res.ok) {
      setDone(res.invoiceNumber ?? "issued");
      setPreview(null);
    } else {
      setError(res.error);
    }
  }

  if (done) {
    return <span className="rounded-full bg-[rgba(61,220,151,0.12)] px-2 py-0.5 text-[10.5px] font-semibold text-[#3DDC97]">invoiced · {done}</span>;
  }

  return (
    <>
      <button onClick={prepare} disabled={busy} className={BTN}>
        {busy && !preview ? "…" : "Prepare invoice"}
      </button>

      {preview && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={() => setPreview(null)}>
          <div onClick={(e) => e.stopPropagation()} className="max-h-[85vh] w-full max-w-[560px] overflow-auto rounded-card border border-line bg-[rgba(6,11,38,0.98)] p-5 backdrop-blur">
            <div className="mb-1 flex items-center gap-2">
              <b className="text-[14px]">Confirm invoice — Számlázz.hu</b>
              <button aria-label="Close" onClick={() => setPreview(null)} className="ml-auto text-muted hover:text-ink">✕</button>
            </div>
            <p className="mb-3 text-[11.5px] text-muted">
              This is exactly what will be submitted. Nothing is sent until you confirm.
            </p>
            {error && <p className="mb-2 text-[12px] text-[#FFB3C2]">{error}</p>}

            <div className="mb-3 rounded-[10px] border border-line bg-panel-2 p-3 text-[12.5px]">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Partner</div>
              <div>{preview.payload.buyer.name}</div>
              <div className="text-muted">
                {preview.payload.buyer.taxId || "no tax id"} · {preview.payload.buyer.postalCode} {preview.payload.buyer.city}, {preview.payload.buyer.address}
              </div>
            </div>

            <table className="mb-2 w-full text-[12px]">
              <thead>
                <tr className="text-muted">
                  <th className="py-1 text-left font-medium">Item</th>
                  <th className="py-1 text-right font-medium">Net</th>
                  <th className="py-1 text-right font-medium">VAT</th>
                  <th className="py-1 text-right font-medium">Gross</th>
                </tr>
              </thead>
              <tbody>
                {preview.payload.lines.map((l, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="py-1.5">{l.name}</td>
                    <td className="py-1.5 text-right tabular-nums">{huf(l.netValue)}</td>
                    <td className="py-1.5 text-right tabular-nums text-muted">{huf(l.vatValue)} · {l.vatRate}%</td>
                    <td className="py-1.5 text-right tabular-nums">{huf(l.grossValue)}</td>
                  </tr>
                ))}
                <tr className="border-t border-line font-semibold">
                  <td className="py-1.5">Total</td>
                  <td className="py-1.5 text-right tabular-nums">{huf(preview.payload.totals.net)}</td>
                  <td className="py-1.5 text-right tabular-nums">{huf(preview.payload.totals.vat)}</td>
                  <td className="py-1.5 text-right tabular-nums">{huf(preview.payload.totals.gross)}</td>
                </tr>
              </tbody>
            </table>
            <p className="mb-3 text-[11px] text-muted">
              Due {preview.payload.header.dueDate} · {preview.payload.header.paymentMethod} · {preview.payload.header.currency}
              {preview.quoteNumber ? ` · from ${preview.quoteNumber}` : ""}
            </p>

            {!preview.hasAgentKey && (
              <p className="mb-2 text-[12px] text-warn">No Számla Agent key set — add it in Settings before submitting.</p>
            )}

            <div className="flex justify-end gap-2">
              <button onClick={() => setPreview(null)} className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2">Cancel</button>
              <button onClick={submit} disabled={busy || !preview.hasAgentKey} className="rounded-[10px] border border-accent bg-accent-soft px-4 py-2 text-[13px] font-semibold text-[#E4D3FF] disabled:opacity-60">
                {busy ? "Submitting…" : "Confirm & submit"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
