"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import {
  addChecklistItem,
  editChecklistItem,
  listChecklist,
  promoteToSubtask,
  removeChecklistItem,
  setChecklistItemDone,
  type ChecklistItem,
  type ChecklistProgress,
} from "./checklist";

const id = z.string().min(1).max(60);

export async function getChecklist(
  taskId: string,
): Promise<(Omit<ChecklistItem, "doneAt"> & { doneAt: string | null })[]> {
  const parsed = id.safeParse(taskId);
  if (!parsed.success) return [];
  const { workspaceId } = await getActiveContext();
  const items = await listChecklist(workspaceId, parsed.data);
  return items.map((i) => ({ ...i, doneAt: i.doneAt?.toISOString() ?? null }));
}

export async function addChecklistStep(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z.object({ taskId: id, text: z.string().min(1).max(200) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Give the step some words." };
  const { workspaceId } = await getActiveContext();
  const res = await addChecklistItem(workspaceId, parsed.data.taskId, parsed.data.text);
  if (res.ok) revalidatePath("/tasks");
  return res.ok ? { ok: true } : res;
}

export async function tickChecklistStep(
  itemId: string,
  done: boolean,
): Promise<{ ok: true; progress: ChecklistProgress } | { ok: false; error: string }> {
  const parsed = id.safeParse(itemId);
  if (!parsed.success) return { ok: false, error: "Unknown step." };
  const { workspaceId } = await getActiveContext();
  const res = await setChecklistItemDone(workspaceId, parsed.data, done);
  if (res.ok) revalidatePath("/tasks");
  return res;
}

export async function renameChecklistStep(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z.object({ itemId: id, text: z.string().min(1).max(200) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Give the step some words." };
  const { workspaceId } = await getActiveContext();
  const res = await editChecklistItem(workspaceId, parsed.data.itemId, parsed.data.text);
  if (res.ok) revalidatePath("/tasks");
  return res;
}

export async function deleteChecklistStep(
  itemId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = id.safeParse(itemId);
  if (!parsed.success) return { ok: false, error: "Unknown step." };
  const { workspaceId } = await getActiveContext();
  const res = await removeChecklistItem(workspaceId, parsed.data);
  if (res.ok) revalidatePath("/tasks");
  return res;
}

/** One action, because retyping it as a subtask is the friction to remove. */
export async function promoteChecklistStep(
  itemId: string,
): Promise<{ ok: true; subtaskId: string } | { ok: false; error: string }> {
  const parsed = id.safeParse(itemId);
  if (!parsed.success) return { ok: false, error: "Unknown step." };
  const { workspaceId } = await getActiveContext();
  const res = await promoteToSubtask(workspaceId, parsed.data);
  if (res.ok) revalidatePath("/tasks");
  return res;
}
