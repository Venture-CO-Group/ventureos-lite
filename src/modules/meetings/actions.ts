"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { emitWebhookEvent } from "../webhooks/emit";
import { moveLeadStage } from "@/modules/leads/actions";
import { onMeetingOutcome } from "../workflow/triggers";
import { getCalendarProvider, type CalendarCredentials } from "./calendar";
import { getWriteAccount, saveRefreshedTokens } from "./credentials";
import { calendarFailureActivity, type BriefStatus } from "./logic";
import { enqueueMeetingBrief } from "./enqueue";
import { notifyMeetingBooked } from "../notifications/notify";
import { buildFollowupKit, kitFrom } from "./followup";

// ---- views (plain data for the client) ------------------------------------

export interface MeetingRow {
  id: string;
  leadId: string | null;
  leadName: string;
  company: string;
  scheduledAt: string;
  durationMin: number;
  type: string | null;
  briefStatus: BriefStatus;
  hasEvent: boolean;
  outcome: string | null;
}

export interface MeetingDetail extends MeetingRow {
  brief: string | null;
  briefPdfPath: string | null;
  eventUrl: string | null;
  /**
   * The follow-up kit and what has been DONE with it (playbook-v4 P13/2).
   *
   * The done-state is read from the things themselves — the draft's status, the
   * quote's existence, the task's done flag — rather than stored, so the
   * checklist cannot disagree with what it describes.
   */
  followup: {
    builtAt: string;
    draftMessageId: string | null;
    draftSent: boolean;
    draftError: string | null;
    attachments: Array<{ label: string; path: string }>;
    quoteLines: Array<{ category: string; description: string; suggestedNet: number }>;
    quoteCreated: boolean;
    taskDone: boolean;
  } | null;
}

function leadName(lead: { contactName: string | null; company: { name: string } | null } | null): string {
  return lead?.contactName ?? lead?.company?.name ?? "Unknown lead";
}

// ---- 4.8 Booking -----------------------------------------------------------

const bookSchema = z.object({
  leadId: z.string().min(1),
  scheduledAt: z.string().min(1), // ISO
  durationMin: z.coerce.number().int().min(15).max(240).default(30),
  type: z.string().optional(),
});

export async function bookMeeting(
  raw: unknown,
): Promise<{ ok: true; meetingId: string; calendarOk: boolean } | { ok: false; error: string }> {
  const input = bookSchema.parse(raw);
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const lead = await db.lead.findUnique({
    where: { id: input.leadId },
    include: { company: true },
  });
  if (!lead) return { ok: false, error: "Lead not found" };

  const start = new Date(input.scheduledAt);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "Invalid date/time" };
  const end = new Date(start.getTime() + input.durationMin * 60_000);

  const meeting = await db.meeting.create({
    data: {
      workspaceId,
      leadId: lead.id,
      hostUserId: userId,
      scheduledAt: start,
      durationMin: input.durationMin,
      type: input.type,
      briefStatus: "none",
    },
  });

  await notifyMeetingBooked({
    workspaceId,
    meetingId: meeting.id,
    leadId: lead.id,
    hostUserId: userId,
    scheduledAt: start,
  });
  // Outbound (P5/5.2). Queued before the calendar call below, deliberately: a
  // calendar that is not connected must not swallow the event.
  await emitWebhookEvent(workspaceId, "meeting.booked", {
    meetingId: meeting.id,
    leadId: lead.id,
    scheduledAt: start.toISOString(),
    durationMin: input.durationMin,
    type: input.type,
    source: "internal",
  });

  // Create the event on the host's calendar with lead context attached.
  const cal = getCalendarProvider();
  let calendarOk = true;
  try {
    // Internally-booked meetings go to the write calendar too.
    const acct = await getWriteAccount(userId);
    if (cal.name === "google" && !acct) throw new Error("google_calendar_not_connected");
    const creds: CalendarCredentials = acct
      ? {
          accessToken: acct.creds.accessToken,
          refreshToken: acct.creds.refreshToken,
          expiryDate: acct.creds.expiryDate,
          calendarId: acct.creds.calendarId,
        }
      : { accessToken: "", refreshToken: null, expiryDate: null, calendarId: null };

    const who = leadName(lead);
    const context = [
      `Prospect: ${who}${lead.title ? `, ${lead.title}` : ""}`,
      lead.company?.name && `Company: ${lead.company.name}`,
      lead.company?.website && `Website: ${lead.company.website}`,
      lead.email && `Email: ${lead.email}`,
      lead.phone && `Phone: ${lead.phone}`,
      `Venture brief follows once generated.`,
    ]
      .filter(Boolean)
      .join("\n");

    const { result, refreshed } = await cal.createEvent(creds, {
      summary: `Venture · ${who}`,
      description: context,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      attendees: lead.email ? [lead.email] : [],
    });
    await db.meeting.update({
      where: { id: meeting.id },
      data: { googleEventId: result.eventId, eventUrl: result.htmlLink },
    });
    if (refreshed && acct) await saveRefreshedTokens(acct.id, refreshed);
  } catch (e) {
    calendarOk = false;
    // Calendar failures land in the Today Queue (spec §4.8).
    const act = calendarFailureActivity({
      meetingId: meeting.id,
      leadId: lead.id,
      error: (e as Error).message,
    });
    await db.activity.create({
      data: { workspaceId, leadId: lead.id, type: act.type, payload: act.payload },
    });
  }

  // Advance the pipeline — this is what triggers automatic brief generation.
  await moveLeadStage(lead.id, "MEETING_BOOKED");

  revalidatePath("/meetings");
  revalidatePath("/pipeline");
  return { ok: true, meetingId: meeting.id, calendarOk };
}

