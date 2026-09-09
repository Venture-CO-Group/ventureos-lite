"use client";

import { useCallback, useMemo, useState } from "react";

/**
 * What is selected, on any surface (playbook-v5 P17/1).
 *
 * ── SELECT-ALL-MATCHING IS NOT "TICK EVERY ROW ON THE PAGE" ─────────────────
 *
 * The two are different intentions and the difference matters at scale: with
 * 400 leads behind a filter, ticking the visible 50 and pressing "change
 * stage" should change 50, and asking for all 400 should change 400 — without
 * paging through eight screens to say so. So the selection has TWO modes, and
 * `allMatching` is a claim about the filter rather than a list of ids. The ids
 * are resolved on the server at the moment the action runs, which is also the
 * only way the count can be right if somebody else added a row meanwhile.
 */
export interface BulkSelection {
  /** Explicitly ticked ids. Ignored while `allMatching` is true. */
  ids: string[];
  /** True when the intention is "everything the current filter matches". */
  allMatching: boolean;
  /** How many rows the action would touch. */
  count: number;
  /** Nothing is selected. */
  empty: boolean;
  toggle: (id: string) => void;
  /** Tick or untick every row currently on screen. */
  setPage: (pageIds: string[], on: boolean) => void;
  /** Escalate from "this page" to "everything matching". */
  selectAllMatching: () => void;
  clear: () => void;
  /** Whether offering the escalation makes sense right now. */
  canOfferAllMatching: (pageIds: string[]) => boolean;
  isSelected: (id: string) => boolean;
}

export function useBulkSelection(matchingTotal: number): BulkSelection {
  const [ids, setIds] = useState<string[]>([]);
  const [allMatching, setAllMatching] = useState(false);
  const selected = useMemo(() => new Set(ids), [ids]);

  const toggle = useCallback((id: string) => {
    // Ticking a row is a statement about rows, so it drops the "everything"
    // claim rather than silently keeping it.
    setAllMatching(false);
    setIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  }, []);

  const setPage = useCallback((pageIds: string[], on: boolean) => {
    setAllMatching(false);
    setIds((current) => {
      if (!on) return current.filter((id) => !pageIds.includes(id));
      return [...new Set([...current, ...pageIds])];
    });
  }, []);

  const clear = useCallback(() => {
    setIds([]);
    setAllMatching(false);
  }, []);

  return {
    ids,
    allMatching,
    count: allMatching ? matchingTotal : ids.length,
    empty: allMatching ? matchingTotal === 0 : ids.length === 0,
    toggle,
    setPage,
    selectAllMatching: () => setAllMatching(true),
    clear,
    /**
     * Offered only when every row on screen is ticked AND there is more behind
     * the filter. Offering it earlier is noise; offering it when the page IS
     * everything is a lie.
     */
    canOfferAllMatching: (pageIds) =>
      !allMatching &&
      pageIds.length > 0 &&
      pageIds.every((id) => selected.has(id)) &&
      matchingTotal > pageIds.length,
    isSelected: (id) => allMatching || selected.has(id),
  };
}
