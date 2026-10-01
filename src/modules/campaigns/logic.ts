import { normalizeEmail } from "../leads/dedupe";
import { isRecipientSuppressed } from "../mail/suppression";

/**
 * Cold Email pure logic (spec §4.16). The compliance gate, shared suppression,
 * bounce circuit breaker, warm-up ramp, and DATA-only personalization all live
 * here — no AI, no DB. The one Sonnet call (drafting the frame per campaign)
 * happens elsewhere; per-recipient rendering below is pure template fill.
 */

// ---- compliance gate ------------------------------------------------------

export interface ColdSignoff {
  approvedBy: string;
  date: string;
  scopeNote: string;
}

export interface ColdConfig {
  signoff: ColdSignoff | null;
  coldDomain: string | null;
  warmupStartedAt: string | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function parseColdConfig(featureFlags: unknown): ColdConfig {
  const cold = asRecord(asRecord(featureFlags).coldEmail);
  const s = asRecord(cold.signoff);
  const signoff =
    typeof s.approvedBy === "string" || typeof s.scopeNote === "string"
      ? {
          approvedBy: String(s.approvedBy ?? ""),
          date: String(s.date ?? ""),
          scopeNote: String(s.scopeNote ?? ""),
        }
      : null;
  return {
    signoff,
    coldDomain: typeof cold.coldDomain === "string" ? cold.coldDomain : null,
    warmupStartedAt: typeof cold.warmupStartedAt === "string" ? cold.warmupStartedAt : null,
  };
}

/** Cold email is allowed ONLY with a complete counsel sign-off (who/when/scope). */
export function coldEmailAllowed(featureFlags: unknown): boolean {
  const { signoff } = parseColdConfig(featureFlags);
  if (!signoff) return false;
  return (
    signoff.approvedBy.trim() !== "" &&
    signoff.date.trim() !== "" &&
    signoff.scopeNote.trim() !== ""
  );
}

// ---- shared suppression ---------------------------------------------------

/**
 * Domain-wide entries ("@ceg.hu") written by an outbound unsubscribe apply
 * here too: one suppression list for every channel (spec §4.43.9).
 */
export function isSuppressed(address: string, suppressed: string[]): boolean {
  const a = normalizeEmail(address);
  if (!a) return true; // no address → never send
  return isRecipientSuppressed(a, suppressed);
}

export function partitionRecipients<T extends { address: string }>(
  recipients: T[],
  suppressed: string[],
): { sendable: T[]; blocked: T[] } {
  const sendable: T[] = [];
  const blocked: T[] = [];
  for (const r of recipients) {
    const a = normalizeEmail(r.address);
    if (a && !isRecipientSuppressed(a, suppressed)) sendable.push(r);
    else blocked.push(r);
  }
  return { sendable, blocked };
}

// ---- bounce circuit breaker ----------------------------------------------

export function bounceRate(sent: number, bounced: number): number {
  return sent > 0 ? bounced / sent : 0;
}

export const DEFAULT_BOUNCE_THRESHOLD = 0.05;
export const DEFAULT_MIN_SAMPLE = 20;

export function circuitBreakerTripped(
  sent: number,
  bounced: number,
  threshold: number = DEFAULT_BOUNCE_THRESHOLD,
  minSample: number = DEFAULT_MIN_SAMPLE,
): boolean {
  if (sent < minSample) return false; // not enough signal yet
  return bounceRate(sent, bounced) >= threshold;
}

// ---- warm-up ramp ---------------------------------------------------------

// Fraction of the configured daily cap allowed each warm-up week.
export const WARMUP_FACTORS = [0.25, 0.5, 0.75, 1];

export function warmupDailyCap(weekIndex: number, dailyCap: number): number {
  const factor = WARMUP_FACTORS[Math.min(weekIndex, WARMUP_FACTORS.length - 1)];
  return Math.ceil(dailyCap * factor);
}

export function warmupWeekIndex(startedAtMs: number | null, nowMs: number): number {
  if (!startedAtMs) return 0;
  return Math.max(0, Math.floor((nowMs - startedAtMs) / (7 * 24 * 60 * 60_000)));
}

// ---- personalization (DATA only) + unsubscribe ----------------------------

export function renderPersonalized(template: string, slots: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, key: string) => slots[key] ?? "");
}

export function withUnsubscribeFooter(body: string, unsubUrl: string): string {
  return `${body}\n\n—\nDon't want these emails? Unsubscribe: ${unsubUrl}`;
}

export interface ColdStep {
  stepNumber: number;
  subject?: string | null;
  body: string;
}

export interface RecipientRender {
  address: string;
  slots: Record<string, string>;
  unsubUrl: string;
}

export interface RenderedSend {
  address: string;
  subject: string;
  body: string;
}

/**
 * Render one step for many recipients from the ALREADY-DRAFTED frame. Pure —
 * takes no AI dependency, so there is provably no per-recipient model call.
 */
export function buildRecipientSends(step: ColdStep, recipients: RecipientRender[]): RenderedSend[] {
  return recipients.map((r) => ({
    address: r.address,
    subject: renderPersonalized(step.subject ?? "", r.slots),
    body: withUnsubscribeFooter(renderPersonalized(step.body, r.slots), r.unsubUrl),
  }));
}
