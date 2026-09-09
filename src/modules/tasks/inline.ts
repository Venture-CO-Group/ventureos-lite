/**
 * Editing one field of one task (playbook-v5 P16/1).
 *
 * Workspace-id in rather than session-derived, like every other `*-store` and
 * `inline.ts` here: the rules worth proving — that an assignee has to be a
 * member, that a start date after its due date is refused, that a blocked task
 * is still editable — are worth proving against a real database.
 *
 * WHAT IS EDITABLE IN PLACE, and what deliberately is not:
 *   - title, note, priority, the two dates, the assignee and the tags: yes.
 *   - `doneAt`: no. Completing a task spawns a recurrence successor, writes an
 *     undo entry and notifies followers; `completeTask` owns all of that, and a
 *     cell that wrote the column directly would skip every part of it.
 *   - `boardId` / `sectionId` / `position`: no. Those are what dragging means,
 *     and they move together — a cell that set one of the three would leave a
 *     card with a section belonging to another board.
 *   - `parentId`: no. Re-parenting changes what the progress count means and is
 *     a deliberate action, not a typo away.
 *
 * A DEPENDENCY DOES NOT BLOCK AN EDIT. The model's own comment is explicit that
 * a dependency is reported, never enforced — refusing to edit a blocked task
 * would mean the product deciding its graph is more accurate than the person
 * looking at the work.
 */

import { z } from "zod";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { TASK_PRIORITIES } from "./board-logic";
import {
  onTaskAssigneeChanged,
  onTaskPriorityChanged,
} from "@/modules/workflow/triggers";

export const TASK_INLINE_FIELDS = [
  "title",
  "note",
  "priority",
  "dueAt",
  "startAt",
  "assigneeId",
  "tags",
] as const;
export type TaskInlineField = (typeof TASK_INLINE_FIELDS)[number];

export function isTaskInlineField(field: string): field is TaskInlineField {
  return (TASK_INLINE_FIELDS as readonly string[]).includes(field);
}

/** Why a field a person can see is nevertheless not editable in place. */
export const TASK_UNEDITABLE_REASON: Record<string, string> = {
  doneAt: "Tick the task instead — completing it also handles recurrence and notifies its followers.",
  boardId: "Drag the card to move it between boards.",
  sectionId: "Drag the card to move it between columns.",
  position: "Drag the card to reorder it.",
  parentId: "Open the task to change what it belongs to.",
};

export type TaskInlineResult = { ok: true; value: unknown } | { ok: false; error: string };

const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]);

/** A date cell sends "2026-09-14" or "" — never a timestamp. */
function parseDay(value: unknown): Date | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const d = new Date(`${value.trim()}T12:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function day(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export async function applyTaskInlineEdit(
  workspaceId: string,
  actorUserId: string | null,
  input: { taskId: string; field: string; value: unknown },
): Promise<TaskInlineResult> {
  const parsedValue = valueSchema.safeParse(input.value ?? null);
  if (!parsedValue.success) return { ok: false, error: "That value is not allowed." };
  const value = parsedValue.data;

  if (!isTaskInlineField(input.field)) {
    const reason = TASK_UNEDITABLE_REASON[input.field];
    return { ok: false, error: reason ?? "That field cannot be edited in place." };
  }

  const db = getWorkspaceClient(workspaceId);
  const task = await db.task.findUnique({
    where: { id: input.taskId },
    select: { id: true, dueAt: true, startAt: true, priority: true, assigneeId: true },
  });
  if (!task) return { ok: false, error: "Task not found." };

  // ---- text ---------------------------------------------------------------
  if (input.field === "title") {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return { ok: false, error: "A task needs a title." };
    if (text.length > 200) return { ok: false, error: "That title is too long." };
    await db.task.update({ where: { id: task.id }, data: { title: text } });
    return { ok: true, value: text };
  }

  if (input.field === "note") {
    const text = typeof value === "string" ? value.trim() : "";
    if (text.length > 5000) return { ok: false, error: "That note is too long." };
    await db.task.update({ where: { id: task.id }, data: { note: text || null } });
    return { ok: true, value: text || null };
  }

  // ---- priority -----------------------------------------------------------
  if (input.field === "priority") {
    const next = String(value ?? "none");
    if (!(TASK_PRIORITIES as readonly string[]).includes(next)) {
      return { ok: false, error: "That is not a priority." };
    }
    await db.task.update({ where: { id: task.id }, data: { priority: next } });
    // Board automations (playbook-v5 P20/5): an inline change is a change.
    if (next !== task.priority) await onTaskPriorityChanged(workspaceId, task.id);
    return { ok: true, value: next };
  }

  // ---- dates --------------------------------------------------------------
  if (input.field === "dueAt" || input.field === "startAt") {
    const parsed = parseDay(value);
    if (parsed === undefined) return { ok: false, error: "That is not a date." };

    /**
     * A start after its due date is a data error rather than a preference, and
     * it is the one that makes a timeline draw a bar backwards. Checked against
     * whichever of the pair is NOT being edited.
     */
    const start = input.field === "startAt" ? parsed : task.startAt;
    const due = input.field === "dueAt" ? parsed : task.dueAt;
    if (start && due && start.getTime() > due.getTime()) {
      return {
        ok: false,
        error:
          input.field === "startAt"
            ? "A task cannot start after it is due."
            : "A task cannot be due before it starts.",
      };
    }

    await db.task.update({ where: { id: task.id }, data: { [input.field]: parsed } });
    return { ok: true, value: day(parsed) };
  }

  // ---- assignee -----------------------------------------------------------
  if (input.field === "assigneeId") {
    const assigneeId = typeof value === "string" && value ? value : null;
    if (assigneeId) {
      // Only a member of THIS workspace may hold its work — otherwise an id
      // typed into a form assigns a task to a stranger.
      const member = await prismaUnsafe.membership.findUnique({
        where: { userId_workspaceId: { userId: assigneeId, workspaceId } },
        select: { state: true },
      });
      if (!member) return { ok: false, error: "That person is not in this workspace." };
      if (member.state !== "ACTIVE") {
        return { ok: false, error: "That person's access is suspended — assign it to somebody else." };
      }
    }
    await db.task.update({ where: { id: task.id }, data: { assigneeId } });
    if (assigneeId !== task.assigneeId) await onTaskAssigneeChanged(workspaceId, task.id);
    return { ok: true, value: assigneeId };
  }

  // ---- tags ---------------------------------------------------------------
  const raw = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
  const tags = [...new Set(raw.map((t) => String(t).trim()).filter(Boolean))];
  if (tags.length > 12) return { ok: false, error: "Twelve tags is the limit." };
  if (tags.some((t) => t.length > 40)) return { ok: false, error: "That tag is too long." };
  await db.task.update({ where: { id: task.id }, data: { tags } });
  void actorUserId;
  return { ok: true, value: tags };
}
