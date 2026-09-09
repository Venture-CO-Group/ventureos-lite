"use client";
import { attemptVoid } from "@/lib/client/server-action";
import { serverActionError } from "@/lib/client/server-action";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DocumentStatus, DocumentType } from "@prisma/client";
import { buildChainStepper } from "@/modules/documents/chain";
import {
  advanceStatus,
  createContractFromQuote,
  createCertificateFromContract,
  exportQuotePdf,
  markFinal,
  getContractPrefill,
  draftScopeParagraph,
  getChain,
  type ChainSummary,
  type ChainDocView,
} from "@/modules/documents/actions";
import { getComposerData, sendDocument } from "@/modules/mail/actions";
import { publishQuoteAcceptance } from "@/modules/documents/acceptance";
import { InvoiceButton } from "./invoice-button";
import { EmptyState } from "./empty-state";

const TYPE_LABEL: Record<DocumentType, string> = {
  QUOTE: "Quote",
  CONTRACT: "Contract",
  CERTIFICATE: "Certificate",
};

function nextStatus(type: DocumentType, status: DocumentStatus): { to: DocumentStatus; label: string } | null {
  const map: Record<string, { to: DocumentStatus; label: string }> = {
    "QUOTE:DRAFT": { to: "SENT", label: "Mark sent" },
    "QUOTE:SENT": { to: "ACCEPTED", label: "Mark accepted" },
    "CONTRACT:DRAFT": { to: "SENT", label: "Mark sent" },
    "CONTRACT:SENT": { to: "SIGNED", label: "Mark signed" },
    "CERTIFICATE:DRAFT": { to: "SENT", label: "Mark sent" },
    "CERTIFICATE:SENT": { to: "ACKNOWLEDGED", label: "Mark acknowledged" },
  };
  return map[`${type}:${status}`] ?? null;
}

export function ChainStepper({ docs }: { docs: ChainDocView[] }) {
  const steps = buildChainStepper(docs.map((d) => ({ type: d.type, status: d.status })));
  return (
    <div className="flex items-center gap-1.5">
      {steps.map((s, i) => (
        <div key={s.type} className="flex items-center gap-1.5">
          <div
            className={`grid h-[22px] w-[22px] place-items-center rounded-full text-[10px] ${
              s.present ? "bg-grad text-ink" : "border border-line bg-panel-2 text-muted"
            } ${s.active ? "ring-2 ring-accent" : ""}`}
            title={s.status ?? "not created"}
          >
            {i + 1}
          </div>
          <span className={`text-[11px] ${s.present ? "text-ink" : "text-muted"}`}>
            {TYPE_LABEL[s.type]}
            {s.status ? (
              <span className="ml-1 text-muted">{s.status.toLowerCase()}</span>
            ) : null}
          </span>
          {i < steps.length - 1 && <span className="mx-1 h-px w-4 bg-line" />}
        </div>
      ))}
    </div>
  );
}

const BTN = "rounded-[9px] border border-line bg-panel px-2.5 py-1 text-[11.5px] hover:bg-panel-2 disabled:opacity-60";

