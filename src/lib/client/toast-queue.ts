/**
 * The toast queue, as pure functions (playbook-v5 P16/3).
 *
 * ── WHY NOT JUST useState IN THE COMPONENT ──────────────────────────────────
 *
 * The rules that matter here are small and easy to get subtly wrong: at most
 * three visible, a fourth waiting rather than displacing the first, only the
 * VISIBLE ones counting down, a hover pausing every countdown including the
 * undo window, and a busy toast never expiring from under the request it is
 * waiting on. Each of those is one line of reducer and one line of test.
 *
 * Proving them through a browser would mean waiting real seconds for a real
 * timer, which is how a suite gets slow and flaky. So the reducer lives here
 * and `toast.tsx` is the thin part that owns the interval and the markup.
 */

export type ToastVariant = "success" | "error" | "info" | "undoable";

export interface QueuedToast {
  key: number;
  variant: ToastVariant;
  message: string;
  undo?: { id: string; label: string } | null;
  /** Seconds left, counted down only while visible and not paused. */
  remaining: number;
  /** Set when an undo was declined; shown in place of the offer. */
  refusal?: string;
  /** An in-flight undo. It must not expire from under the request. */
  busy?: boolean;
}

export const MAX_VISIBLE = 3;
/** Ordinary toasts dwell five seconds; an undo offer gets six. */
export const DWELL_SECONDS = 5;
export const UNDO_SECONDS = 6;

export function secondsFor(variant: ToastVariant, ms?: number): number {
  if (variant === "undoable") return UNDO_SECONDS;
  return ms === undefined ? DWELL_SECONDS : Math.max(1, Math.ceil(ms / 1000));
}

/** The ones on screen. The rest are waiting their turn, not lost. */
export function visible(queue: QueuedToast[]): QueuedToast[] {
  return queue.slice(0, MAX_VISIBLE);
}

/** How many are waiting off screen, for the "N more" pill. */
export function waiting(queue: QueuedToast[]): number {
  return Math.max(0, queue.length - MAX_VISIBLE);
}

/**
 * One second passes.
 *
 * Only the visible ones age. A queued toast that burned its dwell while off
 * screen would appear and vanish in the same frame — the bug this rule exists
 * to prevent, and the reason a burst from a bulk action stays readable.
 */
export function tick(queue: QueuedToast[]): QueuedToast[] {
  const out: QueuedToast[] = [];
  queue.forEach((toast, index) => {
    if (index >= MAX_VISIBLE || toast.busy) {
      out.push(toast);
      return;
    }
    const remaining = toast.remaining - 1;
    if (remaining > 0) out.push({ ...toast, remaining });
  });
  return out;
}

export function dismiss(queue: QueuedToast[], key: number): QueuedToast[] {
  return queue.filter((t) => t.key !== key);
}

export function markBusy(queue: QueuedToast[], key: number, busy: boolean): QueuedToast[] {
  return queue.map((t) => (t.key === key ? { ...t, busy } : t));
}

/**
 * An undo the server declined.
 *
 * The refusal replaces the offer and the toast becomes an error that dwells
 * long enough to read — "someone else changed this" is exactly what a person
 * needs before they go looking for their edit, and it must not disappear in
 * the second that is left of a six-second countdown.
 */
export function refuse(queue: QueuedToast[], key: number, reason: string): QueuedToast[] {
  return queue.map((t) =>
    t.key === key
      ? { ...t, busy: false, refusal: reason, variant: "error" as const, remaining: UNDO_SECONDS }
      : t,
  );
}

/** What the single aria-live region says. */
export function announcement(queue: QueuedToast[]): string {
  return visible(queue)
    .map((t) => t.refusal ?? t.message)
    .join(". ");
}
