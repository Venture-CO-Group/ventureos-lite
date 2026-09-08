"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { emitLeadCreated, emitWebhookEvent } from "@/modules/webhooks/emit";
import { getMailProvider } from "@/modules/mail/provider";
import { resolveSendingIdentity } from "@/modules/mail/identity";
import { brandEmail, brandEmailText } from "@/modules/mail/layout";
import { getBookingHost, getAvailability, type Availability } from "./public-booking";
import { getCalendarProvider, type CalendarCredentials } from "./calendar";
import { getWriteAccount, saveRefreshedTokens } from "./credentials";
import { calendarFailureActivity } from "./logic";
import { enqueueMeetingBrief } from "./enqueue";
import { botVerdict, MIN_FILL_MS } from "./botcheck";
import { takeRateLimit } from "@/lib/rate-limit";
import { RATE_LIMITS, retryAfterSeconds } from "@/lib/rate-limit-policy";
import { notifyMeetingBooked } from "../notifications/notify";
import type { WorkspaceBrand } from "@/modules/workspaces/brand";

const bookSchema = z.object({
  slug: z.string().min(1),
  meetingTypeId: z.string().min(1),
  startMs: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  company: z.string().trim().max(160).optional().default(""),
  email: z.string().trim().email(),
  // bot protection
  honeypot: z.string().default(""),
  renderedAt: z.coerce.number().int().nonnegative().default(0),
});

export type BookingResult =
  | { ok: true; label: string }
  | { ok: false; error: string };

/** Re-read availability for a meeting type (used when the visitor switches type). */
export async function loadAvailability(
  slug: string,
  meetingTypeId: string,
): Promise<Availability | null> {
  const host = await getBookingHost(slug);
  if (!host) return null;
  return getAvailability(host, meetingTypeId, Date.now());
}

export async function submitPublicBooking(raw: unknown): Promise<BookingResult> {
  const parsed = bookSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Please check the form and try again." };
  const input = parsed.data;
  const now = Date.now();

  // --- abuse controls (no third-party CAPTCHA) ---
  const h = await headers();
  const ip = (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "unknown").trim();
  // Redis-backed rather than the old process-local Map (P6/2): an in-memory
  // bucket empties on every deploy and is not shared across processes, which
  // makes it an abuse control that stops working exactly when it is needed.
  const rate = await takeRateLimit(`${RATE_LIMITS.booking.bucket}:${ip}`, RATE_LIMITS.booking);
  if (!rate.allowed) {
    const wait = retryAfterSeconds(rate.resetAtMs, now);
    return {
      ok: false,
      error: `Too many attempts. Please wait ${wait} second${wait === 1 ? "" : "s"} and try again.`,
    };
  }
  const bot = botVerdict({
    honeypot: input.honeypot,
    elapsedMs: now - input.renderedAt,
    minElapsedMs: MIN_FILL_MS,
  });
  if (!bot.ok) {
    // Silent-ish: give a generic message, don't reveal which check tripped.
    return { ok: false, error: "We couldn't verify your submission. Please try again." };
  }

  const host = await getBookingHost(input.slug);
  if (!host) return { ok: false, error: "This booking page is unavailable." };

  const mt = host.meetingTypes.find((t) => t.id === input.meetingTypeId);
  if (!mt) return { ok: false, error: "Unknown meeting type." };

  // --- server-side slot validation (never trust the posted time) ---
  const avail = await getAvailability(host, input.meetingTypeId, now);
  const stillFree = avail.days.some((d) => d.slots.some((s) => s.startMs === input.startMs));
  if (!stillFree) {
    return { ok: false, error: "That time was just taken. Please pick another slot." };
  }

  const db = getWorkspaceClient(host.workspaceId);
  const start = new Date(input.startMs);
  const end = new Date(input.startMs + mt.durationMin * 60_000);

  // --- find-or-create company + lead (inbound) ---
  let company = input.company
    ? await db.company.findFirst({ where: { name: input.company } })
    : null;
  if (!company && input.company) {
    company = await db.company.create({
      data: { workspaceId: host.workspaceId, name: input.company },
    });
  }
  let lead = await db.lead.findFirst({ where: { email: input.email } });
  if (!lead) {
    lead = await db.lead.create({
      data: {
        workspaceId: host.workspaceId,
        companyId: company?.id,
        contactName: input.name,
        email: input.email,
        source: "MANUAL",
        stage: "RESEARCHED",
        notes: "Booked via public booking page.",
      },
    });
    await emitLeadCreated(host.workspaceId, lead.id);
  }

  // --- create the meeting ---
  const meeting = await db.meeting.create({
    data: {
      workspaceId: host.workspaceId,
      leadId: lead.id,
      hostUserId: host.hostUserId,
      scheduledAt: start,
      durationMin: mt.durationMin,
      type: mt.label,
      briefStatus: "none",
    },
  });

  // P6/1 — a booking from the PUBLIC page is the one nobody is watching a
  // screen for, so the notification matters more here than in the app path.
  await notifyMeetingBooked({
    workspaceId: host.workspaceId,
    meetingId: meeting.id,
    leadId: lead.id,
    hostUserId: host.hostUserId,
    scheduledAt: start,
  });
  // Outbound (P5/5.2), for the same reason the notification matters more here:
  // this is the booking nobody is watching a screen for.
  await emitWebhookEvent(host.workspaceId, "meeting.booked", {
    meetingId: meeting.id,
    leadId: lead.id,
    scheduledAt: start.toISOString(),
    durationMin: mt.durationMin,
    type: mt.label,
    source: "public_booking_page",
  });

  // --- drop the event on the host calendar with the visitor attached ---
  const cal = getCalendarProvider();
  try {
    // Meetings always land on the write calendar. Any other connected account
    // is busy-check only and is never written to.
    const acct = await getWriteAccount(host.hostUserId);
    if (cal.name === "google" && !acct) throw new Error("google_calendar_not_connected");
    const creds: CalendarCredentials = acct
      ? acct.creds
      : { accessToken: "", refreshToken: null, expiryDate: null, calendarId: null };
    const { result, refreshed } = await cal.createEvent(creds, {
      summary: `Venture · ${input.name}${input.company ? ` (${input.company})` : ""}`,
      description: [
        `Booked via ${host.slug} booking page.`,
        `${mt.label}`,
        `Guest: ${input.name} <${input.email}>`,
        input.company && `Company: ${input.company}`,
      ]
        .filter(Boolean)
        .join("\n"),
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      attendees: [input.email],
      timeZone: host.config.timezone,
    });
    await db.meeting.update({
      where: { id: meeting.id },
      data: { googleEventId: result.eventId, eventUrl: result.htmlLink },
    });
    if (refreshed && acct) await saveRefreshedTokens(acct.id, refreshed);
  } catch (e) {
    // Calendar failure lands in the Today Queue (spec §4.8/§4.21).
    const act = calendarFailureActivity({
      meetingId: meeting.id,
      leadId: lead.id,
      error: (e as Error).message,
    });
    await db.activity.create({
      data: { workspaceId: host.workspaceId, leadId: lead.id, type: act.type, payload: act.payload },
    });
  }

  // --- advance the pipeline + trigger the brief (one call per booking) ---
  await db.lead.update({
    where: { id: lead.id },
    data: { stage: "MEETING_BOOKED", stageEnteredAt: new Date(), lastActivityAt: new Date() },
  });
  await db.activity.create({
    data: {
      workspaceId: host.workspaceId,
      leadId: lead.id,
      type: "stage_change",
      payload: { from: lead.stage, to: "MEETING_BOOKED", via: "booking_page" },
    },
  });
  try {
    await enqueueMeetingBrief({ meetingId: meeting.id, workspaceId: host.workspaceId });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[booking] brief enqueue failed", e);
  }

  // --- confirmations both ways (Mailgun; best-effort) ---
  const whenLabel = formatWhen(input.startMs, host.config.timezone);
  await sendConfirmations({
    identity: resolveSendingIdentity(host.mailgunConfig, host.brand),
    brand: host.brand,
    hostName: host.hostName,
    hostEmail: host.hostEmail,
    guestName: input.name,
    guestEmail: input.email,
    typeLabel: mt.label,
    whenLabel,
  });

  return { ok: true, label: whenLabel };
}

