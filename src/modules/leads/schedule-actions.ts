"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";
import { EXPORT_FORMATS } from "./export-formats";
import {
  EXPORT_CADENCES,
  describeSchedule,
  nextRunAt,
  type ExportCadence,
} from "./schedule-logic";

/**
 * Scheduled exports of a saved view (P2/2.1).
 *
 * Gated on `exports.run` — the same capability the manual export needs. A
 * schedule is an export that happens without anybody pressing the button, so
 * it cannot be a weaker second door to the same data.
 */

export interface ScheduleView {
  id: string;
  viewId: string;
  viewName: string;
  format: string;
  cadence: string;
  dayOfWeek: number;
  dayOfMonth: number;
  hour: number;
  recipients: string[];
  enabled: boolean;
  /** A sentence a person can check against what they meant. */
  description: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  /** True when the signed-in user set it up. */
  mine: boolean;
}

export async function listSchedules(): Promise<ScheduleView[]> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.scheduledExport.findMany({
    include: { view: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    viewId: r.viewId,
    viewName: r.view.name,
    format: r.format,
    cadence: r.cadence,
    dayOfWeek: r.dayOfWeek,
    dayOfMonth: r.dayOfMonth,
    hour: r.hour,
    recipients: Array.isArray(r.recipients) ? (r.recipients as string[]) : [],
    enabled: r.enabled,
    description: describeSchedule({
      cadence: r.cadence as ExportCadence,
      dayOfWeek: r.dayOfWeek,
      dayOfMonth: r.dayOfMonth,
      hour: r.hour,
    }),
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    nextRunAt: r.nextRunAt?.toISOString() ?? null,
    lastError: r.lastError,
    mine: r.userId === userId,
  }));
}

const saveSchema = z.object({
  id: z.string().min(1).optional(),
  viewId: z.string().min(1),
  format: z.enum(EXPORT_FORMATS),
  cadence: z.enum(EXPORT_CADENCES),
  dayOfWeek: z.coerce.number().int().min(1).max(7).default(1),
  dayOfMonth: z.coerce.number().int().min(1).max(28).default(1),
  hour: z.coerce.number().int().min(0).max(23).default(8),
  /** Empty means "whoever set it up". */
  recipients: z.array(z.string().trim().email()).max(10).default([]),
});

export async function saveSchedule(
  raw: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    await requireGrant("exports.run");
  } catch {
    return { ok: false, error: "You need the exports.run capability to schedule an export." };
  }
  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Check the schedule — one of the values is out of range." };
  }
  const input = parsed.data;
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  // The view has to be one this workspace can see; the guarded client makes a
  // foreign id simply find nothing.
  const view = await db.savedView.findUnique({
    where: { id: input.viewId },
    select: { id: true, ownerId: true, shared: true },
  });
  if (!view) return { ok: false, error: "That saved view no longer exists." };
  if (!view.shared && view.ownerId !== userId) {
    // A personal view is one person's filter. Scheduling somebody else's would
    // email a list they can change without knowing anybody is receiving it.
    return { ok: false, error: "That view is personal to somebody else. Ask them to share it first." };
  }

  const spec = {
    cadence: input.cadence,
    dayOfWeek: input.dayOfWeek,
    dayOfMonth: input.dayOfMonth,
    hour: input.hour,
  };
  const next = nextRunAt(spec, new Date());

  const data = {
    workspaceId,
    viewId: input.viewId,
    userId,
    format: input.format,
    cadence: input.cadence,
    dayOfWeek: input.dayOfWeek,
    dayOfMonth: input.dayOfMonth,
    hour: input.hour,
    recipients: input.recipients,
    enabled: true,
    nextRunAt: next,
    // A schedule that just changed has not failed yet.
    lastError: null,
  };

  const row = input.id
    ? await db.scheduledExport.update({ where: { id: input.id }, data, select: { id: true } })
    : await db.scheduledExport.create({ data, select: { id: true } });

  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: input.id ? "export.schedule_changed" : "export.scheduled",
      entityType: "SavedView",
      entityId: input.viewId,
      meta: { format: input.format, schedule: describeSchedule(spec), recipients: input.recipients },
    },
  });

  revalidatePath("/leads");
  return { ok: true, id: row.id };
}

export async function setScheduleEnabled(
  id: string,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireGrant("exports.run");
  } catch {
    return { ok: false, error: "You need the exports.run capability." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const row = await db.scheduledExport.findUnique({
    where: { id },
    select: { cadence: true, dayOfWeek: true, dayOfMonth: true, hour: true },
  });
  if (!row) return { ok: false, error: "That schedule no longer exists." };

  await db.scheduledExport.update({
    where: { id },
    data: {
      enabled,
      // Re-enabling recomputes the next slot: an old `nextRunAt` in the past
      // would fire immediately, which is not what "turn it back on" means.
      nextRunAt: enabled
        ? nextRunAt(
            {
              cadence: row.cadence as ExportCadence,
              dayOfWeek: row.dayOfWeek,
              dayOfMonth: row.dayOfMonth,
              hour: row.hour,
            },
            new Date(),
          )
        : null,
      lastError: null,
    },
  });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: enabled ? "export.schedule_enabled" : "export.schedule_paused",
      entityType: "ScheduledExport",
      entityId: id,
    },
  });
  revalidatePath("/leads");
  return { ok: true };
}

export async function deleteSchedule(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireGrant("exports.run");
  } catch {
    return { ok: false, error: "You need the exports.run capability." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.scheduledExport.deleteMany({ where: { id } });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "export.schedule_deleted",
      entityType: "ScheduledExport",
      entityId: id,
    },
  });
  revalidatePath("/leads");
  return { ok: true };
}

/**
 * Send it now, without waiting for the slot.
 *
 * The only way to find out whether a schedule produces what somebody expected
 * is to see the email — and waiting until Monday to learn the filter was wrong
 * is how a schedule gets set up, forgotten, and quietly never checked.
 */
export async function runScheduleNow(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireGrant("exports.run");
  } catch {
    return { ok: false, error: "You need the exports.run capability." };
  }
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const row = await db.scheduledExport.findUnique({ where: { id }, select: { id: true } });
  if (!row) return { ok: false, error: "That schedule no longer exists." };

  // Queued rather than run inline: a PDF needs Chromium, which only the worker
  // image has, and a request must not wait on a spreadsheet build either.
  await prismaUnsafe.scheduledExport.update({
    where: { id },
    data: { nextRunAt: new Date(0) },
  });
  revalidatePath("/leads");
  return { ok: true };
}
