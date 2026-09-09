"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { moveDealStage } from "@/modules/deals/actions";
import { startProjectForDeal } from "@/modules/projects/actions";
import { attempt } from "@/lib/client/server-action";
import { useToast } from "./toast";
import { InlineEdit, type InlineSaveResult, type InlineValue } from "./inline-edit";
import { editDealField } from "@/modules/deals/inline-actions";
import type { DealCardView, PipelineView } from "@/modules/deals/store";
import { EmptyState } from "./empty-state";

/**
 * The deals kanban (playbook-v2 P4/b).
 *
 * Same interaction pattern as the lead board — drag with a click threshold, a
 * "Move to…" fallback for touch — because the two boards sit next to each other
 * in the nav and learning two gestures for one idea is a tax.
 *
 * The value and the expected close date are edited in place on the card (P7/1
 * asks for exactly this on kanban cards, and a deal whose number can only be
 * changed in a modal is a number nobody keeps current).
 */

export interface DealsBoardProps {
  pipelines: PipelineView[];
  activePipelineId: string | null;
  cards: DealCardView[];
  /** Deals per stage id, so a capped column can say what it is hiding (P6/3). */
  totals?: Record<string, number>;
  shown?: number;
  pageSize?: number;
}

const CHAIN_STEPS = ["QUOTE", "CONTRACT", "CERTIFICATE"] as const;
const DRAG_THRESHOLD_PX = 5;

const INVOICE_CHIP: Record<string, string> = {
  PREPARED: "bg-panel text-muted",
  SUBMITTED: "bg-accent-soft text-accent-ink",
  ISSUED: "bg-accent-soft text-accent-ink",
  PAID: "bg-[rgba(61,220,151,0.12)] text-[#3DDC97]",
  REFUNDED: "bg-[rgba(255,92,122,0.12)] text-[#FFB3C2]",
  FAILED: "bg-[rgba(255,92,122,0.12)] text-[#FFB3C2]",
};

function huf(n: number): string {
  return `${n.toLocaleString("hu-HU")} Ft`;
}

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

/**
 * A field that shows as text and becomes an input on click. Esc cancels, Enter
 * and blur save; the server is still the boundary, so a rejected value snaps
 * back to what the server last said rather than to what was typed.
 */
