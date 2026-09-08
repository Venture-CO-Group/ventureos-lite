import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { deliverNotification } from "@/modules/notifications/store";
import {
  needsRebalance,
  nextPosition,
  positionBetween,
  rebalance,
  boardProgress,
  subtaskProgress,
  type BoardProgress,
} from "./board-logic";

/**
 * Board reads and writes.
 *
 * Takes `workspaceId` explicitly and goes through the guarded client, so every
 * query here is tenant-scoped by the same mechanism as the rest of the product
 * and nothing in this file can reach another workspace's board.
 */
type Db = ReturnType<typeof getWorkspaceClient>;

export interface TaskCardView {
  id: string;
  title: string;
  note: string | null;
  type: string;
  priority: string;
  tags: string[];
  dueAt: Date | null;
  startAt: Date | null;
  doneAt: Date | null;
  assigneeId: string | null;
  assigneeName: string | null;
  sectionId: string | null;
  position: number;
  source: string | null;
  /** Where this task hangs off a lead or a company, when it does. */
  entityType: string | null;
  entityId: string | null;
  entityLabel: string | null;
  entityHref: string | null;
  subtasks: { done: number; total: number } | null;
  commentCount: number;
}

export interface SectionView {
  id: string;
  name: string;
  position: number;
  tasks: TaskCardView[];
}

export interface BoardView {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  archivedAt: Date | null;
  sections: SectionView[];
  /** Tasks on the board that belong to no section yet. */
  unsectioned: TaskCardView[];
  progress: BoardProgress;
}

export interface BoardSummary {
  id: string;
  name: string;
  color: string | null;
  archivedAt: Date | null;
  position: number;
  progress: BoardProgress;
}

const CARD_SELECT = {
  id: true,
  title: true,
  note: true,
  type: true,
  priority: true,
  tags: true,
  dueAt: true,
  startAt: true,
  doneAt: true,
  assigneeId: true,
  sectionId: true,
  position: true,
  source: true,
  entityType: true,
  entityId: true,
} as const;

type CardRow = {
  id: string;
  title: string;
  note: string | null;
  type: string;
  priority: string;
  tags: unknown;
  dueAt: Date | null;
  startAt: Date | null;
  doneAt: Date | null;
  assigneeId: string | null;
  sectionId: string | null;
  position: number;
  source: string | null;
  entityType: string | null;
  entityId: string | null;
};

/**
 * Attach the names, links, subtask counts and comment counts a card shows.
 *
 * Batched per kind rather than per card: a board of eighty tasks should be a
 * handful of queries, not two hundred and forty.
 */
