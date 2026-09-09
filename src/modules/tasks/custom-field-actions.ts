"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import { getWorkspaceClient } from "@/lib/db";
import { listFieldDefs, setFieldValues } from "@/modules/fields/store";
import { readValues, type FieldDef, type FieldValues } from "@/modules/fields/types";

/**
 * Owner-defined fields on a task (playbook-v5 P20/2).
 *
 * ── NOTHING NEW HERE, DELIBERATELY ──────────────────────────────────────────
 *
 * The definitions come from `listFieldDefs("task")` and the writes go through
 * `setFieldValues`, which is the same validator leads, companies and deals
 * use. That is the point of the item: tasks inherit the archived-field
 * behaviour, the operator table, the value coercion and the GDPR handling
 * rather than getting a second implementation of each.
 */

export interface TaskFieldsView {
  defs: FieldDef[];
  values: FieldValues;
}

export async function getTaskFields(taskId: string): Promise<TaskFieldsView> {
  const parsed = z.string().min(1).max(60).safeParse(taskId);
  if (!parsed.success) return { defs: [], values: {} };

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const [defs, task] = await Promise.all([
    // Active only: an archived definition keeps its stored values but stops
    // being offered, which is the existing behaviour and the reason archiving
    // exists rather than deleting.
    listFieldDefs(workspaceId, "task", { activeOnly: true }),
    db.task.findUnique({ where: { id: parsed.data }, select: { customFields: true } }),
  ]);
  return { defs, values: readValues(task?.customFields) };
}

export async function setTaskField(
  raw: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const parsed = z
    .object({
      taskId: z.string().min(1).max(60),
      key: z.string().min(1).max(40),
      value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That value is not allowed." };

  const { workspaceId } = await getActiveContext();
  const res = await setFieldValues(workspaceId, "task", parsed.data.taskId, {
    [parsed.data.key]: parsed.data.value,
  });
  if (!res.ok) {
    const problem = res.problems[0];
    return { ok: false, error: problem ? `${problem.label} ${problem.message}.` : "Not allowed." };
  }
  revalidatePath("/tasks");
  return { ok: true, value: res.values[parsed.data.key] ?? null };
}

/** The task field definitions, for the board's grouping and filter pickers. */
export async function getTaskFieldDefs(): Promise<FieldDef[]> {
  const { workspaceId } = await getActiveContext();
  return listFieldDefs(workspaceId, "task", { activeOnly: true });
}