export function DealsBoard({
  pipelines,
  activePipelineId,
  cards,
  totals: stageTotals = {},
  shown = Number.POSITIVE_INFINITY,
  pageSize = 25,
}: DealsBoardProps) {
  const router = useRouter();
  const { offerUndo } = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  /** Start the delivery checklist from the workspace's default template. */
  function startProject(dealId: string) {
    setError(null);
    startTransition(async () => {
      const res = await attempt(startProjectForDeal({ dealId }));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(`/projects?project=${res.projectId}`);
    });
  }
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [moveFor, setMoveFor] = useState<DealCardView | null>(null);
  const [lostFor, setLostFor] = useState<{ card: DealCardView; stageId: string } | null>(null);
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const draggedRef = useRef(false);

  const active = pipelines.find((p) => p.id === activePipelineId) ?? null;
  // Memoised so the empty-array fallback is not a fresh reference every render,
  // which would re-bucket every card on every keystroke in an inline field.
  const stages = useMemo(() => active?.stages ?? [], [active]);

  /** Optimistic stage moves, same shape as the lead board (P6/3). */
  const [moved, setMoved] = useState<Record<string, string>>({});
  useEffect(() => setMoved({}), [cards]);

  const byStage = useMemo(() => {
    const map = new Map<string, DealCardView[]>();
    for (const s of stages) map.set(s.id, []);
    for (const c of cards) map.get(moved[c.id] ?? c.stageId)?.push(c);
    return map;
  }, [cards, stages, moved]);

  const totals = useMemo(() => {
    const map = new Map<string, number>();
    for (const [stageId, list] of byStage) {
      map.set(stageId, list.reduce((n, c) => n + c.value, 0));
    }
    return map;
  }, [byStage]);

  async function doMove(card: DealCardView, stageId: string, lostReason?: string) {
    setError(null);
    setMoveFor(null);
    if ((moved[card.id] ?? card.stageId) === stageId) return;
    const stage = stages.find((s) => s.id === stageId);
    if (stage?.kind === "lost" && !lostReason) {
      setLostFor({ card, stageId });
      return;
    }
    setMoved((m) => ({ ...m, [card.id]: stageId }));
    const res = await moveDealStage(card.id, stageId, { lostReason });
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

  /**
   * One field, through the deal's own inline rules.
   *
   * This used to round and clamp on the client — `Math.max(0, Math.round(Number(next) || 0))`
   * turned "abc" into 0 and "1.5" into 2 without telling anybody. Money is an
   * integer of forints (CLAUDE.md), so the server now refuses a fractional or
   * unparseable amount and says which; it also refuses edits to a CLOSED deal,
   * whose numbers the revenue figures are already built on.
   */
  async function editField(
    dealId: string,
    field: string,
    value: InlineValue,
  ): Promise<InlineSaveResult> {
    const res = await editDealField({ dealId, field, value });
    if (res.ok) router.refresh();
    return res;
  }

  return (
    <div className="max-w-full">
      {/* Per-pipeline tabs. Server-rendered links rather than client state: a
          pipeline is a place, and a place deserves a URL you can send someone. */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {pipelines.map((p) => (
          <Link
            key={p.id}
            href={`/deals?pipeline=${p.id}`}
            data-testid="pipeline-tab"
            aria-current={p.id === activePipelineId ? "page" : undefined}
            className={`rounded-[10px] border px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
              p.id === activePipelineId
                ? "border-accent bg-accent-soft text-[#E4D3FF]"
                : "border-line bg-panel text-muted hover:bg-panel-2 hover:text-ink"
            }`}
          >
            {p.name}
          </Link>
        ))}
        <span className="ml-auto text-[11.5px] text-muted">
          the money journey · leads before Qualified stay on{" "}
          <Link href="/pipeline" className="text-accent-ink underline-offset-2 hover:underline">
            Pipeline
          </Link>
        </span>
      </div>

      {error && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3.5 py-2.5 text-[12.5px] text-[#FFB3C2]">
          {error}
        </div>
      )}

      {cards.length === 0 && (
        <EmptyState
          title="no deals on this board"
          testId="deals-empty"
          action={{ label: "Open Pipeline", href: "/pipeline" }}
        >
          A deal is a piece of work with money attached. Qualify a lead on the Pipeline
          board and convert it — the value, the probability and the close date live here.
        </EmptyState>
      )}

      <div className="grid snap-x snap-mandatory grid-flow-col auto-cols-[82vw] items-start gap-3 overflow-x-auto pb-3 sm:auto-cols-[248px]">
        {stages.map((stage) => {
          const list = byStage.get(stage.id) ?? [];
          const terminal = stage.kind !== "open";
          return (
            <div
              key={stage.id}
              data-testid="deal-column"
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(stage.id);
              }}
              onDragLeave={() => setDragOver((s) => (s === stage.id ? null : s))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const card = cards.find((c) => c.id === dragId);
                if (card) startTransition(() => doMove(card, stage.id));
              }}
              className={`min-h-[200px] snap-start rounded-card border p-2.5 ${
                dragOver === stage.id
                  ? "border-accent shadow-[0_0_20px_rgba(116,39,198,0.3)_inset]"
                  : "border-line"
              } ${terminal ? "bg-[rgba(239,241,248,0.015)]" : "bg-[rgba(239,241,248,0.025)]"}`}
            >
              <div className="flex items-baseline gap-2 px-1.5 pb-1 pt-1 text-[12px] font-semibold">
                {stage.name}
                <span className="ml-auto font-medium text-muted">
                  {stageTotals[stage.id] ?? list.length}
                </span>
              </div>
              <div className="flex items-baseline gap-2 px-1.5 pb-2.5 text-[10.5px] text-muted tabular-nums">
                <span>{huf(totals.get(stage.id) ?? 0)}</span>
                {stage.kind === "open" && <span className="ml-auto">{stage.probability}%</span>}
              </div>

              {list.map((c) => (
                <div
                  key={c.id}
                  draggable
                  data-testid="deal-card"
                  onDragStart={() => {
                    draggedRef.current = true;
                    setDragId(c.id);
                  }}
                  onDragEnd={() => setDragId(null)}
                  onPointerDown={(e) => {
                    pressRef.current = { x: e.clientX, y: e.clientY };
                    draggedRef.current = false;
                  }}
                  className={`mb-2.5 rounded-[11px] border bg-panel-2 p-3 transition-shadow hover:border-accent-soft ${
                    c.rotting ? "border-[rgba(255,176,66,0.45)]" : "border-line"
                  }`}
                >
                  <b className="block text-[13px]">
                    <InlineEdit
                      kind="text"
                      label="deal title"
                      activateOn="doubleClick"
                      value={c.title}
                      display={c.title}
                      onSave={(next) => editField(c.id, "title", next)}
                    />
                  </b>
                  <span className="mb-2 mt-0.5 block text-[11.5px] text-muted">
                    {c.companyName ?? c.leadName ?? "—"}
                  </span>

                  <div className="mb-1.5 flex items-baseline gap-2 text-[12.5px] font-semibold tabular-nums">
                    <InlineEdit
                      kind="number"
                      label="deal value"
                      value={String(c.value)}
                      display={huf(c.value)}
                      onSave={(next) => editField(c.id, "value", next)}
                    />
                    {/**
                     * The asterisk marks an override. Clearing the field hands
                     * the weight back to the stage default, which is why the
                     * value sent is null rather than zero — a zero-percent deal
                     * and a deal inheriting its stage's weight are not the same
                     * statement about the pipeline.
                     */}
                    <span
                      className="ml-auto text-[11px] font-medium text-muted"
                      title={
                        c.inheritedProbability
                          ? "From the stage default — set a number to override it"
                          : "Set on this deal — clear it to go back to the stage default"
                      }
                    >
                      <InlineEdit
                        kind="number"
                        label="probability"
                        value={c.inheritedProbability ? null : String(c.probability)}
                        display={`${c.probability}%${c.inheritedProbability ? "" : "*"}`}
                        onSave={(next) => editField(c.id, "probability", next)}
                      />
                    </span>
                  </div>

                  <div className="flex items-center gap-2 text-[11px] text-muted">
                    <ChainDots types={c.chainTypes} />
                    <InlineEdit
                      kind="date"
                      label="expected close"
                      value={c.expectedCloseAt ?? null}
                      display={c.expectedCloseAt ?? "no close date"}
                      onSave={(next) => editField(c.id, "expectedCloseAt", next)}
                    />
                    <span className={`ml-auto ${c.rotting ? "text-warn" : ""}`}>
                      {c.rotting ? `rotting · ${c.daysInStage}d` : `${c.daysInStage}d`}
                    </span>
                  </div>

                  {c.invoiceStatus && (
                    <span
                      className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        INVOICE_CHIP[c.invoiceStatus] ?? "bg-panel text-muted"
                      }`}
                    >
                      invoice · {c.invoiceStatus.toLowerCase()}
                    </span>
                  )}

                  {/*
                    The handover (P11/2a). A won deal with no project is the one
                    moment worth interrupting: after this the signed contract
                    drifts, the work gets done, and the certificate — the
                    document the invoice waits on — is the thing nobody issues.
                  */}
                  {c.status === "WON" && (
                    <div className="mt-2">
                      {c.projectId ? (
                        <Link
                          href={`/projects?project=${c.projectId}`}
                          data-testid="deal-open-project"
                          className="block rounded-[8px] border border-line bg-panel px-2 py-1 text-center text-[11px] text-muted hover:bg-panel-2 hover:text-ink"
                        >
                          Projekt megnyitása
                        </Link>
                      ) : (
                        <button
                          onClick={() => startProject(c.id)}
                          disabled={pending}
                          data-testid="deal-start-project"
                          className="block w-full rounded-[8px] border border-accent bg-accent-soft px-2 py-1 text-center text-[11px] font-semibold text-[#E4D3FF] disabled:opacity-50"
                        >
                          Projekt indítása
                        </button>
                      )}
                    </div>
                  )}

                  <div className="mt-2 flex gap-1.5">
                    {c.leadId && (
                      <Link
                        href={`/leads?lead=${c.leadId}`}
                        className="flex-1 rounded-[8px] border border-line bg-panel px-2 py-1 text-center text-[11px] text-muted hover:bg-panel-2 hover:text-ink"
                      >
                        Lead
                      </Link>
                    )}
                    <button
                      onClick={() => setMoveFor(c)}
                      className="flex-1 rounded-[8px] border border-line bg-panel px-2 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-ink"
                    >
                      Move to…
                    </button>
                  </div>
                </div>
              ))}
              {(stageTotals[stage.id] ?? list.length) > list.length && (
                <Link
                  href={`/deals?pipeline=${activePipelineId}&per=${Math.min(400, shown + pageSize)}`}
                  data-testid="deal-load-more"
                  className="block rounded-[8px] border border-line bg-panel px-2 py-1.5 text-center text-[11px] text-muted hover:bg-panel-2 hover:text-ink"
                >
                  load {Math.min(pageSize, (stageTotals[stage.id] ?? 0) - list.length)} more
                </Link>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-1.5 text-[12px] text-muted">
        Drag cards between stages, or use “Move to…” on touch. Click a value or a
        close date to edit it. A card turns amber once it has sat longer than its
        stage allows.{pending ? " · saving…" : ""}
      </p>

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
              <b className="text-[13px]">Move {moveFor.title} to…</b>
              <button
                aria-label="Close"
                onClick={() => setMoveFor(null)}
                className="ml-auto text-muted hover:text-ink"
              >
                ✕
              </button>
            </div>
            <div className="grid gap-1.5">
              {stages
                .filter((s) => s.id !== moveFor.stageId)
                .map((s) => (
                  <button
                    key={s.id}
                    onClick={() => startTransition(() => doMove(moveFor, s.id))}
                    className="flex min-h-[44px] items-center rounded-[10px] border border-line bg-panel px-3 text-[13px] hover:border-accent-soft hover:bg-panel-2"
                  >
                    {s.name}
                    <span className="ml-auto text-[11px] text-muted">{s.probability}%</span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}

      {lostFor && (
        <LostDialog
          title={lostFor.card.title}
          onClose={() => setLostFor(null)}
          onConfirm={(reason) => {
            const { card, stageId } = lostFor;
            setLostFor(null);
            startTransition(() => doMove(card, stageId, reason));
          }}
        />
      )}
    </div>
  );
}

function LostDialog({
  title,
  onClose,
  onConfirm,
}: {
  title: string;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-[440px] rounded-card border border-line bg-[rgba(6,11,38,0.98)] p-5 backdrop-blur">
        <div className="mb-2 flex items-center">
          <b className="text-[13px]">Mark {title} lost</b>
          <button aria-label="Close" onClick={onClose} className="ml-auto text-muted hover:text-ink">
            ✕
          </button>
        </div>
        <p className="mb-2 text-[12px] text-muted">
          A reason is required and recorded — it is what the win/loss analysis reads.
        </p>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (e.g. price, timing, went in-house)"
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
            Mark lost
          </button>
        </div>
      </div>
    </div>
  );
}