async function decorateCards(db: Db, rows: CardRow[]): Promise<TaskCardView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const assigneeIds = [...new Set(rows.map((r) => r.assigneeId).filter((v): v is string => !!v))];
  const leadIds = rows.filter((r) => r.entityType === "lead" && r.entityId).map((r) => r.entityId!);
  const companyIds = rows
    .filter((r) => r.entityType === "company" && r.entityId)
    .map((r) => r.entityId!);

  const [users, leads, companies, subtasks, comments] = await Promise.all([
    assigneeIds.length
      ? prismaUnsafe.user.findMany({
          where: { id: { in: assigneeIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    leadIds.length
      ? db.lead.findMany({
          where: { id: { in: leadIds } },
          select: { id: true, contactName: true, company: { select: { name: true } } },
        })
      : Promise.resolve([]),
    companyIds.length
      ? db.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    db.task.findMany({
      where: { parentId: { in: ids } },
      select: { parentId: true, doneAt: true },
    }),
    db.taskComment.groupBy({ by: ["taskId"], where: { taskId: { in: ids } }, _count: true }),
  ]);

  const userName = new Map(users.map((u) => [u.id, u.name]));
  const leadLabel = new Map(
    leads.map((l) => [l.id, l.contactName || l.company?.name || "lead"]),
  );
  const companyLabel = new Map(companies.map((c) => [c.id, c.name]));

  const childrenOf = new Map<string, Array<{ doneAt: Date | null }>>();
  for (const s of subtasks) {
    if (!s.parentId) continue;
    const list = childrenOf.get(s.parentId) ?? [];
    list.push({ doneAt: s.doneAt });
    childrenOf.set(s.parentId, list);
  }
  const commentCount = new Map(comments.map((c) => [c.taskId, c._count as unknown as number]));

  return rows.map((r) => {
    let entityLabel: string | null = null;
    let entityHref: string | null = null;
    if (r.entityType === "lead" && r.entityId) {
      entityLabel = leadLabel.get(r.entityId) ?? null;
      entityHref = `/leads?lead=${r.entityId}`;
    } else if (r.entityType === "company" && r.entityId) {
      entityLabel = companyLabel.get(r.entityId) ?? null;
      entityHref = `/leads?company=${r.entityId}`;
    } else if (r.entityType === "document" && r.entityId) {
      entityLabel = "document";
      entityHref = `/documents?doc=${r.entityId}`;
    }
    return {
      id: r.id,
      title: r.title,
      note: r.note,
      type: r.type,
      priority: r.priority,
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
      dueAt: r.dueAt,
      startAt: r.startAt,
      doneAt: r.doneAt,
      assigneeId: r.assigneeId,
      assigneeName: r.assigneeId ? (userName.get(r.assigneeId) ?? null) : null,
      sectionId: r.sectionId,
      position: r.position,
      source: r.source,
      entityType: r.entityType,
      entityId: r.entityId,
      entityLabel,
      entityHref,
      subtasks: subtaskProgress(childrenOf.get(r.id) ?? []),
      commentCount: commentCount.get(r.id) ?? 0,
    };
  });
}

/** Every board, with how far along each is. */
export async function listBoards(
  workspaceId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<BoardSummary[]> {
  const db = getWorkspaceClient(workspaceId);
  const boards = await db.taskBoard.findMany({
    where: opts.includeArchived ? {} : { archivedAt: null },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, color: true, archivedAt: true, position: true },
  });
  if (boards.length === 0) return [];

  const counts = await db.task.findMany({
    where: { boardId: { in: boards.map((b) => b.id) }, parentId: null },
    select: { boardId: true, doneAt: true, dueAt: true },
  });
  const byBoard = new Map<string, Array<{ doneAt: Date | null; dueAt: Date | null }>>();
  for (const t of counts) {
    if (!t.boardId) continue;
    const list = byBoard.get(t.boardId) ?? [];
    list.push({ doneAt: t.doneAt, dueAt: t.dueAt });
    byBoard.set(t.boardId, list);
  }

  return boards.map((b) => ({ ...b, progress: boardProgress(byBoard.get(b.id) ?? []) }));
}

/**
 * One board, arranged into its sections.
 *
 * Subtasks are excluded from the columns (`parentId: null`): a subtask belongs
 * inside its parent's card, and letting both appear on the board would show the
 * same work twice and count it twice in the progress bar.
 */
export async function loadBoard(
  workspaceId: string,
  boardId: string,
  filters: { assigneeId?: string | null; includeDone?: boolean } = {},
): Promise<BoardView | null> {
  const db = getWorkspaceClient(workspaceId);
  const board = await db.taskBoard.findUnique({
    where: { id: boardId },
    select: { id: true, name: true, description: true, color: true, archivedAt: true },
  });
  if (!board) return null;

  const sections = await db.taskSection.findMany({
    where: { boardId },
    orderBy: { position: "asc" },
    select: { id: true, name: true, position: true },
  });

  const rows = await db.task.findMany({
    where: {
      boardId,
      parentId: null,
      ...(filters.assigneeId !== undefined && filters.assigneeId !== null
        ? { assigneeId: filters.assigneeId }
        : {}),
      ...(filters.includeDone ? {} : { doneAt: null }),
    },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: CARD_SELECT,
  });
  const cards = await decorateCards(db, rows as CardRow[]);

  // Progress counts every task on the board, done ones included — otherwise a
  // filtered view would report a different percentage from the same board.
  const all = await db.task.findMany({
    where: { boardId, parentId: null },
    select: { doneAt: true, dueAt: true },
  });

  return {
    ...board,
    sections: sections.map((s) => ({
      ...s,
      tasks: cards.filter((c) => c.sectionId === s.id),
    })),
    unsectioned: cards.filter((c) => c.sectionId === null),
    progress: boardProgress(all),
  };
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

/** The columns a new board opens with. Asana's defaults, and they are right. */
export const DEFAULT_SECTIONS = ["To do", "In progress", "Done"];

export async function createBoard(
  workspaceId: string,
  userId: string,
  input: { name: string; description?: string | null; color?: string | null },
): Promise<string> {
  const db = getWorkspaceClient(workspaceId);
  const existing = await db.taskBoard.findMany({ select: { position: true } });
  const board = await db.taskBoard.create({
    data: {
      workspaceId,
      name: input.name,
      description: input.description ?? null,
      color: input.color ?? null,
      position: nextPosition(existing.map((b) => b.position)),
      createdBy: userId,
      // A board with no columns cannot receive a card, so an empty one would
      // be a dead end on arrival.
      sections: {
        create: DEFAULT_SECTIONS.map((name, i) => ({
          workspaceId,
          name,
          position: (i + 1) * 1024,
        })),
      },
    },
    select: { id: true },
  });
  return board.id;
}

/**
 * Move a card, and say where among its new neighbours it lands.
 *
 * `afterId` is the card it was dropped BELOW (null = dropped at the top of the
 * column). Ranks are sparse, so this is normally one write; when the gap has
 * been used up the column is respaced first and the move retried, which is why
 * `positionBetween` returns null instead of quietly colliding.
 */
export async function moveTask(
  workspaceId: string,
  taskId: string,
  target: { sectionId: string | null; afterId: string | null },
): Promise<void> {
  const db = getWorkspaceClient(workspaceId);
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, boardId: true },
  });
  if (!task) return;

  const siblings = await db.task.findMany({
    where: {
      boardId: task.boardId,
      sectionId: target.sectionId,
      parentId: null,
      id: { not: taskId },
    },
    orderBy: { position: "asc" },
    select: { id: true, position: true },
  });

  const anchorIndex = target.afterId
    ? siblings.findIndex((s) => s.id === target.afterId)
    : -1;
  const before = anchorIndex >= 0 ? siblings[anchorIndex]!.position : null;
  const after = siblings[anchorIndex + 1]?.position ?? null;

  let position = positionBetween(before, after);
  if (position === null) {
    // The gap ran out. Respace the column, then place the card at the same
    // index — one extra pass, and only ever after ~10 drops into one gap.
    const spaced = rebalance(siblings.length);
    await Promise.all(
      siblings.map((s, i) =>
        db.task.update({ where: { id: s.id }, data: { position: spaced[i]! } }),
      ),
    );
    const b = anchorIndex >= 0 ? spaced[anchorIndex]! : null;
    const a = spaced[anchorIndex + 1] ?? null;
    position = positionBetween(b, a) ?? nextPosition(spaced);
  }

  await db.task.update({
    where: { id: taskId },
    data: { sectionId: target.sectionId, position },
  });
}

/** Respace a column whose ranks have collapsed. Safe to run at any time. */
export async function rebalanceSection(
  workspaceId: string,
  boardId: string,
  sectionId: string | null,
): Promise<number> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.task.findMany({
    where: { boardId, sectionId, parentId: null },
    orderBy: { position: "asc" },
    select: { id: true, position: true },
  });
  if (!needsRebalance(rows.map((r) => r.position))) return 0;
  const spaced = rebalance(rows.length);
  await Promise.all(
    rows.map((r, i) => db.task.update({ where: { id: r.id }, data: { position: spaced[i]! } })),
  );
  return rows.length;
}

