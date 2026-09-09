/**
 * Undo, as server-side inverse operations (playbook-v2 P7/2).
 *
 * The playbook is explicit that this must not be a client-side illusion, and
 * the reason is concurrency. If the browser remembers "put it back to
 * Contacted" and a colleague has since moved the lead to Replied, replaying
 * that memory silently overwrites their work — the undo would be a second,
 * invisible edit rather than a reversal.
 *
 * So an undoable action records three things:
 *   - the INVERSE: what to write, to which rows;
 *   - the EXPECTED state it left behind;
 *   - a label, for the toast.
 *
 * Undoing re-reads the rows, compares them against `expected`, and DECLINES if
 * anything differs. That is the whole design: an undo that cannot verify what
 * it is undoing is not an undo.
 *
 * Both the action and the undo are audit-logged (CLAUDE.md hard rule #8).
 */

import { getWorkspaceClient } from "@/lib/db";

/** The toast offers six seconds; the row survives long enough to be clicked. */
export const UNDO_WINDOW_MS = 10 * 60_000;

export type UndoKind =
  | "lead_stage"
  | "deal_stage"
  | "task_done"
  | "bulk_stage"
  | "bulk_signals"
  | "bulk_owner"
  | "lead_not_now"
  | "content_status"
  | "board_archive";

/** One row the inverse touches: put `field` back to `value`. */
export interface InverseTarget {
  id: string;
  /** Field -> value to restore. */
  set: Record<string, unknown>;
}

export interface InversePlan {
  entity: InverseEntity;
  targets: InverseTarget[];
}

/**
 * What the engine can put back.
 *
 * Adding one means teaching `readRows` and the write loop about it — which is
 * the point of keeping the list closed. An entity that is not here cannot be
 * declared undoable in `contract.ts` without the declaration being a lie.
 */
export type InverseEntity = "lead" | "deal" | "task" | "contentPost" | "taskBoard";

/** Field -> value the action LEFT, per row. The undo checks these still hold. */
export interface ExpectedState {
  [id: string]: Record<string, unknown>;
}

export interface UndoToken {
  id: string;
  label: string;
  kind: UndoKind;
}

/**
 * Record an undoable action.
 *
 * Best-effort by construction: a failure here must never fail the action it
 * describes. Losing the ability to undo is a disappointment; failing the move
 * the user asked for is a bug.
 */
export async function recordUndo(
  workspaceId: string,
  userId: string,
  input: {
    kind: UndoKind;
    label: string;
    inverse: InversePlan;
    expected: ExpectedState;
    nowMs?: number;
  },
): Promise<UndoToken | null> {
  if (input.inverse.targets.length === 0) return null;
  const now = input.nowMs ?? Date.now();
  try {
    const db = getWorkspaceClient(workspaceId);
    const row = await db.undoEntry.create({
      data: {
        workspaceId,
        userId,
        kind: input.kind,
        label: input.label,
        inverse: input.inverse as unknown as object,
        expected: input.expected as unknown as object,
        expiresAt: new Date(now + UNDO_WINDOW_MS),
      },
      select: { id: true },
    });
    return { id: row.id, label: input.label, kind: input.kind };
  } catch {
    return null;
  }
}

export interface UndoConflict {
  id: string;
  field: string;
  expected: unknown;
  actual: unknown;
}

export type UndoResult =
  | { ok: true; restored: number }
  | { ok: false; error: string; conflicts?: UndoConflict[] };

type Db = ReturnType<typeof getWorkspaceClient>;

async function readRows(
  db: Db,
  entity: InverseEntity,
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const rows =
    entity === "lead"
      ? await db.lead.findMany({ where: { id: { in: ids } } })
      : entity === "deal"
        ? await db.deal.findMany({ where: { id: { in: ids } } })
        : entity === "task"
          ? await db.task.findMany({ where: { id: { in: ids } } })
          : entity === "taskBoard"
            ? await db.taskBoard.findMany({ where: { id: { in: ids } } })
            : await db.contentPost.findMany({ where: { id: { in: ids } } });
  return new Map(rows.map((r) => [r.id, r as unknown as Record<string, unknown>]));
}

