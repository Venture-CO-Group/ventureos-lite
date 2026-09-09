/**
 * The reverse direction: what work is open on this lead, company, deal or
 * project (playbook-v5 P20/4).
 *
 * ── WHY THIS IS ITS OWN READER ──────────────────────────────────────────────
 *
 * A task's entity lives in two places — the `tasks` columns for the one it is
 * mainly about, and `task_links` for anything extra it spans. Every panel that
 * asks "what is open on this lead" must union both or the same task will show
 * up on one surface and not another. So the union happens once, here, and the
 * four panels call this.
 *
 * ── AND WHY "RECENTLY COMPLETED" IS BOUNDED ─────────────────────────────────
 *
 * A lead worked for a year has a hundred finished tasks and nobody wants to
 * scroll them inside a modal. The panel shows what is open, in full, and the
 * last few completions as evidence the work happened — with the count so the
 * number is honest about what is not shown.
 */

import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { ENTITY_KINDS, type EntityKind } from "./links";

/** How many finished tasks the panel shows, newest first. */
export const RECENT_DONE_LIMIT = 5;
/** How far back "recently" reaches. */
export const RECENT_DONE_DAYS = 30;

export interface EntityTaskRow {
  id: string;
  title: string;
  type: string;
  priority: string;
  dueAt: Date | null;
  doneAt: Date | null;
  assigneeId: string | null;
  assigneeName: string | null;
  boardId: string | null;
  boardName: string | null;
  source: string | null;
  /**
   * False when this task's own columns point elsewhere and it is here through
   * `task_links` — the panel says so, because a task that is mainly about the
   * deal turning up under the company should be legible as exactly that.
   */
  primary: boolean;
}

export interface EntityTaskPanel {
  open: EntityTaskRow[];
  recentlyDone: EntityTaskRow[];
  openCount: number;
  /** Everything ever finished on this entity, not just what is shown. */
  doneCount: number;
}

/**
 * The ids of every task on an entity, from both places.
 *
 * Separate from the panel read because the counts, the panel and the export
 * all need the same set and only one of them wants the rows.
 */
export async function taskIdsForEntity(
  workspaceId: string,
  kind: EntityKind,
  entityId: string,
): Promise<{ ids: string[]; primaryIds: Set<string> }> {
  const db = getWorkspaceClient(workspaceId);
  const [own, linked] = await Promise.all([
    db.task.findMany({
      where: { entityType: kind, entityId },
      select: { id: true },
    }),
    db.taskLink.findMany({
      where: { entityType: kind, entityId },
      select: { taskId: true },
    }),
  ]);
  const primaryIds = new Set(own.map((t) => t.id));
  const ids = [...primaryIds];
  for (const link of linked) if (!primaryIds.has(link.taskId)) ids.push(link.taskId);
  return { ids, primaryIds };
}

