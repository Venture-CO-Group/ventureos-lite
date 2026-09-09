"use client";

import { useEffect, useState } from "react";

/**
 * Does this person want motion? (playbook-v5 P16/4)
 *
 * ── WHY A HOOK WHEN THE CSS ALREADY HANDLES IT ──────────────────────────────
 *
 * globals.css carries a blanket `prefers-reduced-motion` rule that kills every
 * animation and transition, and that covers everything CSS drives. What it
 * cannot reach is motion decided in JAVASCRIPT: a card that animates to a new
 * column by interpolating positions, a count that ticks up, a scroll that
 * eases. Those need to ask, not to be styled.
 *
 * ── STARTING FALSE, DELIBERATELY ────────────────────────────────────────────
 *
 * The server cannot know the preference, so the first render has to pick one.
 * It picks "motion is fine" and corrects on mount, because the alternative —
 * assuming reduced — would make every animation in the product flash on for
 * everyone after hydration. A person who asked for less motion gets it one
 * frame late; nobody gets a wrong animation that then plays.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

/** Milliseconds, or zero when motion is unwanted. For JS-driven timing. */
export function useMotionDuration(ms: number): number {
  return useReducedMotion() ? 0 : ms;
}
