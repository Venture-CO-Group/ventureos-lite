"use client";

import { useEffect, useState } from "react";
import { isFavourited, noteOpened, toggleFavouriteAction } from "@/modules/pins/actions";
import { attempt } from "@/lib/client/server-action";

/**
 * The star on an entity header (playbook-v5 P17/2).
 *
 * ── IT ALSO RECORDS THE VISIT ───────────────────────────────────────────────
 *
 * Mounting this component means somebody is looking at the thing, which is
 * exactly the moment a "recent" is true. Doing it here rather than in the page
 * keeps the recording OFF THE RENDER PATH — the playbook's requirement — and
 * means every surface that wants shortcuts gets them by adding one control
 * rather than by remembering to call something.
 *
 * Nothing awaits the write. A lost recent is a shortcut that did not appear,
 * which is nothing beside a slower lead page.
 */
export function StarToggle({
  entityType,
  entityId,
  label,
  href,
  className = "",
}: {
  entityType: string;
  entityId: string;
  label: string;
  /** Relative, and where the star should take somebody back to. */
  href: string;
  className?: string;
}) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    // Fire and forget, deliberately.
    void noteOpened({ entityType, entityId, label, href });
    isFavourited(entityType, entityId)
      .then((v) => live && setOn(v))
      .catch(() => live && setOn(false));
    return () => {
      live = false;
    };
  }, [entityType, entityId, label, href]);

  return (
    <button
      type="button"
      data-testid="star-toggle"
      data-on={on === true ? "true" : "false"}
      aria-pressed={on === true}
      aria-label={on ? `Remove ${label} from favourites` : `Add ${label} to favourites`}
      title={on ? "In your favourites" : "Add to favourites"}
      disabled={busy || on === null}
      onClick={async () => {
        setBusy(true);
        // Optimistic, then corrected — the cap can refuse a new favourite.
        const next = !on;
        setOn(next);
        const res = await attempt(
          toggleFavouriteAction({ entityType, entityId, label, href }),
        );
        setBusy(false);
        if (!res.ok) {
          setOn(!next);
          return;
        }
        setOn(res.favourite);
      }}
      className={`rounded-[6px] px-1 text-[14px] leading-none transition-colors disabled:opacity-40 ${
        on ? "text-warn" : "text-muted hover:text-ink"
      } ${className}`}
    >
      {on ? "★" : "☆"}
    </button>
  );
}