export async function entityTaskPanel(
  workspaceId: string,
  kind: EntityKind,
  entityId: string,
): Promise<EntityTaskPanel> {
  const db = getWorkspaceClient(workspaceId);
  const { ids: allIds, primaryIds } = await taskIdsForEntity(workspaceId, kind, entityId);

  /**
   * A project's milestones ARE tasks pointed at the project, and the project
   * screen already renders them as its checklist. Listing them again in the
   * panel below would show the same work twice; what the panel is for there is
   * the ad-hoc work that grew around the plan.
   */
  const ids =
    kind === "project" && allIds.length
      ? await (async () => {
          const milestones = await db.milestone.findMany({
            where: { projectId: entityId },
            select: { taskId: true },
          });
          const isMilestone = new Set(milestones.map((m) => m.taskId));
          return allIds.filter((id) => !isMilestone.has(id));
        })()
      : allIds;

  if (ids.length === 0) {
    return { open: [], recentlyDone: [], openCount: 0, doneCount: 0 };
  }

  const since = new Date(Date.now() - RECENT_DONE_DAYS * 24 * 60 * 60 * 1000);
  const select = {
    id: true,
    title: true,
    type: true,
    priority: true,
    dueAt: true,
    doneAt: true,
    assigneeId: true,
    source: true,
    boardId: true,
    board: { select: { name: true } },
  } as const;

  const [openRows, doneRows, doneCount] = await Promise.all([
    db.task.findMany({
      where: { id: { in: ids }, doneAt: null },
      // Undated work sorts last: a task with a date is a commitment and a task
      // without one is an intention.
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
      select,
    }),
    db.task.findMany({
      where: { id: { in: ids }, doneAt: { gte: since } },
      orderBy: { doneAt: "desc" },
      take: RECENT_DONE_LIMIT,
      select,
    }),
    db.task.count({ where: { id: { in: ids }, doneAt: { not: null } } }),
  ]);

  const assigneeIds = [
    ...new Set(
      [...openRows, ...doneRows].map((r) => r.assigneeId).filter((v): v is string => !!v),
    ),
  ];
  /**
   * Users are not a workspace-scoped table, so they come off the unguarded
   * client by name — the same way every other card decorator reads them, and
   * not through raw SQL, which would be both flavour-specific and outside the
   * guard for no reason.
   */
  const names = assigneeIds.length
    ? await prismaUnsafe.user.findMany({
        where: { id: { in: assigneeIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameOf = new Map(names.map((u) => [u.id, u.name]));

  const shape = (r: (typeof openRows)[number]): EntityTaskRow => ({
    id: r.id,
    title: r.title,
    type: r.type,
    priority: r.priority,
    dueAt: r.dueAt,
    doneAt: r.doneAt,
    assigneeId: r.assigneeId,
    assigneeName: r.assigneeId ? (nameOf.get(r.assigneeId) ?? null) : null,
    boardId: r.boardId,
    boardName: r.board?.name ?? null,
    source: r.source,
    primary: primaryIds.has(r.id),
  });

  return {
    open: openRows.map(shape),
    recentlyDone: doneRows.map(shape),
    openCount: openRows.length,
    doneCount,
  };
}

/**
 * Open-task counts for many entities of one kind, for the header badges.
 *
 * One query per place a link can live, rather than a panel read per row —
 * a list of forty companies would otherwise cost eighty round trips.
 */
export async function openTaskCounts(
  workspaceId: string,
  kind: EntityKind,
  entityIds: string[],
): Promise<Map<string, number>> {
  if (entityIds.length === 0) return new Map();
  const db = getWorkspaceClient(workspaceId);
  const [own, linked] = await Promise.all([
    db.task.findMany({
      where: { entityType: kind, entityId: { in: entityIds }, doneAt: null },
      select: { id: true, entityId: true },
    }),
    db.taskLink.findMany({
      where: { entityType: kind, entityId: { in: entityIds } },
      select: { taskId: true, entityId: true },
    }),
  ]);

  /**
   * A task can reach one entity twice — its columns AND a link row — so the
   * count is over DISTINCT task ids per entity, not over rows.
   */
  const seen = new Map<string, Set<string>>();
  const add = (entityId: string | null, taskId: string) => {
    if (!entityId) return;
    const set = seen.get(entityId) ?? new Set<string>();
    set.add(taskId);
    seen.set(entityId, set);
  };
  for (const t of own) add(t.entityId, t.id);

  const linkedOpen = linked.length
    ? new Set(
        (
          await db.task.findMany({
            where: { id: { in: [...new Set(linked.map((l) => l.taskId))] }, doneAt: null },
            select: { id: true },
          })
        ).map((t) => t.id),
      )
    : new Set<string>();
  for (const l of linked) if (linkedOpen.has(l.taskId)) add(l.entityId, l.taskId);

  return new Map([...seen].map(([entityId, set]) => [entityId, set.size]));
}

/** How many entities a task is about, for the "also linked to" line. */
export async function linksForTask(
  workspaceId: string,
  taskId: string,
): Promise<{ kind: EntityKind; id: string }[]> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.taskLink.findMany({
    where: { taskId },
    orderBy: { createdAt: "asc" },
    select: { entityType: true, entityId: true },
  });
  return rows
    .filter((r): r is { entityType: EntityKind; entityId: string } =>
      (ENTITY_KINDS as readonly string[]).includes(r.entityType),
    )
    .map((r) => ({ kind: r.entityType, id: r.entityId }));
}

export async function addTaskLink(
  workspaceId: string,
  taskId: string,
  kind: EntityKind,
  entityId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getWorkspaceClient(workspaceId);
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { entityType: true, entityId: true },
  });
  if (!task) return { ok: false, error: "Task not found." };
  /**
   * The fast path already says this. Adding a link row for the same entity
   * would be a second record of one relationship, and the panel would have to
   * remember to de-duplicate it forever.
   */
  if (task.entityType === kind && task.entityId === entityId) {
    return { ok: false, error: "This task is already about that." };
  }

  const exists = await db.taskLink.findFirst({
    where: { taskId, entityType: kind, entityId },
    select: { id: true },
  });
  if (exists) return { ok: false, error: "This task is already linked to that." };

  await db.taskLink.create({
    data: { workspaceId, taskId, entityType: kind, entityId, createdBy: userId },
  });
  return { ok: true };
}

export async function removeTaskLink(
  workspaceId: string,
  taskId: string,
  kind: EntityKind,
  entityId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getWorkspaceClient(workspaceId);
  const { count } = await db.taskLink.deleteMany({
    where: { taskId, entityType: kind, entityId },
  });
  /**
   * The primary link cannot be removed here, and the message says why rather
   * than failing silently: it is a column on the task, changed by editing the
   * task, not by unlinking.
   */
  if (count === 0) {
    return {
      ok: false,
      error: "That is the task's own entity — change it on the task itself.",
    };
  }
  return { ok: true };
}
