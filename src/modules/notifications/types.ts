/**
 * The notification catalogue (playbook-v2 P6/1).
 *
 * Pure: what can be notified about, who is allowed to receive it, which
 * channels are on before anyone chooses, and how one event is kept from
 * notifying twice.
 *
 * WHAT IS AND IS NOT HERE. The playbook lists eleven kinds. Ten of them have a
 * real event in this codebase and are wired. Two do not, and inventing an
 * emitter for them would have produced a type that can never fire:
 *
 *   - "meeting cancelled" — nothing cancels a meeting. There is no cancel
 *     action and the Meeting model has no status or cancelledAt column, so
 *     there is no moment at which the notification could be raised. It needs
 *     the cancellation feature first.
 *   - "import failure" — CSV import validates and reports created/skipped
 *     synchronously in the dialog; it has no asynchronous failure to report
 *     later. MAILBOX sync failure does exist, so `sync_failed` covers that half
 *     of the playbook's "import/sync failures" and is named for what it is.
 */

import { isTrustedMember } from "@/lib/grants";

export const NOTIFICATION_TYPES = [
  "reply_received",
  "escalation",
  "callback_due",
  "task_due",
  "quote_accepted",
  "quote_declined",
  "meeting_booked",
  "campaign_paused",
  "sync_failed",
  "proposal_pending",
  /// A sign-in on this account (v2 P6/2). The one notification about the person
  /// rather than about the work.
  "new_login",
  /// An identified company read one of our public pages (v3 P8/b). The whole
  /// point of the signal layer: it fires while the prospect is still at their
  /// desk with the quote open.
  "visitor_signal",
  /// Somebody put a task on you (P8/1). The one notification people actually
  /// expect from a task system, and the reason assignment means anything.
  "task_assigned",
  /// A comment on a task you are following or were mentioned in.
  "task_commented",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface Channels {
  inApp: boolean;
  push: boolean;
  emailDigest: boolean;
  /**
   * An email straight away, not batched (P8/2).
   *
   * The one per-event channel, and it stays that way on purpose. A product
   * that mails on every notification is a product whose mail gets filtered,
   * so this defaults ON for exactly one type — `task_assigned` — where the
   * whole value is arriving before the person next opens the app. That is the
   * same line Asana draws, and it is the reason the digest below exists for
   * everything else.
   */
  emailNow: boolean;
}

export interface NotificationTypeDef {
  type: NotificationType;
  label: string;
  description: string;
  /** Owners and Admins only — a BDR never receives or configures it. */
  ownerOnly: boolean;
  defaults: Channels;
}

/**
 * Channel defaults, chosen per type rather than globally.
 *
 * in-app is on everywhere: the centre is the product, and a type nobody sees by
 * default is a type nobody knows exists.
 *
 * push is off everywhere. It cannot work without a browser permission the user
 * has to grant, so defaulting it on would promise a delivery that silently
 * never happens.
 *
 * emailDigest is on only where a missed item costs something. It batches into
 * the existing Monday digest — the playbook is explicit that this must not
 * become per-event mail.
 *
 * emailNow is off everywhere except `task_assigned`. See the field comment on
 * `Channels.emailNow`: one per-event email, for the one event whose value is
 * arriving before somebody next opens the app.
 */
function def(
  type: NotificationType,
  label: string,
  description: string,
  opts: { ownerOnly?: boolean; emailDigest?: boolean; emailNow?: boolean } = {},
): NotificationTypeDef {
  return {
    type,
    label,
    description,
    ownerOnly: opts.ownerOnly ?? false,
    defaults: {
      inApp: true,
      push: false,
      emailDigest: opts.emailDigest ?? false,
      emailNow: opts.emailNow ?? false,
    },
  };
}

export const NOTIFICATION_TYPE_DEFS: Record<NotificationType, NotificationTypeDef> = {
  reply_received: def(
    "reply_received",
    "Reply received",
    "A prospect replied on a lead you own.",
    // The reply is already sitting in the Inbox; repeating each one weekly is
    // the fastest way to make the digest unread.
    { emailDigest: false },
  ),
  escalation: def(
    "escalation",
    "Price escalation",
    "A reply mentioned price, a proposal or a contract.",
    { emailDigest: true },
  ),
  visitor_signal: def(
    "visitor_signal",
    "Someone read a page",
    "A company we could identify opened an audit report, quote or booking page.",
    // Its value is measured in minutes — a quote being read right now is a
    // reason to pick up the phone — so this is the type most worth switching
    // push ON for. It still defaults OFF: push needs a browser permission
    // nobody has granted yet, and a default that promises an undeliverable
    // notification is worse than one the user turns on deliberately.
    {},
  ),
  callback_due: def(
    "callback_due",
    "Callback due",
    "A callback you scheduled has come due.",
    { emailDigest: true },
  ),
  task_due: def(
    "task_due",
    "Task due or overdue",
    "A task assigned to you has reached its due time.",
    { emailDigest: true },
  ),
  task_assigned: def(
    "task_assigned",
    "Task assigned to you",
    "Somebody put a task on your plate.",
    /**
     * The only type that mails immediately.
     *
     * A task handed over on Friday afternoon should not wait until somebody
     * happens to open the bell, and a weekly digest is far too late to be the
     * first anybody hears of it. In the digest too, so it still shows up in
     * the weekly summary — but the email that matters is the one that arrives
     * within the minute.
     */
    { emailDigest: true, emailNow: true },
  ),
  task_commented: def(
    "task_commented",
    "Comment on a task",
    "Somebody commented on a task you are following, or mentioned you on one.",
  ),
  quote_accepted: def(
    "quote_accepted",
    "Quote accepted",
    "A client accepted a quote on the public acceptance page.",
    { emailDigest: true },
  ),
  quote_declined: def(
    "quote_declined",
    "Quote declined",
    "A quote was marked declined.",
    { emailDigest: true },
  ),
  meeting_booked: def(
    "meeting_booked",
    "Meeting booked",
    "A meeting was booked, from the app or the public booking page.",
    { emailDigest: true },
  ),
  campaign_paused: def(
    "campaign_paused",
    "Campaign paused",
    "The bounce circuit breaker paused a cold campaign.",
    { ownerOnly: false, emailDigest: true },
  ),
  sync_failed: def(
    "sync_failed",
    "Mailbox sync problem",
    "A connected mailbox needs reconnecting or stopped syncing.",
    { emailDigest: true },
  ),
  proposal_pending: def(
    "proposal_pending",
    "Signal Engine proposal",
    "The weekly analysis proposed a change and is waiting for approval.",
    { ownerOnly: true, emailDigest: true },
  ),
  new_login: def(
    "new_login",
    "New sign-in",
    "Your account signed in on a device or from an address.",
    // In the digest as well as in the bell: a sign-in you did not make is worth
    // hearing about twice, and it is the one notification where a missed
    // in-app badge is a real problem rather than an annoyance.
    { emailDigest: true },
  ),
};

const ALL_OFF: Channels = { inApp: false, push: false, emailDigest: false, emailNow: false };

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === "string" && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export function defaultChannels(type: NotificationType): Channels {
  return { ...NOTIFICATION_TYPE_DEFS[type].defaults };
}

/** Owner-only types are hidden from everyone else, in the UI and in delivery. */
export function visibleTypesFor(role: string): NotificationType[] {
  const privileged = isTrustedMember(role);
  return NOTIFICATION_TYPES.filter(
    (t) => privileged || !NOTIFICATION_TYPE_DEFS[t].ownerOnly,
  );
}

/**
 * The channels this user actually gets for this type.
 *
 * The role check is applied AFTER the stored preference, deliberately: a
 * preference row written while someone was an Owner must not keep delivering
 * Owner-only notifications once they are not. An unknown type resolves to
 * silence, so a row left behind by a retired type cannot resurrect it.
 */
export type StoredChannels = {
  [K in keyof Channels]?: boolean | null;
};

export function resolveChannels(
  type: string,
  stored: StoredChannels | null | undefined,
  role: string,
): Channels {
  if (!isNotificationType(type)) return { ...ALL_OFF };
  if (NOTIFICATION_TYPE_DEFS[type].ownerOnly && !isTrustedMember(role)) {
    return { ...ALL_OFF };
  }
  const resolved = defaultChannels(type);
  // Only an explicit boolean overrides. null/undefined mean "no opinion", and
  // spreading them in would turn a channel the TYPE enables into a falsy value.
  for (const key of ["inApp", "push", "emailDigest", "emailNow"] as const) {
    const value = stored?.[key];
    if (typeof value === "boolean") resolved[key] = value;
  }
  return resolved;
}

/**
 * One event, one notification.
 *
 * The key goes into a unique index, so a job that runs twice — a retried
 * BullMQ job, a sweep that catches the same overdue task on its next pass —
 * cannot stack duplicates in someone's bell. `discriminator` is the escape
 * hatch for events that SHOULD recur: an overdue task nags once a day by
 * passing the date, not once ever.
 */
export function dedupeKeyFor(
  type: string,
  entityId: string,
  discriminator?: string,
): string {
  return [type, entityId, discriminator ?? ""].join(":");
}

/** 90 days, then the sweep deletes them (playbook P6/1). */
export const RETENTION_DAYS = 90;

export function retentionCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
}
