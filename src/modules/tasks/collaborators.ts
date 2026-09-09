/**
 * Collaborators, delegation and the trail (playbook-v5 P20/6).
 *
 * ── ONE OWNER, AND THE PEOPLE HELPING ───────────────────────────────────────
 *
 * `assigneeId` stays a single column. Everything here is about the other two
 * relationships: a collaborator is working on the task, a follower is watching
 * it, and the difference is whether it shows up in their own list of work.
 *
 * ── AND WHY THE HANDOVER IS RECORDED TWICE ──────────────────────────────────
 *
 * `delegatedBy`/`delegatedAt` on the task, so the card can say "handed over by
 * Anna" without reading a history for every row; and a `TaskEvent` row, so a
 * task that went Anna → Béla → Anna over three days can be seen for what it
 * is. The columns are the current state; the events are what happened.
 */

import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { assignmentKind, describeTaskEvent, type TaskEventKind, type TaskEventView } from "./events";

export interface CollaboratorView {
  userId: string;
  name: string;
  addedBy: string | null;
}

/** Record one thing that happened. Never fails the write it rode in on. */
export async function recordTaskEvent(
  workspaceId: string,
  input: {
    taskId: string;
    kind: TaskEventKind;
    userId?: string | null;
    actorUserId?: string | null;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  const db = getWorkspaceClient(workspaceId);
  await db.taskEvent
    .create({
      data: {
        workspaceId,
        taskId: input.taskId,
        kind: input.kind,
        userId: input.userId ?? null,
        actorUserId: input.actorUserId ?? null,
        before: (input.before ?? null) as never,
        after: (input.after ?? null) as never,
      },
    })
    .catch(() => {
      // The trail is evidence, not a dependency.
    });
}

/**
 * Apply a change of assignee, with everything that goes with it.
 *
 * One function, called from every place a task can be reassigned — the detail
 * panel, the inline cell, the bulk bar, a workflow rule — because the
 * delegation trail is worthless if three of the four paths forget to write it.
 */
export async function applyAssignment(
  workspaceId: string,
  taskId: string,
  input: { before: string | null; after: string | null; actorUserId: string | null },
): Promise<TaskEventKind | null> {
  const kind = assignmentKind(input.before, input.after);
  if (!kind) return null;

  const db = getWorkspaceClient(workspaceId);
  await db.task.update({
    where: { id: taskId },
    data: {
      assigneeId: input.after,
      /**
       * Only a HANDOVER sets these. First assignment is not a delegation —
       * nobody handed it over — and stamping it as one would make the trail
       * meaningless on every board where tasks start unassigned.
       */
      ...(kind === "delegated"
        ? { delegatedBy: input.actorUserId, delegatedAt: new Date() }
        : {}),
      // Unassigning clears the handover: there is nobody it was handed to.
      ...(kind === "unassigned" ? { delegatedBy: null, delegatedAt: null } : {}),
    },
  });

  await recordTaskEvent(workspaceId, {
    taskId,
    kind,
    userId: input.after,
    actorUserId: input.actorUserId,
    before: { assigneeId: input.before },
    after: { assigneeId: input.after },
  });
  return kind;
}

export async function listCollaborators(
  workspaceId: string,
  taskId: string,
): Promise<CollaboratorView[]> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.taskCollaborator.findMany({
    where: { taskId },
    orderBy: { createdAt: "asc" },
    select: { userId: true, addedBy: true },
  });
  if (rows.length === 0) return [];
  const users = await prismaUnsafe.user.findMany({
    where: { id: { in: rows.map((r) => r.userId) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    userId: r.userId,
    name: nameOf.get(r.userId) ?? "somebody",
    addedBy: r.addedBy,
  }));
}

export async function addCollaborator(
  workspaceId: string,
  taskId: string,
  userId: string,
  actorUserId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getWorkspaceClient(workspaceId);
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, assigneeId: true },
  });
  if (!task) return { ok: false, error: "Task not found." };

  const member = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { userId: true },
  });
  if (!member) return { ok: false, error: "That person is not in this workspace." };

  /**
   * The assignee is not a collaborator on their own task. They already own it,
   * and listing them twice would make the panel say two different things about
   * one relationship.
   */
  if (task.assigneeId === userId) {
    return { ok: false, error: "They already own this task." };
  }

  const existing = await db.taskCollaborator.findFirst({
    where: { taskId, userId },
    select: { id: true },
  });
  if (existing) return { ok: false, error: "They are already a collaborator." };

  await db.taskCollaborator.create({
    data: { workspaceId, taskId, userId, addedBy: actorUserId },
  });
  /**
   * A collaborator also follows the task — they are working on it, so they
   * should hear about comments. Following is the weaker relationship, so this
   * direction is safe; the reverse is not, which is why a follower is not
   * promoted to a collaborator.
   */
  await db.taskFollower
    .upsert({
      where: { taskId_userId: { taskId, userId } },
      update: {},
      create: { workspaceId, taskId, userId },
    })
    .catch(() => null);

  await recordTaskEvent(workspaceId, {
    taskId,
    kind: "collaborator_added",
    userId,
    actorUserId,
  });
  return { ok: true };
}

export async function removeCollaborator(
  workspaceId: string,
  taskId: string,
  userId: string,
  actorUserId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getWorkspaceClient(workspaceId);
  const { count } = await db.taskCollaborator.deleteMany({ where: { taskId, userId } });
  if (count === 0) return { ok: false, error: "They are not a collaborator on this." };
  /**
   * The follower row stays. Somebody taken off the work may still want to know
   * how it ends, and silently unsubscribing them is a decision that is not
   * ours to make.
   */
  await recordTaskEvent(workspaceId, {
    taskId,
    kind: "collaborator_removed",
    userId,
    actorUserId,
  });
  return { ok: true };
}

/** Task ids this person is collaborating on — the My Work toggle. */
export async function collaboratingTaskIds(
  workspaceId: string,
  userId: string,
): Promise<string[]> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.taskCollaborator.findMany({
    where: { userId },
    select: { taskId: true },
  });
  return rows.map((r) => r.taskId);
}

/** The trail, newest first, with the names filled in. */
export async function taskTrail(
  workspaceId: string,
  taskId: string,
  limit = 20,
): Promise<Array<TaskEventView & { text: string }>> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.taskEvent.findMany({
    where: { taskId },
    orderBy: { at: "desc" },
    take: limit,
  });
  if (rows.length === 0) return [];

  const ids = new Set<string>();
  for (const row of rows) {
    if (row.userId) ids.add(row.userId);
    if (row.actorUserId) ids.add(row.actorUserId);
    const before = row.before as { assigneeId?: string | null } | null;
    if (before?.assigneeId) ids.add(before.assigneeId);
  }
  const users = await prismaUnsafe.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));

  return rows.map((row) => {
    const before = row.before as { assigneeId?: string | null } | null;
    const view: TaskEventView = {
      id: row.id,
      kind: row.kind as TaskEventKind,
      at: row.at.toISOString(),
      actorName: row.actorUserId ? (nameOf.get(row.actorUserId) ?? null) : null,
      userName: row.userId ? (nameOf.get(row.userId) ?? null) : null,
      fromName: before?.assigneeId ? (nameOf.get(before.assigneeId) ?? null) : null,
    };
    return { ...view, text: describeTaskEvent(view) };
  });
}
