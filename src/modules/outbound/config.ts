/**
 * The outbound motor's workspace settings (playbook-v6, spec §4.43.4,
 * §4.43.9–10), stored in `Workspace.outboundConfig`.
 *
 * One parser with every default in it, so the run screen, the scheduler, the
 * quota check and the send guard all read the same numbers. An absent or
 * malformed config is not an error: it is the defaults, which are the
 * conservative launch values from the approved decisions.
 */
import { z } from "zod";

/** The only sending identity cold outbound may use (CLAUDE.md hard rule 11). */
export const COLD_OUTBOUND_ADDRESS = "fanni.viragh@ventureco.agency";
export const COLD_OUTBOUND_DOMAIN = "ventureco.agency";

const registrySchema = z.object({
  /** Detail lookups per month on the plan. Haladó: 5,000. */
  monthlyLimit: z.number().int().min(0).max(1_000_000).default(5000),
  /** Share of the month held back for interactive lookups. */
  reservePct: z.number().int().min(0).max(90).default(15),
});

const scheduleSchema = z.object({
  enabled: z.boolean().default(false),
  hour: z.number().int().min(0).max(23).default(3),
  minute: z.number().int().min(0).max(59).default(0),
  /** ISO weekdays, 1 = Monday. Default Monday–Friday nights. */
  days: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
  timezone: z.string().default("Europe/Budapest"),
});

const capSchema = z.object({
  /** Drafts ready for approval per day, across all products, at launch. */
  initial: z.number().int().min(0).max(200).default(15),
  /** …and after the ramp period. */
  after: z.number().int().min(0).max(200).default(25),
  rampDays: z.number().int().min(0).max(120).default(14),
  /** When the motor first ran; the ramp counts from here. */
  startedAt: z.string().nullable().default(null),
});

const warmupSchema = z.object({
  /** Sends per day on the first day of the mailbox. */
  start: z.number().int().min(1).max(200).default(10),
  step: z.number().int().min(0).max(50).default(5),
  everyDays: z.number().int().min(1).max(30).default(3),
  ceiling: z.number().int().min(1).max(500).default(40),
  /** First send from this mailbox; the ramp counts from here. */
  startedAt: z.string().nullable().default(null),
});

const sendingSchema = z.object({
  /** The MailAccount the motor sends through, once connected. */
  mailAccountId: z.string().nullable().default(null),
  // No open/click tracking on cold outbound: it leaves as plain text with no
  // pixel and no rewritten link (spec §4.37 tracking is for 1:1 mail sent
  // from the Inbox). A pixel needs HTML, and HTML-first cold mail is exactly
  // what the deliverability guardrails rule out.
  /** Bounce rate above which the mailbox pauses (same as §4.16). */
  bounceThreshold: z.number().min(0).max(1).default(0.03),
  /** Set by the circuit breaker; cleared by an Owner. */
  pausedAt: z.string().nullable().default(null),
  pausedReason: z.string().nullable().default(null),
  /**
   * The Gmail account's own signature, as plain text, fetched from
   * users.settings.sendAs (the API does not add it on send) and cached here.
   */
  cachedSignature: z.string().max(4000).nullable().default(null),
  signatureFetchedAt: z.string().nullable().default(null),
  /** Fallback block when the Gmail account has no signature. */
  fallbackSignature: z.string().max(2000).default(""),
  /** Minimum and maximum seconds between two sends. */
  spacingMinSec: z.number().int().min(0).max(3600).default(90),
  spacingMaxSec: z.number().int().min(0).max(7200).default(420),
  /** Local hours sending is allowed in. */
  windowStartHour: z.number().int().min(0).max(23).default(8),
  windowEndHour: z.number().int().min(1).max(24).default(17),
});

const followupSchema = z.object({
  /** Days after the previous touch. Two touches maximum. */
  offsetsDays: z.array(z.number().int().min(1).max(60)).max(2).default([4, 9]),
});

export const outboundConfigSchema = z.object({
  registry: registrySchema.default({}),
  schedule: scheduleSchema.default({}),
  cap: capSchema.default({}),
  warmup: warmupSchema.default({}),
  sending: sendingSchema.default({}),
  followups: followupSchema.default({}),
});

export type OutboundConfig = z.infer<typeof outboundConfigSchema>;

export function parseOutboundConfig(raw: unknown): OutboundConfig {
  const parsed = outboundConfigSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  // A config one field of which is wrong should not cost the other settings:
  // parse each section on its own and fall back per section.
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const section = <S extends z.ZodTypeAny>(schema: S, v: unknown): z.output<S> => {
    const r = schema.safeParse(v ?? {});
    return r.success ? r.data : schema.parse({});
  };
  return {
    registry: section(registrySchema, obj.registry),
    schedule: section(scheduleSchema, obj.schedule),
    cap: section(capSchema, obj.cap),
    warmup: section(warmupSchema, obj.warmup),
    sending: section(sendingSchema, obj.sending),
    followups: section(followupSchema, obj.followups),
  };
}

const DAY_MS = 86_400_000;

/** The workspace-wide daily cap: `initial` for the ramp period, then `after`. */
export function workspaceDailyCap(cfg: OutboundConfig["cap"], now: Date): number {
  if (!cfg.startedAt) return cfg.initial;
  const started = Date.parse(cfg.startedAt);
  if (!Number.isFinite(started)) return cfg.initial;
  return now.getTime() - started >= cfg.rampDays * DAY_MS ? cfg.after : cfg.initial;
}

/**
 * The mailbox's send cap today: `start`, plus `step` every `everyDays`, up to
 * `ceiling`. Day one of a mailbox that has never sent is day one.
 */
export function warmupDailyCap(cfg: OutboundConfig["warmup"], now: Date): number {
  if (!cfg.startedAt) return Math.min(cfg.start, cfg.ceiling);
  const started = Date.parse(cfg.startedAt);
  if (!Number.isFinite(started)) return Math.min(cfg.start, cfg.ceiling);
  const days = Math.max(0, Math.floor((now.getTime() - started) / DAY_MS));
  return Math.min(cfg.ceiling, cfg.start + Math.floor(days / cfg.everyDays) * cfg.step);
}
