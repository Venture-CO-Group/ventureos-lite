"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { recordUndo, type UndoToken } from "../undo/store";
import { TASK_TYPES, groupTasks, orderTasks, type GroupedTasks, type TaskLike } from "./logic";
import { chipFor } from "./links";

/**
 * Tasks (playbook-v2 P3/3).
 *
 * Everything goes through the guarded client, so a task is scoped to its
 * workspace by the same mechanism as every other business row.
 */
export interface TaskView extends TaskLike {
  type: string;
  assigneeId: string | null;
  /** Resolved label for whatever the task hangs off, for the list view. */
  entityLabel: string | null;
  entityHref: string | null;
  /**
   * The board this task lives on, and a link to it (P8/4).
   *
   * The dashboard panel and the task board were built separately and read the
   * same rows, which meant the dashboard could show you a task with no way to
   * reach the board it belongs to — the card, its subtasks, its comments, its
   * dependencies. A task you can tick but not open is half a task.
   */
  boardId: string | null;
  boardName: string | null;
  boardHref: string | null;
  /** How many unfinished things it is waiting on. Zero means startable. */
  blockedBy: number;
}

const createSchema = z.object({
  title: z.string().trim().min(2).max(200),
  type: z.enum(TASK_TYPES).default("todo"),
  note: z.string().trim().max(2000).optional(),
  /** ISO date or datetime; omitted means no deadline. */
  dueAt: z.string().optional(),
  entityType: z.enum(["lead", "company", "document"]).optional(),
  entityId: z.string().optional(),
  assigneeId: z.string().optional(),
});

export async function createTask(raw: unknown): Promise<{ id: string }> {
  const input = createSchema.parse(raw);
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const task = await db.task.create({
    data: {
      workspaceId,
      title: input.title,
      type: input.type,
      note: input.note || null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      // Unassigned by default rather than silently mine: a task nobody owns
      // should look like one.
      assigneeId: input.assigneeId ?? userId,
      createdBy: userId,
    },
    select: { id: true },
  });

  revalidatePath("/");
  revalidatePath("/leads");
  return { id: task.id };
}

export async function completeTask(
  taskId: string,
): Promise<{ ok: true; undo?: UndoToken | null }> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, title: true, doneAt: true },
  });
  const doneAt = new Date();
  const { count } = await db.task.updateMany({
    where: { id: taskId, doneAt: null },
    data: { doneAt },
  });

  // Undoable (P7/2), but only when something actually changed: offering to undo
  // a tick that was already ticked is an offer to do nothing.
  const undoToken =
    count > 0 && task
      ? await recordUndo(workspaceId, userId, {
          kind: "task_done",
          label: `Completed “${task.title}”`,
          inverse: { entity: "task", targets: [{ id: taskId, set: { doneAt: null } }] },
          expected: { [taskId]: { doneAt: doneAt.toISOString() } },
        })
      : null;

  revalidatePath("/");
  revalidatePath("/leads");
  return { ok: true, undo: undoToken };
}

/** Reopen, because a mis-click on a checkbox should not need a database. */
export async function reopenTask(taskId: string): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.task.updateMany({ where: { id: taskId }, data: { doneAt: null } });
  revalidatePath("/");
  revalidatePath("/leads");
  return { ok: true };
}

export async function snoozeTask(taskId: string, days: number): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  // Snoozed from TODAY, not from the old due date: a task three weeks overdue
  // snoozed by "3 days" means three days from now, not eighteen days ago.
  const due = new Date();
  due.setDate(due.getDate() + days);
  due.setHours(17, 0, 0, 0);
  await db.task.updateMany({ where: { id: taskId }, data: { dueAt: due } });
  revalidatePath("/");
  return { ok: true };
}


/**
 * Resolve the polymorphic link to something displayable.
 *
 * Done in one batch per entity type rather than per task: a list of thirty
 * tasks should be four queries, not thirty-one.
 */
