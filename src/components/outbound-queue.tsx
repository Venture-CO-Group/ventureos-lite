"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import { approve, approveOpened, openDraft, reject, saveDraftEdit, toLinkedIn } from "@/modules/outbound/approval-actions";
import type { QueueCard } from "@/modules/outbound/queue-view";
import type { QueueStats } from "@/modules/outbound/approval";
import { highlightRanges, hookStatus, isHumanEdited } from "@/modules/outbound/draft";
import { useToast } from "./toast";

/**
 * The approval queue (spec §4.43.8) — where the motor's output meets a
 * person, and the one screen built to be used twenty times in ten minutes.
 *
 * Keyboard first: J/K move, A approves, E edits in place, X rejects (a reason
 * is required — 1–6 picks it), L sends the company to the LinkedIn queue.
 * Each card shows the message exactly as it leaves, signature and
 * unsubscribe line included, with the company-specific facts highlighted.
 */

const REASONS = [
  { value: "WRONG_TARGETING", label: "Wrong targeting" },
  { value: "WEAK_COPY", label: "Weak copy" },
  { value: "WRONG_CONTACT", label: "Wrong contact" },
  { value: "BAD_TIMING", label: "Bad timing" },
  { value: "ALREADY_IN_CONTACT", label: "Already in contact" },
  { value: "OTHER", label: "Other (say why)" },
] as const;

const BTN =
  "min-h-[44px] rounded-[9px] border border-line px-3 py-2 text-[12.5px] font-semibold text-ink hover:border-accent disabled:opacity-45";
const PRIMARY =
  "min-h-[44px] rounded-[9px] border border-accent bg-[linear-gradient(135deg,#310B59,#7427C6)] px-3.5 py-2 text-[12.5px] font-semibold text-white shadow-[0_0_18px_rgba(116,39,198,0.35)] disabled:opacity-45";
const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent";

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

