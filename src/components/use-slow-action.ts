"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Progress, but only for actions that are actually slow (playbook-v5 P16/2).
 *
 * ── WHY A THRESHOLD ─────────────────────────────────────────────────────────
 *
 * The rule is that anything over 400ms shows progress on the control that
 * started it. The unstated half is that anything UNDER 400ms must show
 * nothing: a "Saving…" label that appears and vanishes in 80ms is a flash, and
 * a table where every cell commit flickers is worse than one that looks
 * instant. So `slow` only turns true if the promise has not settled by then.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 *
 * Not a global overlay, which the playbook rules out and this codebase never
 * had — 86 components already carry their own in-place pending state. This is
 * the timing, so they stop flashing.
 */
export const SLOW_ACTION_MS = 400;

export function useSlowAction(thresholdMs: number = SLOW_ACTION_MS) {
  const [slow, setSlow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setSlow(true), thresholdMs);
      try {
        return await fn();
      } finally {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        setSlow(false);
      }
    },
    [thresholdMs],
  );

  return { slow, run };
}
