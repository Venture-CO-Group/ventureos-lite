import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { OutboundTabs } from "@/components/outbound-tabs";
import { OutboundRestorePanel } from "@/components/outbound-restore-panel";
import { loadCandidateDetail } from "@/modules/outbound/history";
import { formatFt } from "@/modules/outbound/filter";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * One candidate, everything about it (tracking & recovery): the full state
 * history with who did what, the company data, the audit, every draft as it
 * stood — the original beside an edited one — and, once sent, what happened
 * to it.
 */
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "—");
const human = (s: string) => s.toLowerCase().replace(/_/g, " ");

export default async function OutboundCandidatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { workspaceId } = await getActiveContext();
  const d = await loadCandidateDetail(getWorkspaceClient(workspaceId), workspaceId, id);
  if (!d) notFound();
  const sheet = d.sheet?.data;
  const restorable = d.state === "REJECTED" || d.state === "FILTERED_OUT";

  return (
    <AppShell activePath="/outbound">
      <OutboundTabs active="/outbound/history" />
      <Link href="/outbound/history" className="mb-3 inline-block text-[12px] text-muted underline hover:text-ink">← history</Link>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid content-start gap-4">
          <section className="grid gap-1 rounded-card border border-line bg-panel p-[18px]" data-testid="candidate-summary">
            <h2 className="font-display text-[20px] font-extrabold lowercase">{d.name}</h2>
            <p className="text-[12.5px] text-muted">
              {human(d.state)}
              {d.reason ? ` · ${human(d.reason)}` : ""}
              {d.reasonDetail ? ` — ${d.reasonDetail}` : ""}
            </p>
            <p className="text-[12px] text-muted">
              {d.product} · {d.campaign}
              {d.segment ? ` · ${d.segment}` : ""}
            </p>
            {d.restored && (
              <p className="text-[12px] text-ink">
                Restored {when(d.restored.at)} by {d.restored.by}
                {d.restored.count > 1 ? ` (${d.restored.count} times)` : ""}
                {d.restored.note ? ` — ${d.restored.note}` : ""}
              </p>
            )}
          </section>

          <section className="grid gap-2 rounded-card border border-line bg-panel p-[18px]" data-testid="candidate-drafts">
            <h3 className="font-display text-[16px] font-bold lowercase">messages</h3>
            {d.drafts.length === 0 && <p className="text-[12.5px] text-muted">No draft was written.</p>}
            {d.drafts.map((m) => (
              <div key={m.id} className={`grid gap-1 rounded-[10px] border border-line p-3 ${m.superseded ? "opacity-60" : ""}`}>
                <div className="text-[11.5px] text-muted">
                  {m.step === 0 ? "First message" : `Follow-up ${m.step}`} · {human(m.status)}
                  {m.superseded ? " · superseded by a regenerated draft" : ""}
                  {m.decidedAt ? ` · ${m.status === "REJECTED" ? "rejected" : "decided"} ${when(m.decidedAt)} by ${m.decidedBy}` : ""}
                  {m.rejectReason ? ` · ${human(m.rejectReason)}` : ""}
                  {m.rejectNote ? ` — ${m.rejectNote}` : ""}
                </div>
                <b className="text-[13px] text-ink">{m.subject}</b>
                <p className="whitespace-pre-wrap text-[12.5px]">{m.body}</p>
                {m.edited && (
                  <details className="text-[12px] text-muted">
                    <summary className="cursor-pointer">Edited — the machine&apos;s original</summary>
                    <p className="mt-1 whitespace-pre-wrap">
                      {m.originalSubject}
                      {"\n\n"}
                      {m.originalBody}
                    </p>
                  </details>
                )}
                {(m.sentAt || m.scheduledFor || m.sendError) && (
                  <p className="text-[11.5px] tabular-nums text-muted" data-testid="delivery-status">
                    {m.sentAt ? `Sent ${when(m.sentAt)} from ${m.sentFrom}` : m.scheduledFor ? `Scheduled ${when(m.scheduledFor)}` : ""}
                    {m.bouncedAt ? ` · bounced ${when(m.bouncedAt)}` : m.sentAt ? " · delivered (no bounce reported)" : ""}
                    {m.sentAt ? " · opens not tracked (plain text)" : ""}
                    {m.sendError ? ` · ${m.sendError}` : ""}
                  </p>
                )}
              </div>
            ))}
            {d.reply && (
              <div className="rounded-[10px] border border-[rgba(61,220,151,0.35)] p-3 text-[12.5px]" data-testid="candidate-reply">
                Reply from {d.reply.from} on {when(d.reply.at)}
                {d.reply.snippet && <p className="mt-1 text-muted">{d.reply.snippet}</p>}
                <Link href="/inbox" className="mt-1 inline-block text-[12px] underline">Open in the Inbox</Link>
              </div>
            )}
            {d.followup && (
              <p className="text-[12px] tabular-nums text-muted">
                {d.followup.touchesSent} touch(es) sent
                {d.followup.next ? ` · next: follow-up ${d.followup.next.step} due ${when(d.followup.next.dueAt)}` : ""}
                {d.followup.stoppedOnReply ? " · stopped on reply" : ""}
                {d.followup.cancelled ? " · follow-ups cancelled" : ""}
              </p>
            )}
          </section>

          <section className="grid gap-1 rounded-card border border-line bg-panel p-[18px]" data-testid="candidate-events">
            <h3 className="font-display text-[16px] font-bold lowercase">history</h3>
            <ol className="grid gap-1 text-[12px]">
              {d.events.map((e, i) => (
                <li key={i} className={`grid grid-cols-[130px_minmax(0,1fr)] gap-2 ${e.retracted ? "text-muted line-through" : ""}`}>
                  <span className="tabular-nums text-muted">{when(e.at)}</span>
                  <span>
                    {e.from ? `${human(e.from)} → ` : ""}
                    <b className="text-ink">{human(e.to)}</b>
                    {e.reason ? ` · ${human(e.reason)}` : ""}
                    {e.detail ? ` — ${e.detail}` : ""}
                    <span className="text-muted"> · {e.actor}</span>
                    {e.retracted ? " (undone)" : ""}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="grid content-start gap-4">
          {restorable && <OutboundRestorePanel candidateId={d.id} />}
          <section className="grid gap-1 rounded-card border border-line bg-panel p-[18px] text-[12px]" data-testid="candidate-company">
            <h3 className="font-display text-[16px] font-bold lowercase">company</h3>
            {d.taxNumber && <span className="tabular-nums text-muted">tax {d.taxNumber}</span>}
            {sheet ? (
              <>
                <span>{sheet.legalName}</span>
                {sheet.principalActivity && <span>{sheet.principalActivity.code} {sheet.principalActivity.label}</span>}
                <span className="tabular-nums text-muted">
                  {[sheet.seat.city, sheet.employeeCount !== null ? `${sheet.employeeCount} employees` : null, sheet.netRevenue !== null ? formatFt(sheet.netRevenue) : null, sheet.foundedAt ? `founded ${sheet.foundedAt.slice(0, 4)}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {sheet.managers.length > 0 && <span>Managers: {sheet.managers.map((m) => m.name).join(", ")}</span>}
                <span className="text-[11px] text-muted">registry data from {d.sheet!.fetchedAt.slice(0, 10)}</span>
              </>
            ) : (
              <span className="text-muted">No datasheet on file.</span>
            )}
            {d.website && <a href={d.website} target="_blank" rel="noreferrer" className="truncate underline">{d.website}</a>}
            {d.contact && (
              <span className="mt-1">
                Contact: {d.contact.name ?? d.contact.managerName ?? "—"} {d.contact.email ? `<${d.contact.email}>` : ""} · via {d.contact.source ?? "—"}
              </span>
            )}
          </section>
          {d.audit && (
            <section className="grid gap-1 rounded-card border border-line bg-panel p-[18px] text-[12px]" data-testid="candidate-audit">
              <h3 className="font-display text-[16px] font-bold lowercase">audit</h3>
              <span>
                Score <b className="tabular-nums text-ink">{d.audit.score}</b> · {when(d.audit.at)}
              </span>
              {d.audit.flags.length > 0 && <span className="text-muted">{d.audit.flags.join(", ")}</span>}
              <Link href={`/audit?url=${encodeURIComponent(d.audit.url)}&run=1`} className="underline">Open the audit</Link>
            </section>
          )}
        </aside>
      </div>
    </AppShell>
  );
}