/**
 * Make sure the people who care about a task hear about it.
 *
 * Followers are additive and never removed automatically: somebody who asked a
 * question on a task should keep hearing the answers even after the assignee
 * changes.
 */
export async function addFollowers(
  workspaceId: string,
  taskId: string,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const db = getWorkspaceClient(workspaceId);
  for (const userId of new Set(userIds)) {
    await db.taskFollower
      .upsert({
        where: { taskId_userId: { taskId, userId } },
        update: {},
        create: { workspaceId, taskId, userId },
      })
      .catch(() => {
        // A follower row is an extra; never fail the write it rode in on.
      });
  }
}

/** Everyone to notify about a change, minus whoever made it. */
export async function notifyTaskAudience(
  workspaceId: string,
  taskId: string,
  actorId: string,
  input: { type: "task_assigned" | "task_commented"; title: string; body?: string | null },
): Promise<void> {
  const db = getWorkspaceClient(workspaceId);
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { assigneeId: true, boardId: true },
  });
  if (!task) return;

  const followers = await db.taskFollower.findMany({
    where: { taskId },
    select: { userId: true },
  });
  const audience = new Set<string>(followers.map((f) => f.userId));
  if (task.assigneeId) audience.add(task.assigneeId);
  // Never notify somebody about their own action — that is how a bell badge
  // stops meaning anything.
  audience.delete(actorId);
  if (audience.size === 0) return;

  await deliverNotification({
    workspaceId,
    userIds: [...audience],
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    href: task.boardId ? `/tasks?board=${task.boardId}&task=${taskId}` : `/tasks?task=${taskId}`,
    entityType: "task",
    entityId: taskId,
    // Two comments on one task are two events, not a repeat of one.
    discriminator: `${input.type}:${Date.now()}`,
  });
}