async function decorate(
  db: ReturnType<typeof getWorkspaceClient>,
  rows: Array<{
    id: string;
    type: string;
    title: string;
    note: string | null;
    dueAt: Date | null;
    doneAt: Date | null;
    entityType: string | null;
    entityId: string | null;
    assigneeId: string | null;
    source: string | null;
    boardId?: string | null;
    board?: { name: string; isTemplate: boolean } | null;
  }>,
): Promise<TaskView[]> {
  const leadIds = rows.filter((r) => r.entityType === "lead" && r.entityId).map((r) => r.entityId!);
  const companyIds = rows
    .filter((r) => r.entityType === "company" && r.entityId)
    .map((r) => r.entityId!);

  const [leads, companies] = await Promise.all([
    leadIds.length
      ? db.lead.findMany({
          where: { id: { in: leadIds } },
          select: { id: true, contactName: true, company: { select: { name: true } } },
        })
      : Promise.resolve([]),
    companyIds.length
      ? db.company.findMany({
          where: { id: { in: companyIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const leadLabel = new Map(
    leads.map((l) => [l.id, l.contactName || l.company?.name || "lead"]),
  );
  const companyLabel = new Map(companies.map((c) => [c.id, c.name]));

  /**
   * What each of these is waiting on (P8/4).
   *
   * The board knows about dependencies and the dashboard did not, so a task
   * blocked on somebody else's work sat at the top of the morning list looking
   * like the next thing to pick up. One query for the whole page rather than
   * one per row.
   */
  const deps = rows.length
    ? await db.taskDependency.findMany({
        where: { taskId: { in: rows.map((r) => r.id) } },
        select: { taskId: true, blockedById: true },
      })
    : [];
  const blockerIds = [...new Set(deps.map((d) => d.blockedById))];
  const blockers = blockerIds.length
    ? await db.task.findMany({
        where: { id: { in: blockerIds } },
        select: { id: true, doneAt: true },
      })
    : [];
  const open = new Set(blockers.filter((b) => !b.doneAt).map((b) => b.id));
  const blockedCount = new Map<string, number>();
  for (const d of deps) {
    if (!open.has(d.blockedById)) continue;
    blockedCount.set(d.taskId, (blockedCount.get(d.taskId) ?? 0) + 1);
  }

  return rows.map((r) => {
    const boardId = r.boardId ?? null;
    /**
     * One resolver for the chip (playbook-v5 P20/4). This chain used to be
     * written out in three files with three slightly different sets of cases,
     * which is how a company-linked task ended up pointing at a query
     * parameter nobody read.
     */
    const { label: entityLabel, href: entityHref } = chipFor(r, {
      lead: leadLabel,
      company: companyLabel,
    });
    return {
      ...r,
      entityLabel,
      entityHref,
      boardId,
      boardName: r.board?.name ?? null,
      // Deep link to the card on its board, so the dashboard is a way IN to
      // the board rather than a parallel list of the same work.
      boardHref: boardId ? `/tasks?board=${boardId}&task=${r.id}` : null,
      blockedBy: blockedCount.get(r.id) ?? 0,
    };
  });
}

/** Open tasks, grouped for the dashboard. */
export async function myTasks(): Promise<GroupedTasks<TaskView>> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const rows = await db.task.findMany({
    where: {
      doneAt: null,
      // A subtask belongs inside its parent's card. Listing both here would
      // show the same work twice and let an unassigned step of somebody else's
      // task land on everybody's dashboard (P8/1).
      parentId: null,
      /**
       * Not a template's tasks (P8/4).
       *
       * ── A REAL LEAK, MEASURED ──────────────────────────────────────────
       *
       * "Save this board as a template" keeps the board and its tasks and
       * flips `isTemplate`. Those tasks are open and top-level, so this query
       * matched them — and because a template's tasks are deliberately
       * unassigned, the `assigneeId: null` branch put them on EVERYBODY's
       * dashboard. Probed against the live database before fixing: one
       * template task, one dashboard leak.
       *
       * The board hides templates from its own switcher and always did. The
       * dashboard was written first and never learned about them, which is
       * exactly the class of bug that comes from two surfaces reading one
       * table without one of them knowing the other's rules.
       */
      OR: [{ boardId: null }, { board: { isTemplate: false } }],
      AND: [{ OR: [{ assigneeId: userId }, { assigneeId: null }] }],
    },
    orderBy: { dueAt: "asc" },
    // Bounded: this renders a panel, and nobody reads two hundred tasks in one.
    // It also keeps the dashboard — the first page loaded every morning — from
    // paying for a list that scrolls past usefulness.
    take: 50,
    select: {
      id: true,
      type: true,
      title: true,
      note: true,
      dueAt: true,
      doneAt: true,
      entityType: true,
      entityId: true,
      assigneeId: true,
      source: true,
      boardId: true,
      board: { select: { name: true, isTemplate: true } },
    },
  });

  return groupTasks(await decorate(db, rows));
}

