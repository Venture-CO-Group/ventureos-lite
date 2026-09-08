"use client";

import { useState } from "react";
import type { CrawlResult } from "@/modules/audit/types";
import { analyzeStructure } from "@/modules/audit/structure";

/**
 * Per-page crawl detail for the internal audit view (P2/1).
 *
 * The Site structure category above already carries the verdicts; this is the
 * evidence, one expandable row per page, because "duplicate titles" is only
 * useful in a sales conversation when you can say which pages.
 */
function kb(bytes: number): string {
  return bytes > 0 ? `${Math.round(bytes / 1000)} KB` : "—";
}

export function SiteStructure({ crawl }: { crawl: CrawlResult }) {
  const [open, setOpen] = useState<string | null>(null);
  const { rows, orphans } = analyzeStructure(crawl);

  if (rows.length === 0) return null;

  return (
    <div className="mt-3.5 rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Site structure
        </span>
        <span className="text-[11px] text-muted">
          {crawl.pages.length} of {crawl.discovered} pages · {crawl.brokenLinks.length} broken
          links · {(crawl.elapsedMs / 1000).toFixed(0)}s
          {crawl.mode
            ? crawl.mode === "rendered"
              ? " · rendered in a browser (JS-heavy site)"
              : " · static crawl"
            : ""}
          {crawl.deadlineHit ? " · stopped on time budget" : ""}
          {crawl.robotsSkipped > 0 ? ` · ${crawl.robotsSkipped} skipped per robots.txt` : ""}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-line text-[10px] uppercase tracking-[0.08em] text-muted">
              <th className="py-1.5 pr-3 text-left font-semibold">Page</th>
              <th className="py-1.5 pr-3 text-right font-semibold">Status</th>
              <th className="py-1.5 pr-3 text-right font-semibold tabular-nums">HTML</th>
              <th className="py-1.5 text-left font-semibold">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const notes: string[] = [];
              if (r.titleDuplicate) notes.push("duplicate title");
              if (r.metaDuplicate) notes.push("duplicate meta");
              if (!r.title) notes.push("no title");
              if (r.h1Count !== 1) notes.push(r.h1Count === 0 ? "no H1" : `${r.h1Count} H1s`);
              if (r.redirects.length >= 2) notes.push(`${r.redirects.length} redirects`);
              if (r.brokenLinksOut > 0) notes.push(`${r.brokenLinksOut} broken links`);
              if (r.weightOutlier) notes.push("heavy page");
              const bad = r.status === null || r.status >= 400;
              const isOpen = open === r.url;
              return (
                <tr
                  key={r.url}
                  onClick={() => setOpen(isOpen ? null : r.url)}
                  className="cursor-pointer border-b border-[rgba(239,241,248,0.05)] align-top hover:bg-panel-2"
                >
                  <td className="py-1.5 pr-3">
                    <div className="truncate text-[#C9CEE3]" title={r.url}>
                      {r.path}
                    </div>
                    {isOpen && (
                      <div className="mt-1 space-y-0.5 text-[11px] text-muted">
                        <div>title: {r.title ?? "—"}</div>
                        <div>meta: {r.metaDescription ?? "—"}</div>
                        {r.redirects.length > 0 && (
                          <div>redirects: {r.redirects.join(" → ")} → {r.url}</div>
                        )}
                        {r.deep?.a11y && (
                          <div>
                            axe: {r.deep.a11y.critical} critical, {r.deep.a11y.serious} serious
                          </div>
                        )}
                        {r.deep?.mixedContent && <div>mixed content on this page</div>}
                      </div>
                    )}
                  </td>
                  <td
                    className={`py-1.5 pr-3 text-right tabular-nums ${
                      bad ? "text-[#FF5C7A]" : "text-muted"
                    }`}
                  >
                    {r.status ?? "err"}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-muted">{kb(r.bytes)}</td>
                  <td className="py-1.5 text-[11.5px] text-muted">{notes.join(", ") || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {crawl.brokenLinks.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Broken internal links
          </div>
          <div className="space-y-0.5 text-[11.5px] text-[#C9CEE3]">
            {crawl.brokenLinks.slice(0, 20).map((b, i) => (
              <div key={`${b.from}-${b.to}-${i}`} className="truncate">
                <span className="text-muted">{b.from.replace(/^https?:\/\/[^/]+/, "")}</span> →{" "}
                {b.to.replace(/^https?:\/\/[^/]+/, "")}{" "}
                <span className="text-[#FF5C7A]">{b.status ?? "unreachable"}</span>
              </div>
            ))}
            {crawl.brokenLinks.length > 20 && (
              <div className="text-muted">+{crawl.brokenLinks.length - 20} more</div>
            )}
          </div>
        </div>
      )}

      {orphans.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            In the sitemap, nothing links to them
          </div>
          <div className="space-y-0.5 text-[11.5px] text-[#C9CEE3]">
            {orphans.slice(0, 10).map((u) => (
              <div key={u} className="truncate">
                {u.replace(/^https?:\/\/[^/]+/, "")}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
