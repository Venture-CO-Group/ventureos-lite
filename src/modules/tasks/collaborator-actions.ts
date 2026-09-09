"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import {
  addCollaborator,
  listCollaborators,
  removeCollaborator,
  taskTrail,
  type CollaboratorView,
} from "./collaborators";

const id = z.string().min(1).max(60);

export interface TaskPeopleView {
  collaborators: CollaboratorView[];
  /** The handover trail, newest first, already turned into sentences. */
  trail: Array<{ id: string; kind: string; at: string; text: string }>;
}

export async function getTaskPeople(taskId: string): Promise<TaskPeopleView> {
  const parsed = id.safeParse(taskId);
  if (!parsed.success) return { collaborators: [], trail: [] };
  const { workspaceId } = await getActiveContext();
  const [collaborators, trail] = await Promise.all([
    listCollaborators(workspaceId, parsed.data),
    taskTrail(workspaceId, parsed.data),
  ]);
  return {
    collaborators,
    trail: trail.map((t) => ({ id: t.id, kind: t.kind, at: t.at, text: t.text })),
  };
}

export async function addTaskCollaborator(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z.object({ taskId: id, userId: id }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Choose somebody to add." };
  const { workspaceId, userId } = await getActiveContext();
  const res = await addCollaborator(workspaceId, parsed.data.taskId, parsed.data.userId, userId);
  if (res.ok) revalidatePath("/tasks");
  return res;
}

export async function removeTaskCollaborator(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z.object({ taskId: id, userId: id }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown collaborator." };
  const { workspaceId, userId } = await getActiveContext();
  const res = await removeCollaborator(
    workspaceId,
    parsed.data.taskId,
    parsed.data.userId,
    userId,
  );
  if (res.ok) revalidatePath("/tasks");
  return res;
}
