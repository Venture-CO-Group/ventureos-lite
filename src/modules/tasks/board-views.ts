/**
 * Saved views for task boards, on the leads' SavedView table (playbook-v5 P18/2).
 *
 * ── EXTENDED, NOT FORKED ────────────────────────────────────────────────────
 *
 * The playbook is explicit about reusing the SavedView infrastructure. It
 * nearly fits as-is: name, entity, owner, `shared`, filters, sort, columns and
 * tab position all mean the same thing for a board. What it had nowhere to put
 * was the board and the grouping, so `config` was added — one nullable JSON
 * column — rather than a second table with the same six columns and its own
 * copy of the sharing rules.
 *
 * The sharing rules in particular are worth not duplicating: only the creator
 * edits their own view, and a seated member may curate the SHARED ones. That
 * distinction was hard-won (see modules/leads/views.ts) and having it in two
 * places is how the second copy ends up subtly wrong.
 */

import { z } from "zod";
import { getWorkspaceClient } from "@/lib/db";
import { canEditView, canSeeView, normalizeViewName } from "@/modules/leads/views";
import {
  COMPLETION_FILTERS,
  EMPTY_TASK_FILTER,
  GROUP_BYS,
  type GroupBy,
  type TaskFilter,
} from "./grouping";
import { WORK_BUCKETS } from "./logic";

const ENTITY = "task";

/** Total, like every other stored-JSON parser here: a hand-edited row cannot
 *  put a board into a state it has no branch for. */
const filterSchema = z.object({
  assigneeId: z.string().min(1).max(60).nullable().catch(null),
  priority: z.string().min(1).max(20).nullable().catch(null),
  tag: z.string().min(1).max(40).nullable().catch(null),
  /** One Owner-defined field (playbook-v5 P20/2). */
  custom: z
    .object({ key: z.string().min(1).max(40), value: z.string().min(1).max(200) })
    .nullable()
    .catch(null),
  due: z.enum(WORK_BUCKETS).nullable().catch(null),
  completion: z.enum(COMPLETION_FILTERS).catch("open"),
  blocked: z.boolean().nullable().catch(null),
});

const configSchema = z.object({
  boardId: z.string().min(1).max(60).nullable().catch(null),
  groupBy: z.enum(GROUP_BYS).catch("section"),
});

export interface TaskBoardView {
  id: string;
  name: string;
  ownerId: string;
  shared: boolean;
  boardId: string | null;
  groupBy: GroupBy;
  filter: TaskFilter;
  position: number;
}

export interface TaskViewInput {
  name: string;
  shared: boolean;
  boardId: string | null;
  groupBy: GroupBy;
  filter: TaskFilter;
}

export function parseTaskFilter(raw: unknown): TaskFilter {
  const parsed = filterSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { ...EMPTY_TASK_FILTER };
}

export function parseTaskConfig(raw: unknown): { boardId: string | null; groupBy: GroupBy } {
  const parsed = configSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { boardId: null, groupBy: "section" };
}

type Row = {
  id: string;
  name: string;
  ownerId: string;
  shared: boolean;
  filters: unknown;
  config: unknown;
  position: number;
};

function toView(row: Row): TaskBoardView {
  const config = parseTaskConfig(row.config);
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    shared: row.shared,
    boardId: config.boardId,
    groupBy: config.groupBy,
    filter: parseTaskFilter(row.filters),
    position: row.position,
  };
}

export async function listTaskViews(
  workspaceId: string,
  userId: string,
): Promise<TaskBoardView[]> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.savedView.findMany({
    where: { entity: ENTITY },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      ownerId: true,
      shared: true,
      filters: true,
      config: true,
      position: true,
    },
  });
  // Personal views belong to their owner; shared ones to everybody.
  return rows.map(toView).filter((v) => canSeeView(v, userId));
}

export type TaskViewResult =
  | { ok: true; view: TaskBoardView }
  | { ok: false; error: string };

export async function createTaskView(
  workspaceId: string,
  userId: string,
  input: TaskViewInput,
): Promise<TaskViewResult> {
  const name = normalizeViewName(input.name);
  if (!name) return { ok: false, error: "A view needs a name." };

  const db = getWorkspaceClient(workspaceId);
  const clash = await db.savedView.findFirst({
    where: { entity: ENTITY, ownerId: userId, name },
    select: { id: true },
  });
  if (clash) return { ok: false, error: "You already have a view with that name." };

  const last = await db.savedView.findFirst({
    where: { entity: ENTITY },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const row = await db.savedView.create({
    data: {
      workspaceId,
      entity: ENTITY,
      ownerId: userId,
      name,
      shared: input.shared,
      filters: filterSchema.parse(input.filter) as object,
      config: configSchema.parse({ boardId: input.boardId, groupBy: input.groupBy }) as object,
      position: (last?.position ?? 0) + 1,
    },
    select: {
      id: true,
      name: true,
      ownerId: true,
      shared: true,
      filters: true,
      config: true,
      position: true,
    },
  });
  return { ok: true, view: toView(row) };
}

export async function updateTaskView(
  workspaceId: string,
  userId: string,
  role: string,
  id: string,
  changes: Partial<TaskViewInput>,
): Promise<TaskViewResult> {
  const db = getWorkspaceClient(workspaceId);
  const found = await db.savedView.findFirst({
    where: { id, entity: ENTITY },
    select: {
      id: true,
      name: true,
      ownerId: true,
      shared: true,
      filters: true,
      config: true,
      position: true,
    },
  });
  if (!found) return { ok: false, error: "That view no longer exists." };

  const view = toView(found);
  // The same rule as a lead view, from the same function: only the creator
  // edits their own, and a seated member may curate the shared ones.
  if (!canEditView(view, userId, role)) {
    return { ok: false, error: "That view belongs to somebody else." };
  }

  const data: Record<string, unknown> = {};
  if (changes.name !== undefined) {
    const name = normalizeViewName(changes.name);
    if (!name) return { ok: false, error: "A view needs a name." };
    data.name = name;
  }
  if (changes.shared !== undefined) data.shared = changes.shared;
  if (changes.filter !== undefined) data.filters = filterSchema.parse(changes.filter);
  if (changes.boardId !== undefined || changes.groupBy !== undefined) {
    data.config = configSchema.parse({
      boardId: changes.boardId !== undefined ? changes.boardId : view.boardId,
      groupBy: changes.groupBy !== undefined ? changes.groupBy : view.groupBy,
    });
  }

  const row = await db.savedView.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      ownerId: true,
      shared: true,
      filters: true,
      config: true,
      position: true,
    },
  });
  return { ok: true, view: toView(row) };
}

export async function deleteTaskView(
  workspaceId: string,
  userId: string,
  role: string,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getWorkspaceClient(workspaceId);
  const found = await db.savedView.findFirst({
    where: { id, entity: ENTITY },
    select: {
      id: true,
      name: true,
      ownerId: true,
      shared: true,
      filters: true,
      config: true,
      position: true,
    },
  });
  if (!found) return { ok: false, error: "That view no longer exists." };
  if (!canEditView(toView(found), userId, role)) {
    return { ok: false, error: "That view belongs to somebody else." };
  }
  await db.savedView.delete({ where: { id } });
  return { ok: true };
}
