"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { undoAction } from "@/modules/undo/actions";
import {
  MAX_VISIBLE,
  announcement,
  dismiss as dismissFrom,
  markBusy,
  refuse,
  secondsFor,
  tick,
  visible as visibleOf,
  waiting,
  type QueuedToast,
  type ToastVariant,
} from "@/lib/client/toast-queue";

/**
 * The one toast layer (playbook-v5 P16/3).
 *
 * ── WHY THIS REPLACES THE UNDO TOAST RATHER THAN JOINING IT ─────────────────
 *
 * There was already an undo toast, and seven surfaces had grown their own
 * success and error messages beside it — a banner here, a red line under a
 * button there, a silent failure in the third. Adding a general toast provider
 * next to the undo one would have made two overlapping hosts that stack on top
 * of each other in the same corner. So the undo toast became the `undoable`
 * VARIANT of this provider, and `UndoProvider` is gone.
 *
 * ── THE QUEUE ───────────────────────────────────────────────────────────────
 *
 * At most three are visible. A fourth waits rather than pushing the first off
 * screen: a toast that vanishes before it is read is worse than one that
 * arrives a moment late, and bulk actions can produce a burst.
 *
 * Hovering pauses every countdown, including the undo window. Somebody with
 * the pointer over a toast is reading it, and taking the Undo button away from
 * under the cursor is the single most annoying thing this control could do.
 *
 * ── ANNOUNCEMENT ────────────────────────────────────────────────────────────
 *
 * One `aria-live` region owns announcements, and it is separate from the
 * visual stack. Marking each toast live would re-announce all three every time
 * one of them re-rendered for its countdown.
 */

export type { ToastVariant };

export interface UndoOffer {
  id: string;
  label: string;
}

export interface ToastInput {
  variant: ToastVariant;
  /** One line. The toast is not a place for a paragraph. */
  message: string;
  /** Only for `undoable`: the token the server handed back. */
  undo?: UndoOffer | null;
  /** Overrides the default dwell. Used for a rejection worth reading twice. */
  ms?: number;
}

interface ToastApi {
  show: (input: ToastInput) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  /**
   * The undo offer. A null token is a no-op rather than an error: `recordUndo`
   * is best-effort by design, and losing the offer must never turn into a
   * toast that says nothing happened when the action itself succeeded.
   */
  offerUndo: (offer: UndoOffer | null | undefined, message?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<QueuedToast[]>([]);
  const [paused, setPaused] = useState(false);
  const nextKey = useRef(1);
  const router = useRouter();

  const show = useCallback((input: ToastInput) => {
    setQueue((q) => [
      ...q,
      {
        variant: input.variant,
        message: input.message,
        undo: input.undo,
        key: nextKey.current++,
        remaining: secondsFor(input.variant, input.ms),
      },
    ]);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (message) => show({ variant: "success", message }),
      error: (message) => show({ variant: "error", message }),
      info: (message) => show({ variant: "info", message }),
      offerUndo: (offer, message) => {
        if (!offer) return;
        show({ variant: "undoable", message: message ?? offer.label, undo: offer });
      },
    }),
    [show],
  );

  /**
   * One interval for the whole stack, ticking only the visible ones. A timer
   * per toast means N intervals and N closures over stale state; a queued
   * toast must not burn its dwell while it is still off screen.
   */
  useEffect(() => {
    if (queue.length === 0 || paused) return;
    const t = setInterval(() => setQueue(tick), 1000);
    return () => clearInterval(t);
  }, [queue.length, paused]);

  const dismiss = useCallback((key: number) => {
    setQueue((q) => dismissFrom(q, key));
  }, []);

  const runUndo = useCallback(
    async (toast: QueuedToast) => {
      if (!toast.undo) return;
      setQueue((q) => markBusy(q, toast.key, true));
      const res = await undoAction(toast.undo.id);
      if (!res.ok) {
        setQueue((q) => refuse(q, toast.key, res.error));
        return;
      }
      dismiss(toast.key);
      router.refresh();
    },
    [dismiss, router],
  );

  const visible = visibleOf(queue);

  return (
    <Ctx.Provider value={api}>
      {children}

      {/* Announcements, once, away from the visual stack. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="toast-live">
        {announcement(queue)}
      </div>

      {visible.length > 0 && (
        <div
          data-testid="toast-stack"
          data-paused={paused ? "true" : "false"}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          className="pointer-events-none fixed bottom-24 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2 nav:bottom-6"
        >
          {visible.map((toast) => (
            <ToastRow
              key={toast.key}
              toast={toast}
              onUndo={() => void runUndo(toast)}
              onDismiss={() => dismiss(toast.key)}
            />
          ))}
          {waiting(queue) > 0 && (
            <span
              data-testid="toast-queued"
              className="pointer-events-auto rounded-full border border-line bg-[rgba(6,11,38,0.97)] px-2.5 py-0.5 text-[10.5px] text-muted"
            >
              {waiting(queue)} more
            </span>
          )}
        </div>
      )}
    </Ctx.Provider>
  );
}

const TONE: Record<ToastVariant, string> = {
  success: "text-pos",
  error: "text-[#FFB3C2]",
  info: "text-ink",
  undoable: "text-ink",
};

function ToastRow({
  toast,
  onUndo,
  onDismiss,
}: {
  toast: QueuedToast;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const message = toast.refusal ?? toast.message;
  return (
    <div
      role="status"
      data-testid="toast"
      data-variant={toast.refusal ? "error" : toast.variant}
      className="pointer-events-auto flex max-w-[min(92vw,30rem)] items-center gap-3 rounded-card border border-line bg-[rgba(6,11,38,0.97)] px-4 py-2.5 shadow-glow-lg backdrop-blur"
    >
      <span className={`text-[12.5px] ${toast.refusal ? TONE.error : TONE[toast.variant]}`}>
        {message}
      </span>

      {toast.variant === "undoable" && !toast.refusal && (
        <>
          <button
            type="button"
            data-testid="undo-button"
            disabled={toast.busy}
            onClick={onUndo}
            className="shrink-0 rounded-[8px] border border-accent bg-accent-soft px-2.5 py-1 text-[12px] font-semibold text-[#E4D3FF] disabled:opacity-60"
          >
            {toast.busy ? "Undoing…" : "Undo"}
          </button>
          <span
            data-testid="undo-countdown"
            className="w-4 shrink-0 text-right text-[11px] tabular-nums text-muted"
          >
            {toast.remaining}
          </span>
        </>
      )}

      <button
        type="button"
        aria-label="Dismiss"
        data-testid="toast-dismiss"
        onClick={onDismiss}
        className="shrink-0 text-muted hover:text-ink"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Toasts from anywhere inside the shell.
 *
 * Returns no-ops outside the provider rather than throwing: a component may
 * render in a context with no toast host — a public page, a test harness — and
 * a lost message is a far better failure than a crash.
 */
export function useToast(): ToastApi {
  return (
    useContext(Ctx) ?? {
      show: () => {},
      success: () => {},
      error: () => {},
      info: () => {},
      offerUndo: () => {},
    }
  );
}
