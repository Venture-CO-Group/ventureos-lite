"use client";
import { attemptVoid } from "@/lib/client/server-action";
import { serverActionError } from "@/lib/client/server-action";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { WorkspaceBrand } from "@/modules/workspaces/brand";
import { BrandMark } from "./brand-mark";
import {
  computeLineTotal,
  computeQuoteTotals,
  formatHuf,
  PRESETS,
  type PresetKey,
} from "@/modules/documents/quote-math";
import {
  createQuote,
  getQuote,
  exportQuotePdf,
  markFinal,
  type QuoteClient,
  type QuoteView,
} from "@/modules/documents/actions";

interface Row {
  description: string;
  baseNet: string;
  preset: PresetKey;
}

const PRESET_KEYS: PresetKey[] = ["none", "passthrough", "production"];

const CTA =
  "rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60";
const GHOST = "rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] font-semibold text-ink hover:bg-panel-2 disabled:opacity-60";

export function QuoteBuilder({
  clients,
  canCreate,
  isOwner,
  brand,
}: {
  clients: QuoteClient[];
  canCreate: boolean;
  isOwner: boolean;
  /** The workspace's own letterhead — the preview has to match the PDF. */
  brand: WorkspaceBrand;
}) {
  const [leadId, setLeadId] = useState(clients[0]?.leadId ?? "");
  const [rows, setRows] = useState<Row[]>([
    { description: "Website development (10 pages, HU/EN)", baseNet: "1400000", preset: "production" },
    { description: "SEO technical setup", baseNet: "220000", preset: "production" },
    { description: "Hosting & photo (pass-through)", baseNet: "180000", preset: "passthrough" },
  ]);
  const [vatRatePct, setVatRatePct] = useState(27);
  const [validUntil, setValidUntil] = useState("");
  const [doc, setDoc] = useState<QuoteView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const items = useMemo(
    () =>
      rows.map((r) => ({
        description: r.description,
        baseNet: Math.max(0, Math.round(Number(r.baseNet) || 0)),
        preset: r.preset,
      })),
    [rows],
  );
  const totals = useMemo(() => computeQuoteTotals(items, vatRatePct), [items, vatRatePct]);

  function setRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function generate() {
    if (!leadId) return;
    setBusy("gen");
    setMsg(null);
    try {
      const { documentId } = await createQuote({ leadId, items, vatRatePct, validUntil });
      setDoc(await getQuote(documentId));
    } catch (e) {
      setMsg(serverActionError(e));
    } finally {
      setBusy(null);
    }
  }

  async function exportPdf() {
    if (!doc) return;
    setBusy("pdf");
    const failed = await attemptVoid(exportQuotePdf(doc.id));
    if (failed) {
      setBusy(null);
      setMsg(failed);
      return;
    }
    const started = Date.now();
    while (Date.now() - started < 30_000) {
      await new Promise((r) => setTimeout(r, 1500));
      const v = await getQuote(doc.id);
      if (v?.pdfUrl) {
        setDoc(v);
        break;
      }
    }
    setBusy(null);
  }

  async function finalize() {
    if (!doc) return;
    setBusy("final");
    setMsg(null);
    const res = await markFinal(doc.id);
    if (!res.ok) setMsg(res.error);
    else setDoc(await getQuote(doc.id));
    setBusy(null);
  }

  return (
    <div className="max-w-[1400px]">
      {!canCreate && (
        <div className="mb-4 flex items-center gap-2.5 rounded-[11px] border border-[rgba(116,39,198,0.4)] bg-accent-soft px-3.5 py-3 text-[12.5px] text-[#E4D3FF]">
          🔒 <span><b>Owner access.</b> Quotes are managed by the workspace owner. Ask for the documents.quote.create grant in Settings.</span>
        </div>
      )}
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-display text-2xl font-bold lowercase tracking-display">quotes</h2>
        <Link href="/templates" className={`${GHOST} ml-auto`}>
          Templates
        </Link>
      </div>
      {msg && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3.5 py-2.5 text-[12.5px] text-[#FFB3C2]">
          {msg}
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-[18px] lg:grid-cols-[1.2fr_1fr]">
        {/* builder */}
        <div className="rounded-card border border-line bg-panel p-[18px]">
          <div className="mb-3 flex flex-wrap gap-2.5">
            <select
              value={leadId}
              onChange={(e) => setLeadId(e.target.value)}
              disabled={!canCreate}
              className="min-w-[200px] flex-1 rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-60"
            >
              {clients.length === 0 && <option value="">No clients in pipeline</option>}
              {clients.map((c) => (
                <option key={c.leadId} value={c.leadId}>
                  {c.company} — {c.name}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              disabled={!canCreate}
              className="rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-60"
            />
          </div>

          <div className="grid grid-cols-[1fr_110px_auto_100px_28px] items-center gap-2 border-b border-line pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted">
            <span>Item</span>
            <span>Net (Ft)</span>
            <span>Preset</span>
            <span className="text-right">Line</span>
            <span />
          </div>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_110px_auto_100px_28px] items-center gap-2 border-b border-line py-2">
              <input
                value={r.description}
                onChange={(e) => setRow(i, { description: e.target.value })}
                disabled={!canCreate}
                className="rounded-[7px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
              />
              <input
                value={r.baseNet}
                onChange={(e) => setRow(i, { baseNet: e.target.value.replace(/[^\d]/g, "") })}
                inputMode="numeric"
                disabled={!canCreate}
                className="rounded-[7px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-right text-[12px] tabular-nums text-ink outline-none focus:border-accent"
              />
              <div className="flex gap-1">
                {PRESET_KEYS.map((p) => (
                  <button
                    key={p}
                    onClick={() => setRow(i, { preset: p })}
                    disabled={!canCreate}
                    title={PRESETS[p].label}
                    className={`rounded-full border px-2 py-0.5 text-[10px] ${
                      r.preset === p
                        ? "border-accent-soft bg-accent-soft text-accent-ink"
                        : "border-line text-muted"
                    }`}
                  >
                    {p === "none" ? "—" : p === "passthrough" ? "+15%" : "+30%"}
                  </button>
                ))}
              </div>
              <b className="text-right text-[12px] tabular-nums">
                {formatHuf(computeLineTotal(items[i].baseNet, r.preset))}
              </b>
              <button
                aria-label="Remove this line"
                onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}
                disabled={!canCreate || rows.length === 1}
                className="text-muted hover:text-ink disabled:opacity-40"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            onClick={() => setRows((rs) => [...rs, { description: "", baseNet: "0", preset: "none" }])}
            disabled={!canCreate}
            className="mt-2 text-[12px] text-accent-ink hover:underline disabled:opacity-40"
          >
            + Add line
          </button>

          <div className="mt-3 flex items-center gap-3 border-t border-line pt-3">
            <label className="text-[12px] text-muted">
              VAT %{" "}
              <input
                type="number"
                value={vatRatePct}
                onChange={(e) => setVatRatePct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                disabled={!canCreate}
                className="ml-1 w-16 rounded-[7px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
              />
            </label>
            <span className="ml-auto text-[13px] text-muted">Total net</span>
            <b className="font-display text-xl tabular-nums">{formatHuf(totals.net)}</b>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={generate} disabled={!canCreate || busy === "gen" || !leadId} className={CTA}>
              {busy === "gen" ? "Generating…" : "Generate quote"}
            </button>
            {doc && (
              <>
                {doc.pdfUrl ? (
                  <a href={`/api/files/${doc.pdfUrl}`} target="_blank" rel="noreferrer" className={GHOST}>
                    Download PDF
                  </a>
                ) : (
                  <button onClick={exportPdf} disabled={busy === "pdf"} className={GHOST}>
                    {busy === "pdf" ? "Rendering…" : "Export PDF"}
                  </button>
                )}
                {doc.watermark && isOwner && (
                  <button onClick={finalize} disabled={busy === "final"} className={GHOST}>
                    {busy === "final" ? "Finalizing…" : "Mark final"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* preview with DRAFT watermark */}
        <div className="relative min-h-[340px] overflow-hidden rounded-[12px] border border-line bg-[#0A0F2E] p-7">
          <div className="relative z-10">
            <BrandMark brand={brand} className="font-display text-[15px] font-extrabold" />
            <div className="mb-4 text-[10.5px] text-muted">
              ÁRAJÁNLAT {doc ? `· ${doc.quoteNumber}` : ""}
              {clients.find((c) => c.leadId === leadId)?.company
                ? ` · ${clients.find((c) => c.leadId === leadId)?.company}`
                : ""}
            </div>
            {items.map((it, i) => (
              <div key={i} className="flex justify-between border-b border-line py-1.5 text-[11.5px] text-[#C9CEE3]">
                <span>{it.description || "—"}</span>
                <span className="tabular-nums">{formatHuf(computeLineTotal(it.baseNet, it.preset))}</span>
              </div>
            ))}
            <div className="flex justify-between py-2 text-[12px]">
              <b>Összesen (nettó)</b>
              <b className="tabular-nums">{formatHuf(totals.net)}</b>
            </div>
            <div className="flex justify-between text-[11px] text-muted">
              <span>ÁFA {vatRatePct}%</span>
              <span className="tabular-nums">{formatHuf(totals.vat)}</span>
            </div>
            <div className="flex justify-between text-[12px]">
              <b>Bruttó</b>
              <b className="tabular-nums">{formatHuf(totals.gross)}</b>
            </div>
            <p className="mt-4 text-[9.5px] text-muted">
              {doc && !doc.watermark
                ? "Véglegesítve — jogilag átnézve."
                : "Ez a dokumentum tervezet — véglegesítés előtt jogi átnézés javasolt."}
            </p>
          </div>
          {(!doc || doc.watermark) && (
            <div className="pointer-events-none absolute inset-0 z-0 grid place-items-center">
              <span className="rotate-[-24deg] font-display text-[70px] font-extrabold tracking-[0.1em] text-[rgba(239,241,248,0.05)]">
                DRAFT
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