export function OutboundQueue({ cards, stats }: { cards: QueueCard[]; stats: QueueStats }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<Set<string>>(() => new Set(cards.filter((c) => c.openedByMe).map((c) => c.draftId)));
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const card = cards[Math.min(index, Math.max(0, cards.length - 1))];

  // Opening a card is recorded once: it is what bulk approve is allowed to touch.
  useEffect(() => {
    if (!card || opened.has(card.draftId)) return;
    setOpened((s) => new Set(s).add(card.draftId));
    void attempt(openDraft(card.draftId));
  }, [card, opened]);

  useEffect(() => {
    setEditing(false);
    setRejecting(false);
    setNote("");
    setError(null);
    if (card) {
      setSubject(card.subject);
      setBody(card.body);
    }
  }, [card?.draftId]); // eslint-disable-line react-hooks/exhaustive-deps

  const after = useCallback(
    (res: { ok: boolean; error?: string }) => {
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      setError(null);
      router.refresh();
    },
    [router],
  );

  const doApprove = useCallback(() => {
    if (!card) return;
    startTransition(async () => after(await attempt(approve({ draftId: card.draftId, subject, body }))));
  }, [card, subject, body, after]);

  const doReject = useCallback(
    (reason: string) => {
      if (!card) return;
      if (reason === "OTHER" && !note.trim()) {
        setError("Say why, in a few words, then pick Other again.");
        return;
      }
      startTransition(async () => {
        const res = await attempt(reject({ draftId: card.draftId, reason, note: note.trim() || null }));
        after(res);
        // Six seconds to take back a mis-keyed X (the shared undo layer).
        if (res.ok) toast.offerUndo(res.undo ?? null, `Rejected ${card.company.name}`);
      });
    },
    [card, note, after, toast],
  );

  const doLinkedIn = useCallback(() => {
    if (!card || card.step > 0) return;
    startTransition(async () => after(await attempt(toLinkedIn(card.draftId))));
  }, [card, after]);

  const saveEdit = useCallback(() => {
    if (!card) return;
    startTransition(async () => {
      const res = await attempt(saveDraftEdit({ draftId: card.draftId, subject, body }));
      if (res.ok) setEditing(false);
      after(res);
    });
  }, [card, subject, body, after]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (typing(e)) {
        if (e.key === "Escape") {
          (e.target as HTMLElement).blur();
          setEditing(false);
        }
        return;
      }
      if (rejecting) {
        const n = Number(e.key);
        if (n >= 1 && n <= REASONS.length) {
          e.preventDefault();
          doReject(REASONS[n - 1]!.value);
        } else if (e.key === "Escape") setRejecting(false);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "j") setIndex((i) => Math.min(cards.length - 1, i + 1));
      else if (k === "k") setIndex((i) => Math.max(0, i - 1));
      else if (k === "a") doApprove();
      else if (k === "e") {
        e.preventDefault();
        setEditing(true);
        setTimeout(() => bodyRef.current?.focus(), 0);
      } else if (k === "x") setRejecting(true);
      else if (k === "l") doLinkedIn();
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards.length, rejecting, doApprove, doReject, doLinkedIn]);

  const header = (
    <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="queue-stats">
      <span className="rounded-full border border-line px-3 py-1 text-[12.5px] tabular-nums">
        <b className="text-ink">{stats.approvedToday}</b> / {stats.cap} approved today
      </span>
      <span className="text-[12px] tabular-nums text-muted">{stats.pending} waiting</span>
      {stats.byProduct.map((p) => (
        <span key={p.productId ?? "none"} className="rounded-full bg-panel px-2.5 py-0.5 text-[11.5px] tabular-nums text-muted">
          {p.name}: {p.pending} waiting · {p.approvedToday} approved
        </span>
      ))}
      <span className="ml-auto hidden text-[11px] text-muted md:inline">
        J/K move · A approve · E edit · X reject · L LinkedIn
      </span>
    </div>
  );

  if (!card) {
    return (
      <>
        {header}
        <p className="rounded-card border border-line bg-panel p-6 text-[13px] text-muted" data-testid="queue-empty">
          Nothing waiting for approval. New drafts arrive after the nightly run — or start one from{" "}
          <Link href="/outbound/runs" className="underline">Runs</Link>.
        </p>
      </>
    );
  }

  const openedSelected = [...selected].filter((id) => opened.has(id));
  // Information, never a blocker for an edited draft (CLAUDE.md rule 10 is
  // generation-time only): does the text on screen still carry a cited
  // company-specific fact, and which?
  const hook = hookStatus({ subject, body }, card.points);
  const editedNow = isHumanEdited({ subject, body, originalSubject: card.originalSubject, originalBody: card.originalBody });
  const factLabel = (id: string) => card.facts.find((f) => f.id === id)?.label ?? id;

  return (
    <div data-testid="approval-queue">
      {header}
      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="grid max-h-[70vh] content-start gap-1 overflow-y-auto" aria-label="Drafts">
          {cards.map((c, i) => (
            <div
              key={c.draftId}
              className={`flex items-center gap-2 rounded-[10px] border px-2.5 py-2 text-[12px] ${i === index ? "border-accent bg-panel" : "border-line"}`}
            >
              <input
                type="checkbox"
                aria-label={`Select ${c.company.name}`}
                checked={selected.has(c.draftId)}
                onChange={(e) =>
                  setSelected((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(c.draftId);
                    else n.delete(c.draftId);
                    return n;
                  })
                }
              />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setIndex(i)}>
                <span className="block truncate text-ink">{c.company.name}</span>
                <span className="block truncate text-[11px] text-muted">
                  {c.restored ? "restored · " : ""}
                  {c.step > 0 ? `follow-up ${c.step} · ` : ""}
                  {c.product}
                  {opened.has(c.draftId) ? "" : " · new"}
                </span>
              </button>
            </div>
          ))}
          {selected.size > 0 && (
            <button
              type="button"
              className={`${BTN} mt-2`}
              disabled={pending || openedSelected.length === 0}
              onClick={() =>
                startTransition(async () => {
                  const res = await attempt(approveOpened(openedSelected));
                  if (res.ok) {
                    setSelected(new Set());
                    setError(res.skipped.length ? `${res.approved} approved; ${res.skipped.length} skipped (${res.skipped[0]!.reason}).` : null);
                    router.refresh();
                  } else setError(res.error);
                })
              }
              title="Only drafts you have opened can be approved together."
            >
              Approve {openedSelected.length} opened
              {selected.size > openedSelected.length ? ` (${selected.size - openedSelected.length} not opened)` : ""}
            </button>
          )}
        </aside>

        <article className="grid min-w-0 gap-3" data-testid="queue-card">
          {error && <p className="text-[12px] text-[#FFB3C2]">{error}</p>}
          <section className="grid gap-2 rounded-card border border-line bg-panel p-[18px]">
            <div className="text-[11.5px] text-muted">
              To <b className="text-ink">{card.to.name ? `${card.to.name} <${card.to.address}>` : card.to.address}</b> · found via{" "}
              {card.to.source ?? "—"} ({card.to.kind.replace("_", " + ")}){card.to.verify ? ` · ${card.to.verify}` : ""}
              {card.step > 0 ? ` · follow-up ${card.step}` : ""}
              {card.edited ? " · edited" : ""}
            </div>
            {card.restored && (
              <div data-testid="restored-flag" className="justify-self-start rounded-full border border-accent px-2.5 py-0.5 text-[11px] text-ink">
                Restored {card.restored.at.slice(0, 10)} — a second look{card.restored.note ? `: ${card.restored.note}` : ""}
              </div>
            )}
            <div
              data-testid="hook-status"
              data-grounded={hook.grounded ? "yes" : "no"}
              className={`justify-self-start rounded-full border px-2.5 py-0.5 text-[11px] ${
                hook.grounded
                  ? "border-[rgba(61,220,151,0.35)] text-[#3DDC97]"
                  : editedNow
                    ? "border-line text-muted"
                    : "border-[#FFD27A] text-[#FFD27A]"
              }`}
            >
              {hook.grounded
                ? `Company-specific fact: ${[...new Set(hook.present.map((p) => factLabel(p.factId)))].join(", ")}`
                : editedNow
                  ? "No company-specific fact in your rewrite — it sends on your approval"
                  : "Machine draft without a company-specific fact — edit it or reject it"}
            </div>
            {editing ? (
              <>
                <input className={INPUT} value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
                <textarea
                  ref={bodyRef}
                  className={`${INPUT} min-h-[220px] font-[inherit]`}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  aria-label="Body"
                />
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={BTN} disabled={pending} onClick={saveEdit}>
                    Save edit
                  </button>
                  <button type="button" className={BTN} onClick={() => { setEditing(false); setSubject(card.subject); setBody(card.body); }}>
                    Cancel
                  </button>
                  {(card.edited || body !== card.originalBody) && (
                    <details className="w-full text-[11.5px] text-muted">
                      <summary className="cursor-pointer">Original draft</summary>
                      <p className="mt-1 whitespace-pre-wrap">{card.originalSubject}{"\n\n"}{card.originalBody}</p>
                    </details>
                  )}
                </div>
              </>
            ) : (
              <>
                <h3 className="text-[15px] font-semibold text-ink" data-testid="queue-subject">{subject}</h3>
                <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed" data-testid="queue-body">
                  <Highlighted text={body} ranges={highlightRanges(body, card.points)} />
                </div>
                <div className="whitespace-pre-wrap border-t border-line pt-2 text-[12.5px] text-muted" data-testid="queue-signature">
                  {"--\n"}
                  {card.signature}
                  {"\n\n"}
                  {card.outgoing.split("\n").slice(-1)[0]}
                </div>
              </>
            )}
          </section>

          {rejecting ? (
            <section className="grid gap-2 rounded-card border border-line bg-panel p-3" data-testid="reject-reasons">
              <span className="text-[12px] text-muted">Why? (1–6, Esc to cancel)</span>
              <input className={INPUT} placeholder="Note (required for Other)" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="flex flex-wrap gap-1.5">
                {REASONS.map((r, i) => (
                  <button key={r.value} type="button" className={BTN} disabled={pending} onClick={() => doReject(r.value)}>
                    {i + 1} · {r.label}
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={PRIMARY} disabled={pending} onClick={doApprove} data-testid="queue-approve">
                Approve (A)
              </button>
              <button type="button" className={BTN} disabled={pending} onClick={() => setEditing(true)}>
                Edit (E)
              </button>
              <button type="button" className={BTN} disabled={pending} onClick={() => setRejecting(true)} data-testid="queue-reject">
                Reject (X)
              </button>
              {card.step === 0 && (
                <button type="button" className={BTN} disabled={pending} onClick={doLinkedIn}>
                  LinkedIn (L)
                </button>
              )}
            </div>
          )}

          <section className="grid gap-3 sm:grid-cols-2">
            <div className="grid content-start gap-1 rounded-card border border-line bg-panel p-3 text-[12px]">
              <b className="text-[12.5px] text-ink">{card.company.name}</b>
              {card.company.taxNumber && <span className="tabular-nums text-muted">tax {card.company.taxNumber}</span>}
              {card.company.activity && <span>{card.company.activity}</span>}
              <span className="tabular-nums text-muted">
                {[card.company.city, card.company.employees !== null ? `${card.company.employees} employees` : null, card.company.revenue, card.company.founded ? `founded ${card.company.founded.slice(0, 4)}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {card.company.website && (
                <a href={card.company.website} target="_blank" rel="noreferrer" className="truncate underline">
                  {card.company.website}
                </a>
              )}
            </div>
            <div className="grid content-start gap-1 rounded-card border border-line bg-panel p-3 text-[12px]">
              <span>
                <b className="text-ink">{card.product}</b> · {card.profile} · {card.mode.toLowerCase()}
              </span>
              {card.audit && (
                <span>
                  Audit score <b className="tabular-nums text-ink">{card.audit.score}</b>
                </span>
              )}
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">Why this company — facts used</span>
              {card.points.map((p) => {
                const f = card.facts.find((x) => x.id === p.factId);
                return (
                  <span key={p.factId + p.quote}>
                    <mark className="rounded bg-[rgba(116,39,198,0.25)] px-0.5 text-ink">{f?.label ?? p.factId}</mark> {f?.value}
                  </span>
                );
              })}
            </div>
          </section>
          <details className="text-[11.5px] text-muted">
            <summary className="cursor-pointer">How the address was found</summary>
            <ul className="mt-1 grid gap-0.5">
              {card.to.trail.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </details>
        </article>
      </div>
    </div>
  );
}

function Highlighted({ text, ranges }: { text: string; ranges: QueueCard["highlights"] }) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r.start > at) parts.push(text.slice(at, r.start));
    parts.push(
      <mark key={r.start} title={r.factId} className="rounded bg-[rgba(116,39,198,0.25)] px-0.5 text-ink">
        {text.slice(r.start, r.end)}
      </mark>,
    );
    at = r.end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}
