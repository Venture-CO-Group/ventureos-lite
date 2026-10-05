"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import { bulkRestoreAction, cancelFollowupsAction } from "@/modules/outbound/history-actions";
import type { HistoryRow, HistoryTab } from "@/modules/outbound/history";
import { useToast } from "./toast";

/**
 * The outbound history table (tracking & recovery). Filtering and sorting
 * are URL state — a filtered view is a link, and Back works — while selection
 * and the two actions (bulk restore, cancelling follow-ups) live here.
 */
const BULK_MAX = 25;

function when(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "—";
}

export function OutboundHistoryTable({
  tab,
  rows,
  sortHrefs,
  sort,
  dir,
}: {
  tab: HistoryTab;
  rows: HistoryRow[];
  /** Precomputed: a server page cannot hand a function to a client component. */
  sortHrefs: Record<"decided" | "company" | "product", string>;
  sort: string;
  dir: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<string[]>([]);
  const restorable = tab === "rejected" || tab === "filtered";

  function bulkRestore() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (ids.length > BULK_MAX) {
      toast.error(`Restore at most ${BULK_MAX} at a time.`);
      return;
    }
    const note = window.prompt(
      `Restore ${ids.length} candidate${ids.length === 1 ? "" : "s"} to the approval queue? Each is re-checked (suppression, client, CRM, data freshness) and may be redrafted.\n\nOptional note:`,
      "",
    );
    if (note === null) return;
    startTransition(async () => {
      const res = await attempt(bulkRestoreAction({ candidateIds: ids, note: note || null }));
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const okCount = res.results.filter((r) => r.result.ok).length;
      const blocked = res.results.filter((r) => !r.result.ok);
      setReport(
        blocked.map((b) => {
          const row = rows.find((x) => x.candidateId === b.candidateId);
          return `${row?.company ?? b.candidateId}: ${b.result.ok ? "" : b.result.blockers.join(" ")}`;
        }),
      );
      toast.info(`${okCount} restored${blocked.length ? `, ${blocked.length} blocked — see the list` : ""}.`);
      setSelected(new Set());
      router.refresh();
    });
  }

  function cancelFollowups(id: string) {
    if (!window.confirm("Cancel the remaining follow-ups for this company? The lead is not touched.")) return;
    startTransition(async () => {
      const res = await attempt(cancelFollowupsAction(id));
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(`Follow-ups cancelled${res.cancelled ? ` (${res.cancelled} draft${res.cancelled === 1 ? "" : "s"})` : ""}.`);
        router.refresh();
      }
    });
  }

  const head = (key: "decided" | "company" | "product", label: string) => (
    <Link href={sortHrefs[key]} className="hover:text-ink" aria-sort={sort === key ? (dir === "asc" ? "ascending" : "descending") : undefined}>
      {label}
      {sort === key ? (dir === "asc" ? " ↑" : " ↓") : ""}
    </Link>
  );

  return (
    <div className="grid gap-2">
      {restorable && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending || selected.size === 0}
            onClick={bulkRestore}
            data-testid="bulk-restore"
            className="min-h-[40px] rounded-[9px] border border-line px-3 py-2 text-[12.5px] font-semibold text-ink hover:border-accent disabled:opacity-45"
          >
            Restore {selected.size || ""} to the queue
          </button>
          <span className="text-[11.5px] text-muted">Up to {BULK_MAX} at a time; each is re-checked first.</span>
        </div>
      )}
      {report.length > 0 && (
        <ul className="grid gap-0.5 rounded-[10px] border border-[#FFD27A] p-2.5 text-[12px] text-[#FFD27A]" data-testid="restore-blockers">
          {report.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <div className="overflow-x-auto rounded-card border border-line bg-panel">
        <table className="w-full min-w-[820px] text-[12px]" data-testid="history-table">
          <thead className="text-left text-[10.5px] uppercase tracking-[0.12em] text-muted">
            <tr>
              {restorable && (
                <th className="w-8 p-2.5">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={rows.length > 0 && rows.every((r) => selected.has(r.candidateId))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.candidateId)) : new Set())}
                  />
                </th>
              )}
              <th className="p-2.5">{head("company", "Company")}</th>
              <th className="p-2.5">Contact</th>
              <th className="p-2.5">{head("product", "Product")}</th>
              <th className="p-2.5">Campaign</th>
              <th className="p-2.5">{head("decided", tab === "pending" ? "Queued" : "Decided")}</th>
              <th className="p-2.5">By</th>
              <th className="p-2.5">{tab === "sent" || tab === "replied" ? "Follow-ups" : "Reason"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="p-4 text-muted">
                  Nothing here for these filters.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.candidateId} className="border-t border-line align-top hover:bg-[rgba(239,241,248,0.03)]">
                {restorable && (
                  <td className="p-2.5">
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.company}`}
                      checked={selected.has(r.candidateId)}
                      onChange={(e) =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(r.candidateId);
                          else n.delete(r.candidateId);
                          return n;
                        })
                      }
                    />
                  </td>
                )}
                <td className="p-2.5">
                  <Link href={`/outbound/history/${r.candidateId}`} className="font-semibold text-ink hover:underline">
                    {r.company}
                  </Link>
                  {r.restored && <span className="ml-1.5 rounded-full border border-accent px-1.5 text-[10px] text-ink">restored</span>}
                </td>
                <td className="p-2.5">
                  {r.contactName ?? "—"}
                  {r.contactEmail && <span className="block text-[11px] text-muted">{r.contactEmail}</span>}
                </td>
                <td className="p-2.5">{r.product}</td>
                <td className="p-2.5">{r.campaign}</td>
                <td className="p-2.5 tabular-nums">{when(r.decidedAt)}</td>
                <td className="p-2.5">{r.decidedBy}</td>
                <td className="p-2.5">
                  {r.followup ? (
                    <FollowupCell f={r.followup} onCancel={() => cancelFollowups(r.candidateId)} disabled={pending} />
                  ) : r.reason ? (
                    <span>
                      {r.reason.toLowerCase().replace(/_/g, " ")}
                      {r.reasonDetail && <span className="block text-[11px] text-muted">{r.reasonDetail}</span>}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FollowupCell({ f, onCancel, disabled }: { f: NonNullable<HistoryRow["followup"]>; onCancel: () => void; disabled: boolean }) {
  return (
    <div className="grid gap-0.5 tabular-nums" data-testid="followup-state">
      <span>
        {f.touchesSent} touch{f.touchesSent === 1 ? "" : "es"} sent{f.lastSentAt ? `, last ${when(f.lastSentAt)}` : ""}
      </span>
      {f.stoppedOnReply && <span className="text-pos">stopped — replied</span>}
      {f.bounced && <span className="text-[#FFB3C2]">stopped — bounced</span>}
      {f.cancelled && <span className="text-muted">follow-ups cancelled</span>}
      {f.next && (
        <span className="text-muted">
          next: follow-up {f.next.step} {f.next.drafted ? `(${f.next.status?.toLowerCase()})` : "(not drafted yet)"} due {when(f.next.dueAt)}
        </span>
      )}
      {f.next && (
        <button
          type="button"
          disabled={disabled}
          onClick={onCancel}
          className="justify-self-start text-[11px] text-muted underline hover:text-ink disabled:opacity-45"
          data-testid="cancel-followups"
        >
          Cancel follow-ups
        </button>
      )}
    </div>
  );
}
