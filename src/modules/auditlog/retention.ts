/**
 * How long the audit log is kept (P5/5.3).
 *
 * ── WHY THERE WAS NO ANSWER TO THIS ─────────────────────────────────────────
 *
 * Hard rule #8 says log every grant change, export, delete, watermark removal
 * and invoice submission, and the codebase does — in fifty-one places. What was
 * missing was the other half of a retention story: the rows were kept FOR EVER,
 * with no setting, no sweep and no way to get them out of the product.
 *
 * Two things follow from that, and both are answered here:
 *
 *   - GDPR asks for a defined retention period, not "indefinitely". A log of
 *     who touched whose personal data is itself personal data.
 *   - a table that only grows is a table that eventually cannot be read. Ours
 *     has one index, on `workspace_id`.
 *
 * A plain module, not the `"use server"` one beside it: a file marked
 * `"use server"` may only export async functions, and a const exported from one
 * kills the build. The same trap the audit-log categories and the task
 * attachment limits fell into.
 */

/**
 * The default: keep everything.
 *
 * Deliberately not a number. Silently deleting somebody's audit history
 * because a default said so is exactly the surprise a log exists to prevent —
 * an Owner has to choose a period, and is shown how many rows it will remove
 * before they do.
 */
export const DEFAULT_AUDIT_RETENTION_DAYS = 0;

/**
 * The shortest period worth offering.
 *
 * A log that rotates faster than a quarter cannot answer a question about last
 * quarter, which is the main thing anybody ever asks it. Ninety days is also
 * the floor most security questionnaires state.
 */
export const MIN_AUDIT_RETENTION_DAYS = 90;
export const MAX_AUDIT_RETENTION_DAYS = 3650;

export function auditRetentionDaysFrom(featureFlags: unknown): number {
  if (!featureFlags || typeof featureFlags !== "object" || Array.isArray(featureFlags)) {
    return DEFAULT_AUDIT_RETENTION_DAYS;
  }
  const raw = (featureFlags as Record<string, unknown>).auditLogRetentionDays;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_AUDIT_RETENTION_DAYS;
  const days = Math.round(raw);
  if (days <= 0) return DEFAULT_AUDIT_RETENTION_DAYS;
  // A stored value outside the offered range is clamped rather than obeyed: a
  // hand-edited 1 must not shred a workspace's history overnight.
  if (days < MIN_AUDIT_RETENTION_DAYS) return MIN_AUDIT_RETENTION_DAYS;
  if (days > MAX_AUDIT_RETENTION_DAYS) return MAX_AUDIT_RETENTION_DAYS;
  return days;
}

/**
 * The cut-off the sweep deletes below, or null for "keep everything".
 *
 * Null rather than a very old date, so the caller has to handle the
 * keep-for-ever case explicitly instead of running a delete with a where clause
 * that happens to match nothing.
 */
export function auditRetentionCutoff(days: number, now: Date = new Date()): Date | null {
  if (days <= 0) return null;
  return new Date(now.getTime() - days * 86_400_000);
}

export function describeAuditRetention(days: number): string {
  if (days <= 0) return "Kept indefinitely";
  if (days % 365 === 0) {
    const years = days / 365;
    return `Kept for ${years} ${years === 1 ? "year" : "years"}`;
  }
  return `Kept for ${days} days`;
}
