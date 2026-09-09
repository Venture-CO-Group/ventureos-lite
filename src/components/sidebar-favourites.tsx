"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { reorderFavourite, toggleFavouriteAction } from "@/modules/pins/actions";
import { positionBetween } from "@/modules/pins/logic";
import { attempt } from "@/lib/client/server-action";

export interface FavouriteRow {
  entityType: string;
  entityId: string;
  label: string;
  href: string;
  position: number;
}

/**
 * The sidebar's Favourites section (playbook-v5 P17/2).
 *
 * ── COLLAPSIBLE, AND ABSENT WHEN EMPTY ──────────────────────────────────────
 *
 * A heading over nothing is a permanent reminder that a feature exists and you
 * are not using it. So the section only appears once something is starred, and
 * folds away for somebody who has starred thirty things and wants their nav
 * back. The open/closed state is per browser — this one genuinely is a
 * property of the window rather than the account.
 *
 * ── DRAG TO REORDER, WITH SPARSE POSITIONS ──────────────────────────────────
 *
 * Dropping a favourite between two others is one write, because positions are
 * spaced by 1024 — the same trick the task board's columns use. When the gap
 * closes the server renumbers; that is the rare case, not the common one.
 */
export function SidebarFavourites({ favourites }: { favourites: FavouriteRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [dragId, setDragId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (favourites.length === 0) return null;

  async function drop(targetIndex: number) {
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const moving = favourites.find((f) => f.entityId === id);
    if (!moving) return;
    const without = favourites.filter((f) => f.entityId !== id);
    const before = without[targetIndex - 1]?.position ?? null;
    const after = without[targetIndex]?.position ?? null;
    const position = positionBetween(before, after);
    if (position === null) return;
    // Through `attempt`: Next redacts anything thrown out of an action, so a
    // bare await would leave a failed reorder looking like a successful one.
    const res = await attempt(
      reorderFavourite({
        entityType: moving.entityType,
        entityId: moving.entityId,
        position,
      }),
    );
    if (!res.ok) setError(res.error);
    router.refresh();
  }

  return (
    <div data-testid="sidebar-favourites">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="favourites-toggle"
        className="flex w-full items-center gap-1 px-2.5 pb-1.5 pt-3.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted hover:text-ink"
      >
        <span className={`transition-transform ${open ? "" : "-rotate-90"}`}>▾</span>
        Favourites
        <span className="ml-auto tabular-nums opacity-60">{favourites.length}</span>
      </button>

      {error && (
        <p className="px-2.5 pb-1 text-[11px] text-[#FFB3C2]" role="status">
          {error}
        </p>
      )}

      {open && (
        <div className="grid gap-px">
          {favourites.map((f, i) => (
            <div
              key={`${f.entityType}:${f.entityId}`}
              draggable
              onDragStart={() => setDragId(f.entityId)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void drop(i);
              }}
              data-testid="favourite-row"
              className={`group flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[12.5px] text-[#C9CEE3] hover:bg-panel ${
                dragId === f.entityId ? "opacity-40" : ""
              }`}
            >
              <Link href={f.href} className="min-w-0 flex-1 truncate hover:text-ink">
                {f.label}
              </Link>
              <button
                type="button"
                aria-label={`Remove ${f.label} from favourites`}
                data-testid="favourite-remove"
                onClick={async () => {
                  const res = await attempt(
                    toggleFavouriteAction({
                      entityType: f.entityType,
                      entityId: f.entityId,
                      label: f.label,
                      href: f.href,
                    }),
                  );
                  if (!res.ok) setError(res.error);
                  router.refresh();
                }}
                className="flex-none text-[12px] text-warn opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
              >
                ★
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