/** Dates and enums both arrive as strings out of JSON; compare on that basis. */
function sameValue(expected: unknown, actual: unknown): boolean {
  if (expected === null || expected === undefined) {
    return actual === null || actual === undefined;
  }
  if (actual instanceof Date) return new Date(String(expected)).getTime() === actual.getTime();
  return String(expected) === String(actual);
}

/**
 * Undo one recorded action, if nothing has changed underneath it.
 *
 * Scoped to the caller's OWN entries: an undo token is a capability, and one
 * person must not be able to reverse another's action by guessing an id.
 */
export async function undo(
  workspaceId: string,
  userId: string,
  undoId: string,
  nowMs: number = Date.now(),
): Promise<UndoResult> {
  const db = getWorkspaceClient(workspaceId);
  const entry = await db.undoEntry.findUnique({ where: { id: undoId } });
  if (!entry || entry.userId !== userId) return { ok: false, error: "Nothing to undo." };
  if (entry.undoneAt) return { ok: false, error: "That was already undone." };
  if (entry.expiresAt.getTime() < nowMs) return { ok: false, error: "Too late to undo that." };

  const plan = entry.inverse as unknown as InversePlan;
  const expected = entry.expected as unknown as ExpectedState;
  const ids = plan.targets.map((t) => t.id);
  const live = await readRows(db, plan.entity, ids);

  const conflicts: UndoConflict[] = [];
  for (const target of plan.targets) {
    const row = live.get(target.id);
    // A row that has since been deleted is not a conflict — there is nothing
    // left to put back, and refusing the whole undo over it would strand the
    // rest. It is simply skipped.
    if (!row) continue;
    for (const [field, value] of Object.entries(expected[target.id] ?? {})) {
      if (!sameValue(value, row[field])) {
        conflicts.push({ id: target.id, field, expected: value, actual: row[field] ?? null });
      }
    }
  }

  if (conflicts.length > 0) {
    return {
      ok: false,
      error:
        conflicts.length === 1
          ? "That has changed since — undo would overwrite the newer edit."
          : `${conflicts.length} of those have changed since — undo would overwrite newer edits.`,
      conflicts,
    };
  }

  let restored = 0;
  for (const target of plan.targets) {
    if (!live.has(target.id)) continue;
    const data = restorable(target.set);
    if (Object.keys(data).length === 0) continue;
    if (plan.entity === "lead") {
      restored += (await db.lead.updateMany({ where: { id: target.id }, data })).count;
    } else if (plan.entity === "deal") {
      restored += (await db.deal.updateMany({ where: { id: target.id }, data })).count;
    } else if (plan.entity === "task") {
      restored += (await db.task.updateMany({ where: { id: target.id }, data })).count;
    } else if (plan.entity === "taskBoard") {
      restored += (await db.taskBoard.updateMany({ where: { id: target.id }, data })).count;
    } else {
      restored += (await db.contentPost.updateMany({ where: { id: target.id }, data })).count;
    }
  }

  await db.undoEntry.update({ where: { id: undoId }, data: { undoneAt: new Date(nowMs) } });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "undo.applied",
      entityType: "UndoEntry",
      entityId: undoId,
      meta: { kind: entry.kind, label: entry.label, restored },
    },
  });

  return { ok: true, restored };
}

/**
 * Turn stored JSON back into values Prisma will accept.
 *
 * A date comes out of JSON as a string, and `{ stageEnteredAt: "2026-..." }`
 * is a type error rather than a date. Anything that looks like an ISO timestamp
 * becomes a Date; everything else passes through.
 */
function restorable(set: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(set)) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) {
      out[field] = new Date(value);
    } else {
      out[field] = value;
    }
  }
  return out;
}

/** Housekeeping: an expired or spent entry can never be used again. */
export async function pruneUndoEntries(
  workspaceId: string,
  nowMs: number = Date.now(),
): Promise<number> {
  const db = getWorkspaceClient(workspaceId);
  const { count } = await db.undoEntry.deleteMany({
    where: { expiresAt: { lt: new Date(nowMs) } },
  });
  return count;
}
