"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  decodeView,
  historyModeFor,
  viewQuery,
  type ViewSchema,
  type ViewValues,
} from "@/lib/client/view-state";

/**
 * One hook for every list and board surface (playbook-v5 P16/5).
 *
 * ── WHY THE NATIVE HISTORY API AND NOT router.push ──────────────────────────
 *
 * This is the part that took a failing test to find. Every page here is
 * `force-dynamic`, and its body now sits behind a `<Suspense>` (P16/2). So a
 * `router.push` to change one query parameter re-runs the SERVER render,
 * re-triggers the boundary, shows the skeleton and REMOUNTS the board — losing
 * its fetched state and its open dialog. Ticking "only mine" became a full
 * server round trip, and the task-board suite went intermittently red in three
 * different places because the component was being torn down mid-interaction.
 *
 * View state is client state that happens to be addressable. It has no
 * business asking the server to render anything, so the URL is updated with
 * `history.pushState`/`replaceState` — which Next 15 supports for exactly this
 * — and this hook keeps the values. First load still works from the server,
 * because the page reads `searchParams` itself and seeds the component.
 *
 * ── HOW BACK STILL WORKS ────────────────────────────────────────────────────
 *
 * `popstate`. Going back or forward re-reads the query string and re-decodes,
 * so Back closes an open card instead of leaving the page — which is the whole
 * point of putting it in the URL, and something a modal held in component
 * state can never do.
 *
 * ── AND WHY NOTHING SCROLLS ─────────────────────────────────────────────────
 *
 * Neither direction touches scroll, so opening the fortieth card in a list and
 * closing it leaves you looking at the fortieth card. `router.push` would have
 * reset to the top.
 */
export function useViewState<S extends ViewSchema>(
  schema: S,
): [ViewValues<S>, (patch: Partial<ViewValues<S>>) => void] {
  const pathname = usePathname();
  /**
   * Read ONCE, for the initial value.
   *
   * Via `useSearchParams` rather than `window.location`, because the server
   * renders this too: reading `window` would give the server an empty query
   * and the client the real one, so a deep link would hydrate into a different
   * view than it rendered. After that first read the hook owns the values and
   * updates the address bar directly — see above for why it must not navigate.
   */
  const initialSearch = useSearchParams().toString();
  const [value, setValue] = useState<ViewValues<S>>(() => decodeView(schema, initialSearch));

  useEffect(() => {
    function onPop() {
      setValue(decodeView(schema, window.location.search));
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // The schema is a module constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = useCallback(
    (patch: Partial<ViewValues<S>>) => {
      // Applied locally first: a control bound to an async navigation does not
      // move when you click it, which reads as broken.
      setValue((current) => ({ ...current, ...patch }));

      const query = viewQuery(schema, patch, window.location.search);
      const href = `${pathname}${query}`;
      if (historyModeFor(schema, patch) === "push") {
        window.history.pushState(null, "", href);
      } else {
        window.history.replaceState(null, "", href);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pathname],
  );

  return [value, update];
}
