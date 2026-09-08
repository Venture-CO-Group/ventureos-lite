"use client";

import { useEffect, useState } from "react";
import {
  getScreenshotComparison,
  type ScreenshotComparison,
} from "@/modules/audit/actions";

/**
 * The same site, then and now.
 *
 * ── WHY THIS EARNS ITS SPACE ────────────────────────────────────────────────
 *
 * Every audit already stores a desktop and a mobile capture, and the delta
 * already knows which run this one is measured against. Nothing new is
 * collected here — this is only the view, and it is the most persuasive thing
 * the module can put in front of a prospect: a number moving from 46 to 31 is
 * an argument, two pictures is a fact.
 *
 * It renders nothing at all when there is nothing honest to show. A first
 * audit has no previous run; a previous run whose captures failed has no
 * picture. An empty box beside a real screenshot reads as "your site broke",
 * and that is a claim we would be inventing.
 */
function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("hu-HU");
}

export function ScreenshotCompare({ auditId }: { auditId: string }) {
  const [data, setData] = useState<ScreenshotComparison | null>(null);
  const [view, setView] = useState<"desktop" | "mobile">("desktop");
  const [split, setSplit] = useState(50);

  useEffect(() => {
    let active = true;
    getScreenshotComparison(auditId)
      .then((d) => {
        if (!active) return;
        setData(d);
        // Show whichever pairing actually exists rather than defaulting to
        // desktop and rendering a gap.
        if (d && !(d.before.desktop && d.after.desktop)) setView("mobile");
      })
      .catch(() => {
        /* an extra; never break the report over it */
      });
    return () => {
      active = false;
    };
  }, [auditId]);

  if (!data) return null;

  const before = data.before[view];
  const after = data.after[view];
  if (!before || !after) return null;

  const improved = data.scoreTo < data.scoreFrom;
  const bothPairs =
    !!(data.before.desktop && data.after.desktop) &&
    !!(data.before.mobile && data.after.mobile);

  return (
    <div
      data-testid="screenshot-compare"
      className="mt-3.5 rounded-card border border-line bg-panel p-[18px]"
    >
      <div className="mb-2.5 flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Then and now
        </span>
        <span className="text-[11.5px] text-muted">
          {ago(data.previousAt)} → {ago(data.currentAt)}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            improved
              ? "bg-[rgba(61,220,151,0.15)] text-[#3DDC97]"
              : data.scoreTo > data.scoreFrom
                ? "bg-[rgba(255,92,122,0.15)] text-[#FF5C7A]"
                : "bg-panel-2 text-muted"
          }`}
        >
          {data.scoreFrom} → {data.scoreTo}
        </span>

        {bothPairs && (
          <div className="ml-auto flex rounded-[9px] border border-line bg-panel-2 p-0.5">
            {(["desktop", "mobile"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                data-testid={`compare-${v}`}
                className={`rounded-[7px] px-2.5 py-1 text-[11.5px] capitalize ${
                  view === v ? "bg-panel text-ink" : "text-muted hover:text-ink"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        )}
      </div>

      {/*
        A wipe rather than two thumbnails side by side.

        Two small images make the reader do the comparison; a slider makes the
        difference land in one gesture, and at this width two shrunken captures
        of the same page are nearly indistinguishable anyway.
      */}
      <div
        className="relative overflow-hidden rounded-[10px] border border-line bg-panel-2"
        style={{ aspectRatio: view === "desktop" ? "16 / 10" : "9 / 16", maxHeight: 460 }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- session-authenticated
            blob behind /api/files; next/image's loader would drop the cookie */}
        <img
          src={`/api/files/${after}`}
          alt="Now"
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
        <div
          className="absolute inset-y-0 left-0 overflow-hidden"
          style={{ width: `${split}%` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- as above */}
          <img
            src={`/api/files/${before}`}
            alt="Before"
            data-testid="compare-before"
            className="absolute inset-0 h-full object-cover object-top"
            style={{ width: `${10000 / Math.max(1, split)}%`, maxWidth: "none" }}
          />
        </div>

        <div
          aria-hidden
          className="absolute inset-y-0 w-px bg-accent shadow-glow"
          style={{ left: `${split}%` }}
        />
        <span className="absolute left-2 top-2 rounded-full bg-[rgba(0,5,29,0.75)] px-2 py-0.5 text-[10px] font-semibold text-muted">
          {ago(data.previousAt)}
        </span>
        <span className="absolute right-2 top-2 rounded-full bg-[rgba(0,5,29,0.75)] px-2 py-0.5 text-[10px] font-semibold text-ink">
          now
        </span>
      </div>

      <input
        type="range"
        min={0}
        max={100}
        value={split}
        onChange={(e) => setSplit(Number(e.target.value))}
        aria-label="Compare before and after"
        data-testid="compare-slider"
        className="mt-2 w-full accent-accent"
        style={{ accentColor: "#7427C6" }}
      />

      <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted">
        <a
          href={`/api/files/${before}`}
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-ink"
        >
          Open the older capture
        </a>
        <a
          href={`/api/files/${after}`}
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-ink"
        >
          Open the current one
        </a>
      </div>
    </div>
  );
}