// ---- 4.8 One-click brief (manual trigger; still one call per booking) ------

export async function generateMeetingBrief(
  meetingId: string,
): Promise<{ ok: true; queued: boolean } | { ok: false; error: string }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const meeting = await db.meeting.findUnique({
    where: { id: meetingId },
    select: { briefStatus: true },
  });
  if (!meeting) return { ok: false, error: "Meeting not found" };

  const status = meeting.briefStatus as BriefStatus;
  if (status === "generating" || status === "done") {
    return { ok: true, queued: false }; // already handled — idempotent
  }
  if (status === "error") {
    // Allow a manual retry by resetting the claim.
    await db.meeting.updateMany({
      where: { id: meetingId, briefStatus: "error" },
      data: { briefStatus: "none" },
    });
  }
  await enqueueMeetingBrief({ meetingId, workspaceId });
  revalidatePath("/meetings");
  return { ok: true, queued: true };
}

// ---- 4.8 Edit the brief ----------------------------------------------------

export async function updateBrief(meetingId: string, text: string): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.meeting.update({ where: { id: meetingId }, data: { brief: text } });
  revalidatePath("/meetings");
  return { ok: true };
}

// ---- 4.8 Post-meeting outcome (handoff) ------------------------------------

const outcomeSchema = z.object({
  meetingId: z.string().min(1),
  result: z.enum(["WON", "LOST", "POSTPONED"]),
  reason: z.string().optional(),
  value: z.coerce.number().int().min(0).optional(),
  competitor: z.string().optional(),
  /** Pasted notes from the meeting — the follow-up draft's raw material. */
  notes: z.string().max(8000).optional(),
  /** Service-map categories that actually came up (P13/2). */
  discussed: z.array(z.string()).max(12).optional(),
});

