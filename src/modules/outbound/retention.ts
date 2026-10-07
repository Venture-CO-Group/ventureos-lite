/**
 * Outbound data retention (spec §4.43.10 GDPR, CLAUDE.md hard rule 9).
 *
 * Candidate rows carry personal data — managers' names, addresses, the
 * contact trail — about people who mostly never became leads. They are kept
 * twelve months after the last meaningful interaction, then deleted with
 * their drafts. Pool rows unseen for a year go too, and registry datasheets
 * (which list managers and owners by name) are deleted once they are well
 * past their 90-day cache life.
 *
 * Suppression entries are never touched here: a refusal to be contacted
 * outlives everything else.
 */
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";

const YEAR_MS = 365 * 86_400_000;

export interface RetentionReport {
  candidates: number;
  drafts: number;
  pool: number;
  sheets: number;
  searches: number;
}

export async function processOutboundRetention(now: Date = new Date()): Promise<RetentionReport> {
  const report: RetentionReport = { candidates: 0, drafts: 0, pool: 0, sheets: 0, searches: 0 };
  const cutoff = new Date(now.getTime() - YEAR_MS);
  const workspaces = await prismaUnsafe.workspace.findMany({ where: { deletedAt: null }, select: { id: true } });
  for (const { id } of workspaces) {
    const db = getWorkspaceClient(id);
    const stale = await db.prospectCandidate.findMany({
      where: { updatedAt: { lt: cutoff } },
      select: { id: true, leadId: true },
      take: 5000,
    });
    // A candidate that became a lead with recent activity is that lead's
    // history; it stays as long as the lead is active.
    const leadIds = stale.map((c) => c.leadId).filter((x): x is string => !!x);
    const activeLeads = new Set(
      leadIds.length
        ? (await db.lead.findMany({ where: { id: { in: leadIds }, lastActivityAt: { gte: cutoff } }, select: { id: true } })).map((l) => l.id)
        : [],
    );
    const doomed = stale.filter((c) => !c.leadId || !activeLeads.has(c.leadId)).map((c) => c.id);
    if (doomed.length) {
      report.drafts += (await db.outreachDraft.deleteMany({ where: { candidateId: { in: doomed } } })).count;
      report.candidates += (await db.prospectCandidate.deleteMany({ where: { id: { in: doomed } } })).count;
    }
    report.pool += (await db.candidatePool.deleteMany({ where: { lastSeenAt: { lt: cutoff }, candidates: { none: {} } } })).count;
    report.sheets += (await db.registrySheet.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 90 * 86_400_000) } } })).count;
    report.searches += (await db.registrySearchCache.deleteMany({ where: { expiresAt: { lt: now } } })).count;
  }
  return report;
}
