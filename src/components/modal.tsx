"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Shared dialog shell. Lives here rather than inside a single screen so any
 * component — including ones the top bar opens — can use the same chrome.
 *
 * Escape closes, background scroll is locked while open.
 *
 * ── FOCUS (playbook-v5 P16/4) ───────────────────────────────────────────────
 *
 * This carried `role="dialog"` and `aria-modal="true"` while doing none of
 * what those attributes promise. `aria-modal` tells assistive tech "nothing
 * outside this matters", so a screen reader stops announcing the page behind
 * it — but Tab still walked straight out into that page, and closing the
 * dialog dropped focus back to the top of the document. Both are worse than
 * having no dialog semantics at all, because the attribute makes the promise.
 *
 * So, three things now happen:
 *   - FOCUS MOVES IN on open, to the first control, or to the dialog itself
 *     when it holds none (a confirmation with only text);
 *   - TAB IS TRAPPED, cycling within the dialog in both directions;
 *   - FOCUS IS RESTORED to whatever opened it on close, so a person who
 *     pressed a button, read a dialog and dismissed it is back on the button
 *     rather than at the top of the page.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function Modal({
  children,
  onClose,
  labelledBy,
  wide = false,
}: {
  children: ReactNode;
  onClose?: () => void;
  labelledBy?: string;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!onClose) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose!();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  /** Move focus in, and put it back where it came from afterwards. */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus();
    return () => {
      // Only if the opener is still on the page — a dialog that deleted the
      // row it was opened from has nothing to go back to.
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  /** Trap Tab inside the dialog, in both directions. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const node = dialog.current;
      if (!node) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        // Nothing to move between; keep focus on the dialog rather than
        // letting Tab escape into the page behind it.
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!node.contains(document.activeElement)) {
        // Focus started outside (a click on the backdrop, say).
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center overflow-y-auto bg-black/50 p-4"
      onMouseDown={(e) => {
        // Only a click on the backdrop itself closes — not one that started
        // inside the dialog and drifted out (text selection).
        if (onClose && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        data-testid="modal"
        className={`w-full ${wide ? "max-w-[860px]" : "max-w-[560px]"} rounded-card border border-line bg-[rgba(6,11,38,0.98)] p-5 outline-none backdrop-blur`}
      >
        {children}
      </div>
    </div>
  );
}
