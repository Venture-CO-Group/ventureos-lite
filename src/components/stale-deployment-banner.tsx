"use client";

import { useEffect, useState } from "react";
import {
  STALE_DEPLOYMENT_EVENT,
  STALE_DEPLOYMENT_MESSAGE,
  isStaleDeployment,
} from "@/lib/client/server-action";

/**
 * "This page is older than the server" — said once, everywhere.
 *
 * Mounted in the root layout so it covers every screen, including the ones
 * whose handlers never learned to catch. It listens two ways:
 *
 *   - the event `serverActionError` fires when a caught error turns out to be
 *     a stale deployment, and
 *   - `unhandledrejection`, for the handlers that do not catch at all — which
 *     is exactly the case that used to be a silent, dead button.
 *
 * It never reloads on its own: somebody may be halfway through a form.
 */
export function StaleDeploymentBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const onStale = () => setStale(true);
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isStaleDeployment(e.reason)) setStale(true);
    };
    window.addEventListener(STALE_DEPLOYMENT_EVENT, onStale);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener(STALE_DEPLOYMENT_EVENT, onStale);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  if (!stale) return null;
  return (
    <div
      role="alert"
      data-testid="stale-deployment"
      className="fixed inset-x-0 top-0 z-[100] flex flex-wrap items-center justify-center gap-3 border-b border-line bg-[#140A2E] px-4 py-2.5 text-[12.5px] text-ink"
    >
      <span>{STALE_DEPLOYMENT_MESSAGE}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="min-h-[36px] rounded-[9px] border border-accent bg-accent-soft px-3 py-1.5 text-[12px] font-semibold text-[#E4D3FF]"
      >
        Reload
      </button>
    </div>
  );
}