export function DocumentChains({
  chains,
  isOwner,
}: {
  chains: ChainSummary[];
  isOwner: boolean;
}) {
  const router = useRouter();
  const refresh = () => router.refresh();

  if (chains.length === 0) {
    return (
      <div className="mt-4">
        <EmptyState title="no documents yet" testId="documents-empty">
          A quote becomes a contract becomes a completion certificate, each one rendered
          from a versioned template and carrying a DRAFT watermark until an Owner
          finalises it. Start with a quote above.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <h3 className="mb-3 font-display text-lg font-bold lowercase">document chains</h3>
      <div className="grid gap-3">
        {chains.map((c) => (
          <ChainCard key={c.rootId} chain={c} isOwner={isOwner} onChanged={refresh} />
        ))}
      </div>
    </div>
  );
}

function ChainCard({
  chain,
  isOwner,
  onChanged,
}: {
  chain: ChainSummary;
  isOwner: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contractFor, setContractFor] = useState<string | null>(null);
  const [certFor, setCertFor] = useState<string | null>(null);
  const [sendFor, setSendFor] = useState<string | null>(null);
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);

  const quote = chain.docs.find((d) => d.type === "QUOTE");
  const contract = chain.docs.find((d) => d.type === "CONTRACT");
  const certificate = chain.docs.find((d) => d.type === "CERTIFICATE");

  async function advance(id: string, to: DocumentStatus) {
    setBusy(id);
    setError(null);
    const res = await advanceStatus(id, to);
    if (!res.ok) setError(res.error);
    else onChanged();
    setBusy(null);
  }
  async function exportPdf(id: string) {
    setBusy(id);
    // Without this, a failed render span thirty seconds of polling for a file
    // that was never going to appear, then stopped, saying nothing.
    const failed = await attemptVoid(exportQuotePdf(id));
    if (failed) {
      setBusy(null);
      setError(failed);
      return;
    }
    const started = Date.now();
    while (Date.now() - started < 30_000) {
      await new Promise((r) => setTimeout(r, 1500));
      const fresh = await getChain(id);
      if (fresh.find((d) => d.id === id)?.pdfUrl) break;
    }
    setBusy(null);
    onChanged();
  }
  async function finalize(id: string) {
    setBusy(id);
    setError(null);
    const res = await markFinal(id);
    if (!res.ok) setError(res.error);
    else onChanged();
    setBusy(null);
  }

  function docRow(d: ChainDocView) {
    const ns = nextStatus(d.type, d.status);
    return (
      <div key={d.id} className="flex flex-wrap items-center gap-2 border-t border-line py-2 text-[12px] first:border-t-0">
        <b>{TYPE_LABEL[d.type]}</b>
        <span className="text-muted">{d.number}</span>
        <span className="rounded-full bg-panel-2 px-2 py-0.5 text-[10.5px] text-muted">{d.status.toLowerCase()}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {ns && (
            <button onClick={() => advance(d.id, ns.to)} disabled={busy === d.id} className={BTN}>
              {ns.label}
            </button>
          )}
          {d.pdfUrl ? (
            <a href={`/api/files/${d.pdfUrl}`} target="_blank" rel="noreferrer" className={BTN}>
              Download PDF
            </a>
          ) : (
            <button onClick={() => exportPdf(d.id)} disabled={busy === d.id} className={BTN}>
              {busy === d.id ? "…" : "Export PDF"}
            </button>
          )}
          {d.watermark && isOwner && (
            <button onClick={() => finalize(d.id)} disabled={busy === d.id} className={BTN}>
              Mark final
            </button>
          )}
          <button onClick={() => setSendFor(d.id)} className={BTN}>
            Send…
          </button>
          {d.type === "CERTIFICATE" && d.status === "ACKNOWLEDGED" && (
            <InvoiceButton certificateId={d.id} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <b className="text-[13px]">{chain.clientName}</b>
        <ChainStepper docs={chain.docs} />
      </div>
      {error && <p className="mb-2 text-[12px] text-[#FFB3C2]">{error}</p>}

      {chain.docs.map(docRow)}

      <div className="mt-3 flex flex-wrap gap-2">
        {quote && (quote.status === "SENT" || quote.status === "ACCEPTED") && (
          <button
            onClick={async () => setAcceptUrl((await publishQuoteAcceptance(quote.id)).url)}
            className={BTN}
          >
            Publish accept link
          </button>
        )}
        {quote?.status === "ACCEPTED" && !contract && (
          <button onClick={() => setContractFor(quote.id)} className={BTN}>
            Generate contract →
          </button>
        )}
        {contract?.status === "SIGNED" && !certificate && (
          <button onClick={() => setCertFor(contract.id)} className={BTN}>
            Generate certificate →
          </button>
        )}
      </div>
      {acceptUrl && (
        <div className="mt-2 flex items-center gap-2 rounded-[10px] border border-accent-soft bg-accent-soft px-3 py-2">
          <input readOnly value={acceptUrl} className="flex-1 bg-transparent text-[11.5px] text-ink outline-none" />
          <a href={acceptUrl} target="_blank" rel="noreferrer" className={BTN}>
            Open
          </a>
        </div>
      )}

      {contractFor && (
        <ContractModal
          quoteId={contractFor}
          onClose={() => setContractFor(null)}
          onDone={() => {
            setContractFor(null);
            onChanged();
          }}
        />
      )}
      {certFor && (
        <CertificateModal
          contractId={certFor}
          onClose={() => setCertFor(null)}
          onDone={() => {
            setCertFor(null);
            onChanged();
          }}
        />
      )}
      {sendFor && (
        <ComposerModal
          documentId={sendFor}
          onClose={() => setSendFor(null)}
          onDone={() => {
            setSendFor(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function ComposerModal({
  documentId,
  onClose,
  onDone,
}: {
  documentId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [hasPdf, setHasPdf] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (!loaded) {
    getComposerData(documentId)
      .then((d) => {
        setTo(d.to);
        setSubject(d.subject);
        setBody(d.body);
        setHasPdf(d.hasPdf);
      })
      .catch((e) => setMsg(serverActionError(e)))
      .finally(() => setLoaded(true));
  }

  async function send() {
    setBusy(true);
    setMsg(null);
    const res = await sendDocument({ documentId, to, subject, body });
    if (res.ok) onDone();
    else setMsg(res.error);
    setBusy(false);
  }

  return (
    <Modal>
      <div className="mb-3 flex items-center">
        <h3 className="font-display text-lg font-bold lowercase">send document</h3>
        <button aria-label="Close" onClick={onClose} className="ml-auto text-muted hover:text-ink">✕</button>
      </div>
      {msg && <p className="mb-2 text-[12px] text-[#FFB3C2]">{msg}</p>}
      <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Recipient email" className={`${FIELD} mb-2`} />
      <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className={`${FIELD} mb-2`} />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} className={`${FIELD} mb-2 min-h-[120px]`} />
      <p className="mb-3 text-[11.5px] text-muted">
        {hasPdf ? "Document PDF will be attached." : "No PDF yet — export it first to attach."} · Sent via Mailgun EU.
      </p>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={BTN}>Cancel</button>
        <button
          onClick={send}
          disabled={busy}
          className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </Modal>
  );
}

function Modal({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-[560px] rounded-card border border-line bg-[rgba(6,11,38,0.98)] p-5 backdrop-blur">
        {children}
      </div>
    </div>
  );
}

const FIELD =
  "w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[12.5px] text-ink outline-none focus:border-accent";

function ContractModal({
  quoteId,
  onClose,
  onDone,
}: {
  quoteId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [scope, setScope] = useState("");
  const [milestones, setMilestones] = useState("");
  const [payment, setPayment] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (!loaded) {
    getContractPrefill(quoteId)
      .then((p) => {
        setScope(p.scope);
        setMilestones(p.milestones);
        setPayment(p.payment_terms);
      })
      .catch((e) => setMsg(serverActionError(e)))
      .finally(() => setLoaded(true));
  }

  async function draft() {
    setDrafting(true);
    try {
      const { text } = await draftScopeParagraph(quoteId);
      setScope(text);
    } catch (e) {
      setMsg(serverActionError(e));
    } finally {
      setDrafting(false);
    }
  }

  async function create() {
    setBusy(true);
    setMsg(null);
    const res = await createContractFromQuote(quoteId, {
      scope,
      milestones,
      payment_terms: payment,
    });
    if (res.ok) onDone();
    else setMsg(res.error);
    setBusy(false);
  }

  return (
    <Modal>
      <div className="mb-3 flex items-center">
        <h3 className="font-display text-lg font-bold lowercase">generate contract</h3>
        <button aria-label="Close" onClick={onClose} className="ml-auto text-muted hover:text-ink">✕</button>
      </div>
      <p className="mb-2 text-[12px] text-muted">
        Pre-filled from the accepted quote + registry party data. Edit before generating.
      </p>
      {msg && <p className="mb-2 text-[12px] text-[#FFB3C2]">{msg}</p>}
      <label className="mb-1 block text-[11px] uppercase tracking-[0.1em] text-muted">Scope</label>
      <textarea value={scope} onChange={(e) => setScope(e.target.value)} className={`${FIELD} mb-1 min-h-[90px]`} />
      <button
        onClick={draft}
        disabled={drafting}
        className="mb-3 rounded-[9px] border border-accent-soft bg-panel px-3 py-1 text-[11.5px] text-accent-ink hover:bg-panel-2 disabled:opacity-60"
      >
        {drafting ? "Drafting…" : "✦ Draft scope with Claude"}
      </button>
      <label className="mb-1 block text-[11px] uppercase tracking-[0.1em] text-muted">Milestones</label>
      <input value={milestones} onChange={(e) => setMilestones(e.target.value)} className={`${FIELD} mb-2`} />
      <label className="mb-1 block text-[11px] uppercase tracking-[0.1em] text-muted">Payment terms</label>
      <input value={payment} onChange={(e) => setPayment(e.target.value)} className={`${FIELD} mb-3`} />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={BTN}>Cancel</button>
        <button
          onClick={create}
          disabled={busy}
          className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
        >
          {busy ? "Creating…" : "Create contract"}
        </button>
      </div>
    </Modal>
  );
}

function CertificateModal({
  contractId,
  onClose,
  onDone,
}: {
  contractId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [deliverables, setDeliverables] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setMsg(null);
    const res = await createCertificateFromContract(contractId, {
      deliverables: deliverables || undefined,
    });
    if (res.ok) onDone();
    else setMsg(res.error);
    setBusy(false);
  }

  return (
    <Modal>
      <div className="mb-3 flex items-center">
        <h3 className="font-display text-lg font-bold lowercase">generate certificate</h3>
        <button aria-label="Close" onClick={onClose} className="ml-auto text-muted hover:text-ink">✕</button>
      </div>
      <p className="mb-2 text-[12px] text-muted">
        Deliverables default to the contract scope — leave blank to use it as-is.
      </p>
      {msg && <p className="mb-2 text-[12px] text-[#FFB3C2]">{msg}</p>}
      <textarea
        value={deliverables}
        onChange={(e) => setDeliverables(e.target.value)}
        placeholder="Deliverables (optional)"
        className={`${FIELD} mb-3 min-h-[90px]`}
      />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={BTN}>Cancel</button>
        <button
          onClick={create}
          disabled={busy}
          className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
        >
          {busy ? "Creating…" : "Create certificate"}
        </button>
      </div>
    </Modal>
  );
}
