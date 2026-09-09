"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import { getWorkspaceClient } from "@/lib/db";
import { recordUndo, type UndoToken } from "../undo/store";
import { dueDateForDay, spanForDrop } from "./calendar";

/**
 * What the calendar reads and writes (playbook-v5 P19/2).
 *
 * ── THE OVERLAYS ARE SEPARATE LISTS, ON PURPOSE ─────────────────────────────
 *
 * Meetings and callbacks come back beside the tasks rather than folded in with
 * them, because the whole point of the overlays is that they can be turned off
 * INDIVIDUALLY — and because they are not tasks: a meeting is not something
 * you tick, and a callback belongs to a call record. Merging them into one
 * list would mean the UI had to unpick them again to render or hide them.
 */

export interface CalendarRow {
  id: string;
  title: string;
  at: string;
  doneAt: string | null;
  priority: string;
  href: string | null;
}

export interface CalendarData {
  tasks: CalendarRow[];
  meetings: CalendarRow[];
  callbacks: CalendarRow[];
}

const rangeSchema = z.object({
  from: z.string().min(10).max(30),
  to: z.string().min(10).max(30),
  /** Null for "every board" — the calendar is a personal week, not a board. */
  boardId: z.string().min(1).max(60).nullable().optional(),
  mineOnly: z.boolean().optional(),
});

export async function getCalendar(raw: unknown): Promise<CalendarData> {
  const parsed = rangeSchema.safeParse(raw);
  if (!parsed.success) return { tasks: [], meetings: [], callbacks: [] };
  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { tasks: [], meetings: [], callbacks: [] };
  }

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const [tasks, meetings, calls] = await Promise.all([
    db.task.findMany({
      where: {
        dueAt: { gte: from, lte: to },
        ...(parsed.data.boardId ? { boardId: parsed.data.boardId } : {}),
        ...(parsed.data.mineOnly ? { assigneeId: userId } : {}),
      },
      select: { id: true, title: true, dueAt: true, doneAt: true, priority: true, boardId: true },
      take: 500,
    }),
    db.meeting.findMany({
      where: { scheduledAt: { gte: from, lte: to } },
      select: {
        id: true,
        scheduledAt: true,
        type: true,
        lead: { select: { contactName: true, company: { select: { name: true } } } },
      },
      take: 300,
    }),
    db.call.findMany({
      where: { callbackAt: { gte: from, lte: to }, callbackDoneAt: null },
      select: {
        id: true,
        callbackAt: true,
        leadId: true,
        lead: { select: { contactName: true, company: { select: { name: true } } } },
      },
      take: 300,
    }),
  ]);

  return {
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      at: t.dueAt!.toISOString(),
      doneAt: t.doneAt?.toISOString() ?? null,
      priority: t.priority,
      href: t.boardId ? `/tasks?board=${t.boardId}&task=${t.id}` : `/tasks?task=${t.id}`,
    })),
    meetings: meetings.map((m) => ({
      id: m.id,
      title: `${m.lead?.contactName || m.lead?.company?.name || "Meeting"}${m.type ? ` · ${m.type}` : ""}`,
      at: m.scheduledAt.toISOString(),
      doneAt: null,
      priority: "none",
      href: "/meetings",
    })),
    callbacks: calls.map((c) => ({
      id: c.id,
      title: `Call back ${c.lead?.contactName || c.lead?.company?.name || "a lead"}`,
      at: c.callbackAt!.toISOString(),
      doneAt: null,
      priority: "none",
      href: "/calls",
    })),
  };
}

const dropSchema = z.object({
  taskId: z.string().min(1).max(60),
  day: z.string().min(10).max(30),
  /** Present when the drag spanned days in week view. */
  throughDay: z.string().min(10).max(30).nullable().optional(),
});

/**
 * A task dropped on a day.
 *
 * One day sets the due date; a span sets a start AND a due date, which is what
 * dragging across columns in week view means. Undoable, like every other drag
 * in the product.
 */
export async function dropTaskOnDay(
  raw: unknown,
): Promise<{ ok: true; undo: UndoToken | null } | { ok: false; error: string }> {
  const parsed = dropSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That drop is not valid." };

  const day = new Date(parsed.data.day);
  if (Number.isNaN(day.getTime())) return { ok: false, error: "That is not a date." };
  const through = parsed.data.throughDay ? new Date(parsed.data.throughDay) : null;
  if (through && Number.isNaN(through.getTime())) {
    return { ok: false, error: "That is not a date." };
  }

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const before = await db.task.findUnique({
    where: { id: parsed.data.taskId },
    select: { id: true, title: true, startAt: true, dueAt: true },
  });
  if (!before) return { ok: false, error: "Task not found." };

  const next = through
    ? spanForDrop(day, through)
    : { startAt: before.startAt, dueAt: dueDateForDay(day) };

  // The same rule every other date write enforces.
  if (next.startAt && next.dueAt && next.startAt.getTime() > next.dueAt.getTime()) {
    return { ok: false, error: "A task cannot be due before it starts." };
  }

  await db.task.update({
    where: { id: before.id },
    data: { startAt: next.startAt, dueAt: next.dueAt },
  });

  const undo = await recordUndo(workspaceId, userId, {
    kind: "bulk_signals",
    label: `Rescheduled “${before.title}”`,
    inverse: {
      entity: "task",
      targets: [{ id: before.id, set: { startAt: before.startAt, dueAt: before.dueAt } }],
    },
    expected: {
      [before.id]: {
        startAt: next.startAt ? next.startAt.toISOString() : null,
        dueAt: next.dueAt ? next.dueAt.toISOString() : null,
      },
    },
  });

  revalidatePath("/tasks");
  revalidatePath("/");
  return { ok: true, undo };
}

/** Unscheduled work, for the week view's side rail. */
export async function getUnscheduled(boardId: string | null): Promise<CalendarRow[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.task.findMany({
    where: {
      dueAt: null,
      doneAt: null,
      ...(boardId ? { boardId } : {}),
    },
    select: { id: true, title: true, priority: true, boardId: true },
    orderBy: { position: "asc" },
    take: 100,
  });
  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    at: "",
    doneAt: null,
    priority: t.priority,
    href: t.boardId ? `/tasks?board=${t.boardId}&task=${t.id}` : `/tasks?task=${t.id}`,
  }));
}
