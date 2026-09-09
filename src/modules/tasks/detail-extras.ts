"use server";

import { z } from "zod";
import { getActiveContext } from "@/lib/session";
import { listChecklist } from "./checklist";
import { listCollaborators, taskTrail } from "./collaborators";
import { linksForTask } from "./entity-tasks";
import { labelEntityLinks } from "./entity-labels";
import type { ChecklistItem } from "./checklist-logic";
import type { CollaboratorView } from "./collaborators";
import type { EntityKind } from "./links";

/**
 * Everything the detail panel's three newer sections need, in one call
 * (playbook-v5 P20/3, P20/4, P20/6).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Each of those sections arrived with its own `useEffect` fetch, which is the
 * natural way to build them and the wrong way to open a task: by the end of
 * P20 the panel fired six Server Actions the moment it mounted, and the next
 * thing the person did — adding a dependency, ticking a box — queued behind
 * all of them. It showed up as a browser test that passed on its own and
 * failed in a full run, which is the shape of a problem that would have
 * reached somebody's laptop as "the panel is slow" and never been diagnosed.
 *
 * One call, one set of queries. Each section keeps its own reload for after
 * its own mutations, where a single round trip is exactly right.
 */
export interface TaskExtras {
  checklist: Array<Omit<ChecklistItem, "doneAt"> & { doneAt: string | null }>;
  links: Array<{ kind: EntityKind; id: string; label: string }>;
  collaborators: CollaboratorView[];
  trail: Array<{ id: string; kind: string; at: string; text: string }>;
}

const EMPTY: TaskExtras = { checklist: [], links: [], collaborators: [], trail: [] };

export async function getTaskExtras(taskId: string): Promise<TaskExtras> {
  const parsed = z.string().min(1).max(60).safeParse(taskId);
  if (!parsed.success) return EMPTY;
  const { workspaceId } = await getActiveContext();
  const id = parsed.data;

  const [checklist, rawLinks, collaborators, trail] = await Promise.all([
    listChecklist(workspaceId, id),
    linksForTask(workspaceId, id),
    listCollaborators(workspaceId, id),
    taskTrail(workspaceId, id),
  ]);

  return {
    checklist: checklist.map((i) => ({ ...i, doneAt: i.doneAt?.toISOString() ?? null })),
    links: await labelEntityLinks(workspaceId, rawLinks),
    collaborators,
    trail: trail.map((t) => ({ id: t.id, kind: t.kind, at: t.at, text: t.text })),
  };
}
