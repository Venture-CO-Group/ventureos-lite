"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Stage } from "@prisma/client";
import {
  PIPELINE_STAGES,
  SIDE_STAGES,
  STAGE_LABELS,
  requiresReason,
} from "@/modules/pipeline/transitions";
import { moveLeadStage } from "@/modules/leads/actions";
import { useToast } from "./toast";
import { useViewState } from "./use-view-state";
import { idField } from "@/lib/client/view-state";
import { LeadDetailModal } from "./lead-detail-modal";
import { EmptyState } from "./empty-state";
import { closeDeal } from "@/modules/analytics/actions";
import {
  OUTCOME_RESULTS,
  OUTCOME_REASONS,
  RESULT_LABEL,
  REASON_LABEL,
  type OutcomeResult,
  type OutcomeReason,
} from "@/modules/analytics/taxonomy";

export interface PipelineCard {
  id: string;
  name: string;
  company: string;
  icpScore: number | null;
  stage: Stage;
  daysInStage: number;
  wakeUpAt: string | null;
  reason: string | null;
  chainTypes: string[];
  closedResult: string | null;
  invoiceStatus: string | null;
  /** Set once this lead has crossed into the money journey (P4/b). */
  deal: { dealId: string; value: number; status: string } | null;
}

const INVOICE_CHIP: Record<string, string> = {
  PREPARED: "bg-panel text-muted",
  SUBMITTED: "bg-accent-soft text-accent-ink",
  ISSUED: "bg-accent-soft text-accent-ink",
  PAID: "bg-[rgba(61,220,151,0.12)] text-[#3DDC97]",
  FAILED: "bg-[rgba(255,92,122,0.12)] text-[#FFB3C2]",
};

const CHAIN_STEPS = ["QUOTE", "CONTRACT", "CERTIFICATE"] as const;

/**
 * How far the pointer may travel between press and release and still count as
 * a click. Without this, the small drift of starting a drag would open the
 * modal on top of the drag the user actually wanted.
 */
const DRAG_THRESHOLD_PX = 5;

function ChainDots({ types }: { types: string[] }) {
  if (types.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1" title="Document chain">
      {CHAIN_STEPS.map((t) => (
        <i
          key={t}
          className={`h-1.5 w-1.5 rounded-full ${types.includes(t) ? "bg-grad" : "bg-line"}`}
        />
      ))}
    </span>
  );
}

const ALL_STAGES: Stage[] = [...PIPELINE_STAGES, ...SIDE_STAGES];

/**
 * Where the lead board stops owning the story (playbook-v2 P4/a).
 *
 * A lead owns the pre-deal journey; from Qualified onward the money lives on a
 * Deal. The columns are still here — hiding them would lose 55 leads from view
 * on upgrade — but they are labelled as belonging to the deals board, and every
 * card that has a deal links straight to it.
 */
const DEAL_OWNED: Stage[] = ["QUALIFIED", "MEETING_BOOKED", "HANDED_OFF"];

function Notches({ score }: { score: number | null }) {
  const n = score ?? 0;
  return (
    <span className="inline-flex gap-[3px] align-middle">
      {Array.from({ length: 5 }).map((_, i) => (
        <i key={i} className={`h-[5px] w-[9px] rounded-[2px] ${i < n ? "bg-grad" : "bg-line"}`} />
      ))}
    </span>
  );
}

/** `?lead=` is the open detail overlay. */
const PIPELINE_VIEW = { lead: idField("lead") };

