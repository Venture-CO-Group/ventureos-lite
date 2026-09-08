import { prismaUnsafe } from "@/lib/db";
import { auditRetentionCutoff, auditRetentionDaysFrom } from "./retention";

/**
 * The audit-log retention sweep (P5/5.3).
 *
 * ── WHY A SWEEP AND NOT A TRIGGER ───────────────────────────────────────────
 *
 * Nightly, per workspace, and it leaves a row behind saying what it did. That
 * last part matters more than it looks: a retention job that silently removes
 * audit rows is indistinguishable, after the fact, from somebody covering their
 * tracks. So every sweep that deletes anything writes `audit_log.pruned` with
 * the count and the cut-off — the one entry that explains the gap.
 *
 * Uses `prismaUnsafe` because it crosses workspaces by design; the workspace id
 * is supplied explicitly on every statement, which is the same contract the
 * other sweeps here work under.
 */
export async function processAuditLogRetention(now: Date = new Date()): Promise<number> {
  const workspaces = await prismaUnsafe.workspace.findMany({
    select: { id: true, featureFlags: true },
  });

  let deleted = 0;
  for (const ws of workspaces) {
    const days = auditRetentionDaysFrom(ws.featureFlags);
    const cutoff = auditRetentionCutoff(days, now);
    if (!cutoff) continue; // keep for ever — the default

    const res = await prismaUnsafe.auditLog.deleteMany({
      where: {
        workspaceId: ws.id,
        at: { lt: cutoff },
        // The pruning records themselves are never pruned. They are tiny, they
        // are the only account of what went missing, and a sweep that erases
        // its own history defeats the point.
        action: { not: "audit_log.pruned" },
      },
    });
    if (res.count === 0) continue;

    deleted += res.count;
    await prismaUnsafe.auditLog.create({
      data: {
        workspaceId: ws.id,
        // No actor: this was the system, not a person, and naming a person
        // here would be a lie in the one table that must not contain one.
        action: "audit_log.pruned",
        meta: { rows: res.count, olderThan: cutoff.toISOString(), retentionDays: days },
      },
    });
  }
  return deleted;
}
