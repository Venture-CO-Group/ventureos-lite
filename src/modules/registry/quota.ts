/**
 * The registry detail quota as arithmetic (CLAUDE.md hard rule 12, spec
 * §4.43.4). Pure, so the rules are tested as a table rather than through a
 * database.
 *
 * ── THE MODEL ──────────────────────────────────────────────────────────────
 *
 * The month has `limit` charged lookups. A `reserve` share of it is held back
 * for people: a nightly run must never leave somebody clicking "fetch company
 * data" at 14:00 with nothing left.
 *
 * Batch consumers (the nightly run, a manual run) get a DAILY allocation:
 * what the batch share has left at the start of today, divided by the days
 * left in the month including today. Computing it from the start of the day,
 * not from now, keeps the allocation fixed while a run spends it — otherwise
 * each call would shrink the next call's allowance and the run would stop
 * well short of its share.
 *
 * Interactive consumers may spend anything left in the month, reserve
 * included — that is what the reserve is for.
 */

export type QuotaConsumer = "batch" | "interactive";

export interface QuotaUsage {
  limit: number;
  reservePct: number;
  /** Charged lookups this month, all purposes. */
  usedMonth: number;
  /** Charged batch lookups this month. */
  usedMonthBatch: number;
  /** Charged batch lookups today. */
  usedTodayBatch: number;
  /** Days left in the month including today (≥ 1). */
  daysRemaining: number;
}

export interface QuotaPosition {
  reserve: number;
  /** Today's batch allocation. */
  dailyAllocation: number;
  /** What batch may still spend today. */
  batchRemainingToday: number;
  /** What anyone may still spend this month. */
  monthRemaining: number;
}

export function quotaPosition(u: QuotaUsage): QuotaPosition {
  const reserve = Math.floor((u.limit * u.reservePct) / 100);
  const batchShare = Math.max(0, u.limit - reserve);
  const batchLeftAtStartOfDay = Math.max(0, batchShare - (u.usedMonthBatch - u.usedTodayBatch));
  const days = Math.max(1, u.daysRemaining);
  const dailyAllocation = Math.floor(batchLeftAtStartOfDay / days);
  const monthRemaining = Math.max(0, u.limit - u.usedMonth);
  const batchRemainingToday = Math.max(
    0,
    Math.min(dailyAllocation - u.usedTodayBatch, batchShare - u.usedMonthBatch, monthRemaining),
  );
  return { reserve, dailyAllocation, batchRemainingToday, monthRemaining };
}

export type QuotaDecision = { ok: true } | { ok: false; scope: "daily" | "monthly" };

export function mayLookup(consumer: QuotaConsumer, u: QuotaUsage): QuotaDecision {
  const p = quotaPosition(u);
  if (p.monthRemaining <= 0) return { ok: false, scope: "monthly" };
  if (consumer === "interactive") return { ok: true };
  return p.batchRemainingToday > 0 ? { ok: true } : { ok: false, scope: "daily" };
}

/** "2026-10" for the UTC month of `at`. */
export function quotaMonth(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Days left in the UTC month of `at`, today included. */
export function daysRemainingInMonth(at: Date): number {
  const last = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
  return last - at.getUTCDate() + 1;
}

export function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** The expected spend of a run, and its share of the month — for the pre-run estimate. */
export function estimateShare(expectedLookups: number, limit: number): number {
  if (limit <= 0) return 1;
  return Math.min(1, expectedLookups / limit);
}
