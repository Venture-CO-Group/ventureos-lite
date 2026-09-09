"use client";

import { useEffect, useMemo, useState } from "react";
import {
  listUnmatchedThreads,
  linkThreadToLead,
  type UnmatchedThreadView,
} from "@/modules/email/thread-actions";
import { BulkBar, type BulkAction } from "./bulk-bar";
import { useBulkSelection } from "./use-bulk-selection";
import { bulkThreadsArchive, bulkThreadsLink, bulkThreadsRead } from "@/modules/inbox/bulk-actions";

/**
 * Correspondence we synced but could not place (playbook-v2 P2a).
 *
 * These are threads with someone whose address matched a lead or company
 * domain, but where the specific person is not on a lead — a colleague of a
 * contact, a second address, a forwarded introduction.
 *
 * Linking one teaches the matcher permanently, which is why this queue should
 * shrink over time rather than becoming a permanent chore. The count going UP
 * week after week is the signal that the matching rules need attention, not
 * that someone needs to click more.
 */
export function UnmatchedThreads({
  leads,
}: {
  leads: Array<{ id: string; name: string }>;
}) {
  const [threads, setThreads] = useState<UnmatchedThreadView[] | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Bulk actions on the unmatched queue (playbook-v5 P17/1).
   *
   * This queue is where thread bulk actions belong: the inbox's left-hand list
   * is keyed by LEAD, so it has no thread ids to act on, while every row here
   * is an EmailThread. Linking twenty forwarded introductions to one lead —
   * or putting away a batch that will never be placed — is exactly the work
   * that was one-at-a-time.
   *
   * A thread already pointing at a DIFFERENT lead is skipped rather than
   * relinked: moving correspondence to another company is a decision, not
   * something a bulk action should do quietly.
   */
  const selection = useBulkSelection(threads?.length ?? 0);
  const bulkActions = useMemo<BulkAction<unknown>[]>(
    () => [
      {
        key: "link",
        label: "Link to lead",
        noun: "thread",
        verb: "linked",
        initial: "" as unknown,
        validate: (state) => (String(state ?? "") ? null : "Choose a lead."),
        form: (state, set) => (
          <select
            aria-label="Lead"
            data-testid="bulk-link-value"
            value={String(state ?? "")}
            onChange={(e) => set(e.target.value)}
            className="min-w-[160px] rounded-[8px] border border-line bg-[rgba(0,5,29,0.6)] px-2 py-1 text-[12px] text-ink outline-none"
          >
            <option value="">Choose…</option>
            {leads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        ),
        run: (ids, state) => bulkThreadsLink(ids, String(state ?? "")),
      },
      {
        key: "read",
        label: "Mark read",
        noun: "thread",
        verb: "marked read",
        run: (ids) => bulkThreadsRead(ids, false),
      },
      {
        key: "archive",
        label: "Archive",
        noun: "thread",
        verb: "archived",
        run: (ids) => bulkThreadsArchive(ids, true),
      },
    ],
    [leads],
  );

  async function refresh() {
    setThreads(await listUnmatchedThreads());
  }

  useEffect(() => {
    let active = true;
    listUnmatchedThreads().then((t) => {
      if (active) setThreads(t);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!threads || threads.length === 0) return null;

  return (
    <div className="mb-4 rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Unmatched email
        </span>
        <span className="text-[11px] text-muted">
          {threads.length} conversation{threads.length > 1 ? "s" : ""} we could not place
        </span>
      </div>
      <p className="mb-3 max-w-prose text-[11.5px] leading-relaxed text-muted">
        Linking one of these also remembers the address, so the next message from the
        same person lands on the right lead by itself.
      </p>

      <BulkBar
        selection={selection}
        actions={bulkActions}
        onDone={() => void refresh()}
      />

      <div className="space-y-2">
        {threads.map((t) => (
          <div key={t.id} className="rounded-[10px] border border-line bg-panel-2 p-3">
            <div className="flex flex-wrap items-baseline gap-2 text-[12.5px]">
              <input
                type="checkbox"
                checked={selection.isSelected(t.id)}
                onChange={() => selection.toggle(t.id)}
                data-testid="thread-select"
                aria-label={`Select ${t.subject || "this thread"}`}
                style={{ accentColor: "#7427C6" }}
                className="flex-none"
              />
              <span className="font-semibold">{t.subject || "(no subject)"}</span>
              <span className="text-[11.5px] text-muted">{t.participants.join(", ")}</span>
              <span className="ml-auto text-[11px] text-muted">
                {new Date(t.lastMessageAt).toLocaleDateString("hu-HU")}
              </span>
            </div>
            {t.snippet && (
              <p className="mt-1 line-clamp-2 text-[12px] text-muted">{t.snippet}</p>
            )}
            <div className="mt-2.5 flex flex-wrap gap-2">
              <select
                value={choice[t.id] ?? ""}
                onChange={(e) => setChoice({ ...choice, [t.id]: e.target.value })}
                className="min-w-[180px] rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
              >
                <option value="">Link to a lead…</option>
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <button
                onClick={async () => {
                  const leadId = choice[t.id];
                  if (!leadId) return;
                  setBusy(t.id);
                  const res = await linkThreadToLead({ threadId: t.id, leadId });
                  setNotice(
                    `Linked — ${res.learned} address${res.learned === 1 ? "" : "es"} remembered.`,
                  );
                  await refresh();
                  setBusy(null);
                }}
                disabled={busy === t.id || !choice[t.id]}
                className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] font-semibold hover:border-accent disabled:opacity-60"
              >
                Link
              </button>
            </div>
          </div>
        ))}
      </div>

      {notice && <p className="mt-2 text-[11.5px] text-muted">{notice}</p>}
    </div>
  );
}
