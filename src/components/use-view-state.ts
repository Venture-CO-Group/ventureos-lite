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
      /**
       * THE ADDRESS BAR FIRST, THEN THE STATE. The order matters.
       *
       * It was the other way round, for a reason that turned out not to
       * apply: a control bound to an ASYNC navigation does not move when you
       * click it. But `pushState` is synchronous — the value is applied in the
       * same tick either way — and doing it second cost a whole feature.
       *
       * Opening a detail panel is a state change that MOUNTS a component,
       * and that component immediately fetches what it is about. Next treats
       * a `pushState` as a navigation and aborts the Server Action already in
       * flight; the aborted call neither resolves nor rejects, so the panel
       * sat on "Loading…" for ever. It reproduced every time in a browser and
       * showed up in the suite as three specs that were "flaky" — they only
       * passed when the fetch happened to beat the push.
       *
       * Pushing first means the navigation is over before anything mounts.
       */
      const query = viewQuery(schema, patch, window.location.search);
      const href = `${pathname}${query}`;
      /**
       * The CURRENT history state is handed back, not `null`.
       *
       * Next patches these two methods to watch for URL changes, and a `null`
       * state tells it this is a new place: on a `force-dynamic` page it then
       * refetches the route — and that navigation ABORTS the Server Actions
       * already in flight. Which is how ticking a checkbox was fine and
       * OPENING A DETAIL PANEL was not: the panel mounts and immediately asks
       * for what it is about, three calls at once, and Next cancelled two of
       * them. The aborted calls neither resolve nor reject, so the panel sat
       * on "Loading…" for ever.
       *
       * Passing `window.history.state` through says "same tree, different
       * address", which is exactly what a view parameter is.
       */
      const state = window.history.state;
      if (historyModeFor(schema, patch) === "push") {
        window.history.pushState(state, "", href);
      } else {
        window.history.replaceState(state, "", href);
      }

      setValue((current) => ({ ...current, ...patch }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pathname],
  );

  return [value, update];
}