function formatWhen(startMs: number, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${fmt.format(new Date(startMs))} (${tz})`;
}

async function sendConfirmations(p: {
  identity: ReturnType<typeof resolveSendingIdentity>;
  /** The owning workspace's brand — this is a prospect-facing confirmation. */
  brand: WorkspaceBrand;
  hostName: string;
  hostEmail: string | null;
  guestName: string;
  guestEmail: string;
  typeLabel: string;
  whenLabel: string;
}): Promise<void> {
  const mail = getMailProvider();

  // Prospect-facing, so it carries the brand rather than browser defaults.
  const guest = {
    brand: p.brand,
    preheader: `${p.typeLabel} with ${p.hostName} — ${p.whenLabel}`,
    heading: "Your meeting is confirmed",
    paragraphs: [
      `Hi ${p.guestName}, thanks for booking.`,
      "Reply to this email if you need to move it — it reaches your host directly.",
    ],
    rows: [
      { label: "What", value: p.typeLabel },
      { label: "When", value: p.whenLabel },
      { label: "With", value: p.hostName },
    ],
  };
  const guestHtml = brandEmail(guest);
  const guestText = brandEmailText(guest);

  const host = {
    brand: p.brand,
    preheader: `${p.guestName} booked ${p.typeLabel}`,
    heading: "New booking from your page",
    paragraphs: [
      `${p.guestName} (${p.guestEmail}) booked a ${p.typeLabel}.`,
      "The meeting brief is being generated and will be on the lead.",
    ],
    rows: [
      { label: "Guest", value: `${p.guestName} <${p.guestEmail}>` },
      { label: "When", value: p.whenLabel },
    ],
  };
  const hostHtml = brandEmail(host);
  const hostText = brandEmailText(host);
  try {
    await mail.send({
      domain: p.identity.domain,
      to: p.guestEmail,
      from: p.identity.from,
      replyTo: p.hostEmail || p.identity.replyTo || undefined,
      subject: `Confirmed: ${p.typeLabel} — ${p.whenLabel}`,
      html: guestHtml,
      text: guestText,
    });
    if (p.hostEmail) {
      await mail.send({
        domain: p.identity.domain,
        to: p.hostEmail,
        from: p.identity.from,
        subject: `New booking: ${p.guestName} — ${p.whenLabel}`,
        html: hostHtml,
        text: hostText,
      });
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[booking] confirmation email failed", e);
  }
}
