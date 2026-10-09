/**
 * The cold outbound sender's rules, pure (playbook-v6 F5, spec §4.43.9).
 */
import { createHash } from "node:crypto";
import { assertOutboundFrom, type SendingPolicy } from "@/modules/mail/sending-policy";

export { ColdSenderError } from "@/modules/mail/sending-policy";

/**
 * THE guard (CLAUDE.md hard rule 11), per workspace. Asserted on the mailbox
 * the message is about to leave from, immediately before the send call — in
 * code, so a misconfigured setting, a second connected mailbox or a future
 * call site cannot route cold mail through the transactional reputation or
 * another workspace's domain. A refusal, never a warning. The rules live in
 * modules/mail/sending-policy.ts.
 */
export function assertColdSender(address: string | null | undefined, policy: SendingPolicy): string {
  return assertOutboundFrom(address, policy);
}

/** RFC 2047 for a header value that is not plain ASCII. */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function mailbox(address: string, name: string | null | undefined): string {
  if (!name) return address;
  const clean = name.replace(/["\r\n<>]/g, "").trim();
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(clean) ? `"${clean}" <${address}>` : `${encodeHeader(clean)} <${address}>`;
}

export interface ColdMimeInput {
  from: string;
  fromName: string | null;
  to: string;
  toName: string | null;
  subject: string;
  text: string;
  unsubscribeUrl: string;
  inReplyTo?: string | null;
}

/**
 * The message as it goes on the wire: plain text first (spec §4.16 guardrail),
 * with RFC 8058 one-click unsubscribe headers so a mail client can offer the
 * button itself.
 */
export function buildColdMime(m: ColdMimeInput): string {
  const headers = [
    `From: ${mailbox(m.from, m.fromName)}`,
    `To: ${mailbox(m.to, m.toName)}`,
    `Subject: ${encodeHeader(m.subject)}`,
    "MIME-Version: 1.0",
    `List-Unsubscribe: <${m.unsubscribeUrl}>`,
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`] : []),
  ];
  return [...headers, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", m.text].join("\r\n");
}

/** The hour and ISO weekday at `now` in a timezone. */
export function localClock(now: Date, timeZone: string): { hour: number; weekday: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1;
  return { hour: Number(get("hour")), weekday, date: `${get("year")}-${get("month")}-${get("day")}` };
}

/** Business hours only, weekdays only: cold mail at 2 a.m. on a Sunday reads as a robot. */
export function inSendWindow(now: Date, timeZone: string, startHour: number, endHour: number): boolean {
  const { hour, weekday } = localClock(now, timeZone);
  return weekday >= 1 && weekday <= 5 && hour >= startHour && hour < endHour;
}

/**
 * The gap before the next send, jittered but deterministic per message — so
 * a restarted worker computes the same gap rather than firing early.
 */
export function spacingSeconds(lastDraftId: string, minSec: number, maxSec: number): number {
  if (maxSec <= minSec) return minSec;
  const n = parseInt(createHash("sha1").update(lastDraftId).digest("hex").slice(0, 8), 16);
  return minSec + (n % (maxSec - minSec + 1));
}

/** Below this many sends a bounce rate is noise; the breaker waits for a sample. */
export const BOUNCE_SAMPLE_MIN = 20;

export function shouldTripBreaker(sent: number, bounced: number, threshold: number): boolean {
  if (sent < BOUNCE_SAMPLE_MIN) return bounced >= 3 && bounced / Math.max(1, sent) > threshold * 3;
  return bounced / sent > threshold;
}

/** A reply that asks us to stop is an unsubscribe, whatever button it did not press. */
export function asksToStop(text: string): boolean {
  return /\b(leiratkoz|ne (írjon|keressen)|ne küldjön|töröljenek|unsubscribe|remove me|stop (emailing|writing)|not interested)/i.test(text);
}

/** Bounce notices name the address they could not deliver to; pull the candidates out. */
export function bouncedAddresses(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)) {
    const a = m[0].toLowerCase();
    if (/mailer-daemon|postmaster|googlemail\.com$/.test(a)) continue;
    out.add(a);
  }
  return [...out];
}

/**
 * Mail providers where a shared domain says nothing about a shared company.
 * A reply "from the same domain" only counts as the company replying when the
 * domain is the company's own.
 */
const FREEMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "freemail.hu",
  "citromail.hu",
  "t-online.hu",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "gmx.net",
  "gmx.com",
  "proton.me",
  "protonmail.com",
]);

export function isFreemail(domain: string | null | undefined): boolean {
  return !!domain && FREEMAIL.has(domain.toLowerCase());
}