export async function logMeetingOutcome(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const input = outcomeSchema.parse(raw);
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const meeting = await db.meeting.findUnique({
    where: { id: input.meetingId },
    select: { leadId: true },
  });
  if (!meeting) return { ok: false, error: "Meeting not found" };

  await db.meeting.update({
    where: { id: input.meetingId },
    data: { outcome: input.result },
  });

  if (meeting.leadId) {
    await db.dealOutcome.create({
      data: {
        workspaceId,
        leadId: meeting.leadId,
        result: input.result,
        reason: input.reason,
        value: input.value,
        competitor: input.competitor,
      },
    });
    await db.activity.create({
      data: {
        workspaceId,
        leadId: meeting.leadId,
        type: "meeting_outcome",
        byUserId: userId,
        payload: { result: input.result, value: input.value ?? null },
      },
    });
    // The handoff point — advance to Handed off.
    await moveLeadStage(meeting.leadId, "HANDED_OFF");
  }
  /**
   * The follow-up kit (playbook-v4 P13/2).
   *
   * Built AFTER the outcome is safely recorded and the lead has moved, and
   * wrapped so it cannot undo either: the meeting happened whatever the drafter
   * does, and losing that fact because a Claude call failed would be a much
   * worse trade than a kit with one part missing.
   */
  try {
    const kit = await buildFollowupKit(db, workspaceId, {
      meetingId: input.meetingId,
      leadId: meeting.leadId,
      outcome: input.result,
      reason: input.reason,
      value: input.value,
      notes: input.notes,
      discussed: input.discussed ?? [],
    });
    await db.meeting.update({
      where: { id: input.meetingId },
      data: { followupKit: kit as unknown as object },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[meetings] follow-up kit failed", e);
  }

  // Workflow rules (P7/5), best-effort and last.
  await onMeetingOutcome(workspaceId, meeting.leadId, input.result);

  revalidatePath("/meetings");
  revalidatePath("/pipeline");
  return { ok: true };
}

// ---- reads -----------------------------------------------------------------

export async function listMeetings(): Promise<MeetingRow[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.meeting.findMany({
    orderBy: { scheduledAt: "desc" },
    take: 200,
    include: { lead: { include: { company: true } } },
  });
  return rows.map((m) => ({
    id: m.id,
    leadId: m.leadId,
    leadName: leadName(m.lead),
    company: m.lead?.company?.name ?? "",
    scheduledAt: m.scheduledAt.toISOString(),
    durationMin: m.durationMin,
    type: m.type,
    briefStatus: m.briefStatus as BriefStatus,
    hasEvent: !!m.googleEventId,
    outcome: m.outcome,
  }));
}

export async function getMeeting(meetingId: string): Promise<MeetingDetail | null> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const m = await db.meeting.findUnique({
    where: { id: meetingId },
    include: { lead: { include: { company: true } } },
  });
  if (!m) return null;

  const kit = kitFrom(m.followupKit);
  let followup: MeetingDetail["followup"] = null;
  if (kit) {
    const [draft, quote, task] = await Promise.all([
      kit.draftMessageId
        ? db.message.findUnique({ where: { id: kit.draftMessageId }, select: { status: true } })
        : Promise.resolve(null),
      // A quote written after the meeting is the one this kit led to.
      m.leadId
        ? db.document.findFirst({
            where: { leadId: m.leadId, type: "QUOTE", createdAt: { gte: new Date(kit.builtAt) } },
            select: { id: true },
          })
        : Promise.resolve(null),
      kit.taskId
        ? db.task.findUnique({ where: { id: kit.taskId }, select: { doneAt: true } })
        : Promise.resolve(null),
    ]);
    followup = {
      builtAt: kit.builtAt,
      draftMessageId: kit.draftMessageId,
      draftSent: draft?.status === "SENT",
      draftError: kit.draftError,
      attachments: kit.attachments,
      quoteLines: kit.quoteLines,
      quoteCreated: !!quote,
      taskDone: !!task?.doneAt,
    };
  }

  return {
    followup,
    id: m.id,
    leadId: m.leadId,
    leadName: leadName(m.lead),
    company: m.lead?.company?.name ?? "",
    scheduledAt: m.scheduledAt.toISOString(),
    durationMin: m.durationMin,
    type: m.type,
    briefStatus: m.briefStatus as BriefStatus,
    hasEvent: !!m.googleEventId,
    outcome: m.outcome,
    brief: m.brief,
    briefPdfPath: m.briefPdfPath,
    eventUrl: m.eventUrl,
  };
}

/**
 * Drop the stored Google Calendar credential for the signed-in host.
 *
 * There was no way to disconnect, and no way to reconnect either — once the
 * UI said "Connected" it was a dead end, which is exactly the state a host
 * lands in when the granted scopes turn out to be insufficient or the tokens
 * are revoked at Google.
 *
 * Only ever removes the caller's own credential; the row is keyed by user.
 */
export async function disconnectGoogleCalendar(credentialId: string): Promise<{ ok: true }> {
  const { workspaceId, userId } = await getActiveContext();
  // Scoped by userId as well as id: a credential id from another host must not
  // be removable by passing it in.
  const removed = await prismaUnsafe.googleCredential.deleteMany({
    where: { id: credentialId, userId },
  });
  if (removed.count === 0) return { ok: true };

  // If the write target just went, promote another account so meetings keep
  // landing somewhere rather than silently failing on the next booking.
  const rest = await prismaUnsafe.googleCredential.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, purpose: true },
  });
  if (rest.length > 0 && !rest.some((r) => r.purpose === "WRITE")) {
    await prismaUnsafe.googleCredential.update({
      where: { id: rest[0].id },
      data: { purpose: "WRITE" },
    });
  }

  await getWorkspaceClient(workspaceId).auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "calendar.disconnected",
      entityType: "GoogleCredential",
      entityId: credentialId,
      meta: {},
    },
  });
  revalidatePath("/meetings");
  return { ok: true };
}

/**
 * Choose which connected account meetings are written to. Exactly one is the
 * write target; every other connected account contributes busy times only.
 */
export async function setWriteCalendar(credentialId: string): Promise<{ ok: true }> {
  const { workspaceId, userId } = await getActiveContext();
  const target = await prismaUnsafe.googleCredential.findFirst({
    where: { id: credentialId, userId },
    select: { id: true, accountEmail: true },
  });
  if (!target) return { ok: true };

  await prismaUnsafe.googleCredential.updateMany({
    where: { userId },
    data: { purpose: "BUSY_ONLY" },
  });
  await prismaUnsafe.googleCredential.update({
    where: { id: target.id },
    data: { purpose: "WRITE" },
  });

  await getWorkspaceClient(workspaceId).auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "calendar.write_target_changed",
      entityType: "GoogleCredential",
      entityId: target.id,
      meta: { accountEmail: target.accountEmail },
    },
  });
  revalidatePath("/meetings");
  return { ok: true };
}
