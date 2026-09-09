"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { recordUndo, type UndoToken } from "../undo/store";
import { localDayKey } from "./time-logic";

/**
 * Who is carrying what, over a range (playbook-v5 P19/3).
 *
 * ── UNASSIGNED WORK IS A ROW, NOT AN OMISSION ───────────────────────────────
 *
 * The playbook asks for it explicitly and it is the most useful row on the
 * screen: work nobody owns is the work that gets forgotten, and a capacity
 * view that quietly excludes it reports a team as comfortable while a pile of
 * unowned tasks sits beside it.
 */

export interface WorkloadTaskRow {
  id: string;
  title: string;
  dueAt: string | null;
  estimateMinutes: number | null;
  assigneeId: string | null;
  priority: string;
}

export interface WorkloadMember {
  id: string;
  name: string;
  /** Teams they are in, for the optional grouping. */
  teams: string[];
}

export interface WorkloadData {
  tasks: WorkloadTaskRow[];
  members: WorkloadMember[];
  days: string[];
}

const rangeSchema = z.object({
  from: z.string().min(10).max(30),
  days: z.number().int().min(1).max(60),
  boardId: z.string().min(1).max(60).nullable().optional(),
});

export async function getWorkload(raw: unknown): Promise<WorkloadData> {
  const parsed = rangeSchema.safeParse(raw);
  if (!parsed.success) return { tasks: [], members: [], days: [] };
  const from = new Date(parsed.data.from);
  if (Number.isNaN(from.getTime())) return { tasks: [], members: [], days: [] };

  const days: string[] = [];
  for (let i = 0; i < parsed.data.days; i += 1) {
    const day = new Date(from);
    day.setDate(day.getDate() + i);
    days.push(localDayKey(day));
  }
  const to = new Date(from);
  to.setDate(to.getDate() + parsed.data.days);

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const [tasks, memberships, teamRows] = await Promise.all([
    db.task.findMany({
      where: {
        doneAt: null,
        dueAt: { gte: from, lt: to },
        ...(parsed.data.boardId ? { boardId: parsed.data.boardId } : {}),
      },
      select: {
        id: true,
        title: true,
        dueAt: true,
        estimateMinutes: true,
        assigneeId: true,
        priority: true,
      },
      take: 2000,
    }),
    prismaUnsafe.membership.findMany({
      // Only people who can actually be given work: an INVITED or REMOVED
      // membership on a capacity chart is a column nobody can fill.
      where: { workspaceId, state: "ACTIVE" },
      select: { userId: true, user: { select: { name: true } } },
    }),
    db.teamMember.findMany({
      select: { userId: true, team: { select: { name: true } } },
    }),
  ]);

  const teamsByUser = new Map<string, string[]>();
  for (const row of teamRows) {
    teamsByUser.set(row.userId, [...(teamsByUser.get(row.userId) ?? []), row.team.name]);
  }

  return {
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      dueAt: t.dueAt?.toISOString() ?? null,
      estimateMinutes: t.estimateMinutes,
      assigneeId: t.assigneeId,
      priority: t.priority,
    })),
    members: memberships.map((m) => ({
      id: m.userId,
      name: m.user.name,
      teams: teamsByUser.get(m.userId) ?? [],
    })),
    days,
  };
}

/**
 * Reassign by dragging a task from one row to another.
 *
 * Undoable, and refuses anybody who cannot hold work — the same rule the
 * inline edit and the bulk action enforce, in the same words.
 */
export async function reassignTask(
  taskId: string,
  assigneeId: string | null,
): Promise<{ ok: true; undo: UndoToken | null } | { ok: false; error: string }> {
  const task = z.string().min(1).max(60).safeParse(taskId);
  const who = z.string().min(1).max(60).nullable().safeParse(assigneeId);
  if (!task.success || !who.success) return { ok: false, error: "That is not a valid move." };

  const { workspaceId, userId } = await getActiveContext();
  if (who.data) {
    const member = await prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId: who.data, workspaceId } },
      select: { state: true },
    });
    if (!member) return { ok: false, error: "That person is not in this workspace." };
    if (member.state !== "ACTIVE") {
      return { ok: false, error: "That person's access is suspended — give it to somebody else." };
    }
  }

  const db = getWorkspaceClient(workspaceId);
  const before = await db.task.findUnique({
    where: { id: task.data },
    select: { id: true, title: true, assigneeId: true },
  });
  if (!before) return { ok: false, error: "Task not found." };
  if (before.assigneeId === who.data) return { ok: true, undo: null };

  await db.task.update({ where: { id: before.id }, data: { assigneeId: who.data } });

  const undo = await recordUndo(workspaceId, userId, {
    kind: "bulk_owner",
    label: who.data ? `Reassigned “${before.title}”` : `Unassigned “${before.title}”`,
    inverse: {
      entity: "task",
      targets: [{ id: before.id, set: { assigneeId: before.assigneeId } }],
    },
    expected: { [before.id]: { assigneeId: who.data } },
  });

  revalidatePath("/tasks");
  revalidatePath("/");
  return { ok: true, undo };
}