export function PipelineBoard({
  cards,
  totals = {},
  shown = Number.POSITIVE_INFINITY,
  pageSize = 25,
}: {
  cards: PipelineCard[];
  /** Total leads per stage, so a capped column can say what it is hiding. */
  totals?: Record<string, number>;
  /** How many per column this render asked for. */
  shown?: number;
  pageSize?: number;
}) {
  const router = useRouter();
  const { offerUndo } = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  /**
   * The open lead lives in the URL (playbook-v5 P16/5), so Back closes the
   * overlay instead of leaving the board — and so a lead somebody is looking
   * at can be sent to a colleague as a link.
   */
  const [view, setView] = useViewState(PIPELINE_VIEW);
  const detailFor = view.lead;
  const setDetailFor = useCallback(
    (id: string | null) => setView({ lead: id }),
    [setView],
  );
  /** Press origin + whether a drag actually began — see DRAG_THRESHOLD_PX. */
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const draggedRef = useRef(false);
  const [dragOver, setDragOver] = useState<Stage | null>(null);
  const [moveFor, setMoveFor] = useState<PipelineCard | null>(null);
  const [reasonFor, setReasonFor] = useState<{ card: PipelineCard } | null>(null);
  const [closeFor, setCloseFor] = useState<PipelineCard | null>(null);

  /**
   * Optimistic stage moves (P6/3).
   *
   * The card jumps columns immediately and the server call follows. A refusal —
   * the score gate, the qualification gate, a concurrent edit — puts it back
   * where it was and says why. The override is keyed by card id and cleared on
   * every fresh server render, so a stale optimistic position cannot outlive
   * the truth.
   */
  const [moved, setMoved] = useState<Record<string, Stage>>({});
  useEffect(() => setMoved({}), [cards]);

  const byStage = useMemo(() => {
    const map = new Map<Stage, PipelineCard[]>();
    for (const s of ALL_STAGES) map.set(s, []);
    for (const c of cards) map.get(moved[c.id] ?? c.stage)?.push(c);
    return map;
  }, [cards, moved]);

  async function doMove(card: PipelineCard, toStage: Stage, opts?: { reason?: string }) {
    setError(null);
    setMoveFor(null);
    if ((moved[card.id] ?? card.stage) === toStage) return;
    if (requiresReason(toStage) && !opts?.reason) {
      setReasonFor({ card });
      return;
    }
    setMoved((m) => ({ ...m, [card.id]: toStage }));
    const res = await moveLeadStage(card.id, toStage, opts);
    if (!res.ok) {
      setMoved((m) => {
        const next = { ...m };
        delete next[card.id];
        return next;
      });
      setError(res.error);
      return;
    }
    offerUndo(res.undo);
    router.refresh();
  }

  return (
    <div className="max-w-full">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11.5px] text-muted">
        <span>
          <b className="font-semibold text-ink">Researched → Replied</b> is the lead journey.
        </span>
        <span aria-hidden>·</span>
        <span>
          <b className="font-semibold text-ink">Qualified onward</b> is money, and lives on{" "}
          {/* Always underlined, not just on hover: a link inside a sentence has
              to be distinguishable without relying on colour (WCAG 1.4.1). */}
          <Link href="/deals" className="text-accent-ink underline underline-offset-2">
            Deals
          </Link>
          .
        </span>
      </div>

      {error && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3.5 py-2.5 text-[12.5px] text-[#FFB3C2]">
          {error}
        </div>
      )}

      {cards.length === 0 && (
        <EmptyState
          title="the board is empty"
          testId="pipeline-empty"
          action={{ label: "Capture a lead", href: "/leads" }}
        >
          Every lead you capture starts in Researched and moves across as the conversation
          does. From Qualified onward the money lives on a Deal.
        </EmptyState>
      )}

      <div className="grid snap-x snap-mandatory grid-flow-col auto-cols-[82vw] items-start gap-3 overflow-x-auto pb-3 sm:auto-cols-[236px]">
        {ALL_STAGES.map((stage) => {
          const list = byStage.get(stage) ?? [];
          const isSide = SIDE_STAGES.includes(stage);
          return (
            <div
              key={stage}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(stage);
              }}
              onDragLeave={() => setDragOver((s) => (s === stage ? null : s))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const card = cards.find((c) => c.id === dragId);
                if (card) startTransition(() => doMove(card, stage));
              }}
              className={`min-h-[200px] snap-start rounded-card border p-2.5 ${
                dragOver === stage
                  ? "border-accent shadow-[0_0_20px_rgba(116,39,198,0.3)_inset]"
                  : "border-line"
              } ${isSide ? "bg-[rgba(239,241,248,0.015)]" : "bg-[rgba(239,241,248,0.025)]"}`}
            >
              <div className="flex items-center gap-2 px-1.5 pt-1 text-[12px] font-semibold">
                {STAGE_LABELS[stage]}
                <span className="ml-auto font-medium text-muted">
                  {totals[stage] ?? list.length}
                </span>
              </div>
              <div className="px-1.5 pb-2.5 pt-0.5 text-[10px] uppercase tracking-[0.1em] text-muted">
                {DEAL_OWNED.includes(stage) ? "deal territory" : isSide ? "parked" : "lead journey"}
              </div>

              {list.map((c) => (
                /**
                 * NOT role="button".
                 *
                 * It was, with tabIndex and an aria-label, and it contains a
                 * Move-to menu, a Close-deal button and a deal link — which
                 * axe reports as nested-interactive, nine nodes of it: a
                 * screen reader is told "button" and then finds three more
                 * controls inside, and the whole card lands in the tab order
                 * as one opaque stop. The keyboard route to opening a card is
                 * now the title button below, which is a real button.
                 */
                <div
                  key={c.id}
                  draggable
                  data-testid="pipeline-card"
                  onDragStart={() => {
                    draggedRef.current = true;
                    setDragId(c.id);
                  }}
                  onDragEnd={() => setDragId(null)}
                  onPointerDown={(e) => {
                    // Remember where the press started; a click that travelled
                    // more than a few pixels was a drag attempt, not a tap.
                    pressRef.current = { x: e.clientX, y: e.clientY };
                    draggedRef.current = false;
                  }}
                  onClick={(e) => {
                    // Buttons inside the card (Move to…, Close deal…) handle
                    // themselves; don't also open the modal behind them.
                    if ((e.target as HTMLElement).closest("button")) return;
                    if (draggedRef.current) return;
                    const start = pressRef.current;
                    if (start) {
                      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
                      if (moved > DRAG_THRESHOLD_PX) return;
                    }
                    setDetailFor(c.id);
                  }}
                  className="mb-2.5 cursor-pointer rounded-[11px] border border-line bg-panel-2 p-3 transition-shadow hover:border-accent-soft hover:shadow-[0_0_16px_rgba(116,39,198,0.25)] focus-within:border-accent"
                >
                  <b className="block text-[13px]">
                    <button
                      type="button"
                      onClick={() => setDetailFor(c.id)}
                      className="w-full rounded-[4px] text-left focus-visible:ring-1 focus-visible:ring-accent"
                    >
                      {c.name}
                    </button>
                  </b>
                  <span className="mb-2 mt-0.5 block text-[11.5px] text-muted">{c.company}</span>
                  {c.invoiceStatus && (
                    <span className={`mb-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${INVOICE_CHIP[c.invoiceStatus] ?? "bg-panel text-muted"}`}>
                      invoice · {c.invoiceStatus.toLowerCase()}
                    </span>
                  )}
                  <div className="flex items-center gap-2 text-[11px] text-muted">
                    <Notches score={c.icpScore} />
                    <ChainDots types={c.chainTypes} />
                    {stage === "NOT_NOW" && c.wakeUpAt ? (
                      <span className="ml-auto">wakes {c.wakeUpAt}</span>
                    ) : (
                      <span className={`ml-auto ${c.daysInStage >= 7 ? "text-warn" : ""}`}>
                        {c.daysInStage}d
                      </span>
                    )}
                  </div>
                  {c.deal && (
                    <Link
                      href={`/deals`}
                      onClick={(e) => e.stopPropagation()}
                      data-testid="lead-deal-chip"
                      className="mt-2 inline-block rounded-full border border-accent-soft bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent-ink hover:bg-panel-2"
                    >
                      deal · {c.deal.value.toLocaleString("hu-HU")} Ft
                    </Link>
                  )}
                  {stage === "DISQUALIFIED" && c.reason && (
                    <p className="mt-1.5 text-[11px] text-muted">{c.reason}</p>
                  )}
                  {stage === "HANDED_OFF" &&
                    (c.closedResult ? (
                      <span
                        className={`mt-2 inline-block rounded-full px-2.5 py-0.5 text-[10.5px] font-semibold ${
                          c.closedResult === "WON"
                            ? "bg-[rgba(61,220,151,0.12)] text-[#3DDC97]"
                            : c.closedResult === "LOST"
                              ? "bg-[rgba(255,92,122,0.12)] text-[#FFB3C2]"
                              : "bg-panel text-muted"
                        }`}
                      >
                        closed · {c.closedResult.toLowerCase()}
                      </span>
                    ) : (
                      <button
                        onClick={() => setCloseFor(c)}
                        className="mt-2 w-full rounded-[8px] border border-accent bg-accent-soft px-2 py-1 text-[11px] font-semibold text-[#E4D3FF] hover:bg-panel-2"
                      >
                        Close deal…
                      </button>
                    ))}
                  <button
                    onClick={() => setMoveFor(c)}
                    className="mt-2 w-full rounded-[8px] border border-line bg-panel px-2 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-ink"
                  >
                    Move to…
                  </button>
                </div>
              ))}
              {(totals[stage] ?? list.length) > list.length && (
                <Link
                  href={`/pipeline?per=${Math.min(400, shown + pageSize)}`}
                  data-testid="stage-load-more"
                  className="mt-1 block rounded-[8px] border border-line bg-panel px-2 py-1.5 text-center text-[11px] text-muted hover:bg-panel-2 hover:text-ink"
                >
                  load {Math.min(pageSize, (totals[stage] ?? 0) - list.length)} more
                </Link>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-1.5 text-[12px] text-muted">
        Drag cards between stages, or use “Move to…” on touch. After Follow-up 2
        with no reply, leads auto-move to <b>Not now</b> and resurface in 6 months.
        {pending ? " · saving…" : ""}
      </p>

      {/* Move-to sheet (bottom sheet on mobile, centered on desktop) */}
      {detailFor && (
        <LeadDetailModal leadId={detailFor} onClose={() => setDetailFor(null)} />
      )}

      {moveFor && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center"
          onClick={() => setMoveFor(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[420px] rounded-t-card border border-line bg-[rgba(6,11,38,0.98)] p-4 backdrop-blur sm:rounded-card"
          >
            <div className="mb-2 flex items-center">
              <b className="text-[13px]">Move {moveFor.name} to…</b>
              <button aria-label="Close" onClick={() => setMoveFor(null)} className="ml-auto text-muted hover:text-ink">
                ✕
              </button>
            </div>
            <div className="grid gap-1.5">
              {ALL_STAGES.filter((s) => s !== moveFor.stage).map((s) => (
                <button
                  key={s}
                  onClick={() => startTransition(() => doMove(moveFor, s))}
                  className="flex min-h-[44px] items-center rounded-[10px] border border-line bg-panel px-3 text-[13px] hover:border-accent-soft hover:bg-panel-2"
                >
                  {STAGE_LABELS[s]}
                  {s === "CONTACTED" && (moveFor.icpScore ?? 0) < 3 && (
                    <span className="ml-auto text-[11px] text-warn">score gate</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Disqualify reason (required) */}
      {reasonFor && (
        <ReasonDialog
          name={reasonFor.card.name}
          onClose={() => setReasonFor(null)}
          onConfirm={(reason) => {
            const card = reasonFor.card;
            setReasonFor(null);
            startTransition(() => doMove(card, "DISQUALIFIED", { reason }));
          }}
        />
      )}

      {/* Win/loss close (outcome required — spec §4.20) */}
      {closeFor && (
        <CloseDialog
          card={closeFor}
          onClose={() => setCloseFor(null)}
          onDone={() => {
            setCloseFor(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function ReasonDialog({
  name,
  onClose,
  onConfirm,
}: {
  name: string;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-[440px] rounded-card border border-line bg-[rgba(6,11,38,0.98)] p-5 backdrop-blur">
        <div className="mb-2 flex items-center">
          <b className="text-[13px]">Disqualify {name}</b>
          <button aria-label="Close" onClick={onClose} className="ml-auto text-muted hover:text-ink">
            ✕
          </button>
        </div>
        <p className="mb-2 text-[12px] text-muted">A reason is required and recorded.</p>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (e.g. no budget, wrong segment)"
          className="mb-3 w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2"
          >
            Cancel
          </button>
          <button
            disabled={!reason.trim()}
            onClick={() => onConfirm(reason.trim())}
            className="rounded-[10px] border border-[rgba(255,92,122,0.4)] bg-[rgba(255,92,122,0.12)] px-4 py-2 text-[13px] font-semibold text-[#FFB3C2] disabled:opacity-60"
          >
            Disqualify
          </button>
        </div>
      </div>
    </div>
  );
}

const FIELD =
  "w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent";

function CloseDialog({
  card,
  onClose,
  onDone,
}: {
  card: PipelineCard;
  onClose: () => void;
  onDone: () => void;
}) {
  const [result, setResult] = useState<OutcomeResult>("won");
  const [reason, setReason] = useState<OutcomeReason>("price");
  const [value, setValue] = useState("");
  const [competitor, setCompetitor] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await closeDeal({
      leadId: card.id,
      result,
      reason,
      value: value === "" ? Number.NaN : Number(value),
      competitor: competitor || null,
      note: note || null,
    });
    setBusy(false);
    if (res.ok) onDone();
    else setError(res.error);
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-[460px] rounded-card border border-line bg-[rgba(6,11,38,0.98)] p-5 backdrop-blur">
        <div className="mb-2 flex items-center">
          <b className="text-[13px]">Close deal · {card.name}</b>
          <button aria-label="Close" onClick={onClose} className="ml-auto text-muted hover:text-ink">
            ✕
          </button>
        </div>
        <p className="mb-3 text-[12px] text-muted">
          An outcome is required to close a handed-off lead — it feeds the Signal Engine.
        </p>
        {error && <p className="mb-2 text-[12px] text-[#FFB3C2]">{error}</p>}

        <div className="grid gap-2">
          <div className="grid grid-cols-3 gap-2">
            {OUTCOME_RESULTS.map((r) => (
              <button
                key={r}
                onClick={() => setResult(r)}
                className={`rounded-[8px] border px-2 py-2 text-[12.5px] font-semibold ${
                  result === r ? "border-accent bg-accent-soft text-[#E4D3FF]" : "border-line text-[#C9CEE3]"
                }`}
              >
                {RESULT_LABEL[r]}
              </button>
            ))}
          </div>

          <label className="text-[11px] uppercase tracking-[0.12em] text-muted">Reason</label>
          <select value={reason} onChange={(e) => setReason(e.target.value as OutcomeReason)} className={FIELD}>
            {OUTCOME_REASONS.map((r) => (
              <option key={r} value={r}>
                {REASON_LABEL[r]}
              </option>
            ))}
          </select>

          {reason === "other" && (
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (required for Other)"
              className={FIELD}
            />
          )}

          <input
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ""))}
            inputMode="numeric"
            placeholder="Deal value (HUF, integer)"
            className={FIELD}
          />
          <input
            value={competitor}
            onChange={(e) => setCompetitor(e.target.value)}
            placeholder="Competitor (optional)"
            className={FIELD}
          />
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2"
          >
            Cancel
          </button>
          <button
            disabled={busy}
            onClick={submit}
            className="rounded-[10px] border border-accent bg-accent-soft px-4 py-2 text-[13px] font-semibold text-[#E4D3FF] disabled:opacity-60"
          >
            {busy ? "Saving…" : "Record outcome"}
          </button>
        </div>
      </div>
    </div>
  );
}
