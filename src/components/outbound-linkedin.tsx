"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import { openInStudio } from "@/modules/outbound/approval-actions";
import type { LinkedInCard } from "@/modules/outbound/queue-view";

/**
 * The LinkedIn queue (playbook-v6 F4/3): companies with no usable address,
 * or routed here by the reviewer. Manual outreach only, under the Outreach
 * Studio's own unchanged rules — opening one hands it to the Studio as a lead,
 * where the draft must be edited by a person before it can be marked sent.
 */
export function OutboundLinkedIn({ cards }: { cards: LinkedInCard[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (cards.length === 0) {
    return <p className="rounded-card border border-line bg-panel p-6 text-[13px] text-muted">The LinkedIn queue is empty.</p>;
  }
  return (
    <div className="grid gap-2" data-testid="linkedin-queue">
      {error && <p className="text-[12px] text-[#FFB3C2]">{error}</p>}
      {cards.map((c) => (
        <div key={c.candidateId} className="grid gap-2 rounded-card border border-line bg-panel p-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <b className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{c.company}</b>
            <span className="text-[11.5px] text-muted">{c.product}</span>
          </div>
          <span className="text-[12px]">
            {c.managerName ? <>Search for <b className="text-ink">{c.managerName}</b></> : "No manager name on record"}
            {c.website ? ` · ${c.website}` : ""}
          </span>
          <p className="rounded-[10px] border border-line p-2.5 text-[12.5px] text-muted">{c.opener}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="min-h-[44px] rounded-[9px] border border-line px-3 py-2 text-[12.5px] font-semibold text-ink hover:border-accent"
              onClick={async () => {
                await navigator.clipboard.writeText(c.opener).catch(() => {});
                setCopied(c.candidateId);
                window.open(c.searchUrl, "_blank", "noopener");
              }}
            >
              {copied === c.candidateId ? "Copied — LinkedIn opened" : "Copy & open LinkedIn"}
            </button>
            <button
              type="button"
              disabled={pending}
              className="min-h-[44px] rounded-[9px] border border-line px-3 py-2 text-[12.5px] font-semibold text-ink hover:border-accent disabled:opacity-45"
              onClick={() =>
                startTransition(async () => {
                  const res = await attempt(openInStudio(c.candidateId));
                  if (!res.ok) setError(res.error);
                  else router.push(`/outreach?lead=${res.leadId}`);
                })
              }
            >
              {c.leadId ? "Open in Outreach Studio" : "Draft in Outreach Studio"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
