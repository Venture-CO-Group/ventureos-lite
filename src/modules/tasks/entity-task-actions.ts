"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { ENTITY_KINDS, type EntityKind } from "./links";
import {
  addTaskLink,
  entityTaskPanel,
  linksForTask,
  removeTaskLink,
  type EntityTaskPanel,
} from "./entity-tasks";

/**
 * The panels on a lead, company, deal or project (playbook-v5 P20/4).
 *
 * Dates cross to the client as ISO strings, because a Server Action's return
 * value is serialised and a Date arrives as something that is not a Date.
 */
export interface EntityTaskRowView {
  id: string;
  title: string;
  type: string;
  priority: string;
  dueAt: string | null;
  doneAt: string | null;
  assigneeName: string | null;
  boardId: string | null;
  boardName: string | null;
  source: string | null;
  primary: boolean;
}

export interface EntityTaskPanelView {
  open: EntityTaskRowView[];
  recentlyDone: EntityTaskRowView[];
  openCount: number;
  doneCount: number;
}

const kind = z.enum(ENTITY_KINDS);
const entityId = z.string().min(1).max(60);

function toView(panel: EntityTaskPanel): EntityTaskPanelView {
  const row = (r: EntityTaskPanel["open"][number]): EntityTaskRowView => ({
    id: r.id,
    title: r.title,
    type: r.type,
    priority: r.priority,
    dueAt: r.dueAt?.toISOString() ?? null,
    doneAt: r.doneAt?.toISOString() ?? null,
    assigneeName: r.assigneeName,
    boardId: r.boardId,
    boardName: r.boardName,
    source: r.source,
    primary: r.primary,
  });
  return {
    open: panel.open.map(row),
    recentlyDone: panel.recentlyDone.map(row),
    openCount: panel.openCount,
    doneCount: panel.doneCount,
  };
}

const EMPTY: EntityTaskPanelView = { open: [], recentlyDone: [], openCount: 0, doneCount: 0 };

export async function getEntityTasks(
  rawKind: string,
  rawId: string,
): Promise<EntityTaskPanelView> {
  const parsed = z.object({ kind, entityId }).safeParse({ kind: rawKind, entityId: rawId });
  if (!parsed.success) return EMPTY;
  const { workspaceId } = await getActiveContext();
  return toView(await entityTaskPanel(workspaceId, parsed.data.kind, parsed.data.entityId));
}

/**
 * "Add a task for this lead" — pre-linked, so the one thing a person came to
 * the panel to do takes a title and nothing else.
 */
export async function addTaskForEntity(
  raw: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const parsed = z
    .object({ kind, entityId, title: z.string().trim().min(2).max(200) })
    .safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Give the task a title of at least two characters." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  /**
   * It goes in as a LOOSE task — no board, no section. That is what the model
   * has always allowed for follow-ups raised from a lead, it is what My Work
   * shows, and putting it on an arbitrary board would be a guess about where
   * this person keeps their work.
   */
  const task = await db.task.create({
    data: {
      workspaceId,
      title: parsed.data.title,
      entityType: parsed.data.kind,
      entityId: parsed.data.entityId,
      assigneeId: userId,
      createdBy: userId,
    },
    select: { id: true },
  });

  revalidatePath("/leads");
  revalidatePath("/deals");
  revalidatePath("/projects");
  revalidatePath("/tasks");
  return { ok: true, id: task.id };
}

export async function getTaskLinks(
  taskId: string,
): Promise<{ kind: EntityKind; id: string; label: string }[]> {
  const parsed = entityId.safeParse(taskId);
  if (!parsed.success) return [];
  const { workspaceId } = await getActiveContext();
  const links = await linksForTask(workspaceId, parsed.data);
  return labelLinks(workspaceId, links);
}

/**
 * Names for the chips. Resolved here rather than in the store because a label
 * is a presentation concern and each kind lives in a different table.
 */
async function labelLinks(
  workspaceId: string,
  links: { kind: EntityKind; id: string }[],
): Promise<{ kind: EntityKind; id: string; label: string }[]> {
  if (links.length === 0) return [];
  const db = getWorkspaceClient(workspaceId);
  const idsOf = (k: EntityKind) => links.filter((l) => l.kind === k).map((l) => l.id);

  const [leads, companies, deals, projects] = await Promise.all([
    idsOf("lead").length
      ? db.lead.findMany({
          where: { id: { in: idsOf("lead") } },
          select: { id: true, contactName: true, company: { select: { name: true } } },
        })
      : Promise.resolve([]),
    idsOf("company").length
      ? db.company.findMany({
          where: { id: { in: idsOf("company") } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    idsOf("deal").length
      ? db.deal.findMany({
          where: { id: { in: idsOf("deal") } },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
    idsOf("project").length
      ? db.project.findMany({
          where: { id: { in: idsOf("project") } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const label = new Map<string, string>();
  for (const l of leads) label.set(`lead:${l.id}`, l.contactName || l.company?.name || "lead");
  for (const c of companies) label.set(`company:${c.id}`, c.name);
  for (const d of deals) label.set(`deal:${d.id}`, d.title);
  for (const p of projects) label.set(`project:${p.id}`, p.name);

  return links.map((l) => ({
    ...l,
    // A link whose entity has since been deleted still shows, as "(removed)",
    // rather than vanishing — a task pointing at nothing is worth seeing.
    label: label.get(`${l.kind}:${l.id}`) ?? "(removed)",
  }));
}

/**
 * Somewhere to link a task to, found by name (playbook-v5 P20/4).
 *
 * One kind at a time, because the picker asks for the kind first — which keeps
 * this to a single indexed `contains` per call rather than a fan-out across
 * four tables on every keystroke.
 */
export async function searchLinkTargets(
  rawKind: string,
  query: string,
): Promise<{ id: string; label: string; subtitle: string | null }[]> {
  const parsed = z
    .object({ kind, query: z.string().trim().min(2).max(80) })
    .safeParse({ kind: rawKind, query });
  if (!parsed.success) return [];
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const q = parsed.data.query;
  /**
   * Postgres `contains` is case-sensitive without the flag and MySQL rejects
   * the flag; the schema has to run on both, so it is applied per flavour —
   * the same shape global search uses.
   */
  const like =
    (process.env.DB_FLAVOR ?? "postgres") === "postgres"
      ? { contains: q, mode: "insensitive" as const }
      : { contains: q };
  const take = 8;

  switch (parsed.data.kind) {
    case "lead": {
      const rows = await db.lead.findMany({
        where: {
          mergedIntoId: null,
          OR: [{ contactName: like }, { email: like }, { company: { name: like } }],
        },
        take,
        orderBy: { lastActivityAt: "desc" },
        select: { id: true, contactName: true, company: { select: { name: true } } },
      });
      return rows.map((r) => ({
        id: r.id,
        label: r.contactName || r.company?.name || "lead",
        subtitle: r.company?.name ?? null,
      }));
    }
    case "company": {
      const rows = await db.company.findMany({
        where: { OR: [{ name: like }, { domain: like }] },
        take,
        orderBy: { name: "asc" },
        select: { id: true, name: true, domain: true },
      });
      return rows.map((r) => ({ id: r.id, label: r.name, subtitle: r.domain }));
    }
    case "deal": {
      const rows = await db.deal.findMany({
        where: { OR: [{ title: like }, { company: { name: like } }] },
        take,
        orderBy: { updatedAt: "desc" },
        select: { id: true, title: true, company: { select: { name: true } } },
      });
      return rows.map((r) => ({ id: r.id, label: r.title, subtitle: r.company?.name ?? null }));
    }
    case "project": {
      const rows = await db.project.findMany({
        where: { name: like },
        take,
        orderBy: { startedAt: "desc" },
        select: { id: true, name: true },
      });
      return rows.map((r) => ({ id: r.id, label: r.name, subtitle: null }));
    }
    case "document": {
      // Documents are linked from the document itself, where the numbering and
      // the grants are in view. Offering them in a free-text picker would let
      // a task point at a draft nobody is allowed to open.
      return [];
    }
    default: {
      const exhaustive: never = parsed.data.kind;
      throw new Error(`unhandled entity kind: ${String(exhaustive)}`);
    }
  }
}

export async function linkTaskTo(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z.object({ taskId: entityId, kind, entityId }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Pick something to link it to." };
  const { workspaceId, userId } = await getActiveContext();
  const res = await addTaskLink(
    workspaceId,
    parsed.data.taskId,
    parsed.data.kind,
    parsed.data.entityId,
    userId,
  );
  if (res.ok) {
    revalidatePath("/tasks");
    revalidatePath("/leads");
  }
  return res;
}

export async function unlinkTaskFrom(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z.object({ taskId: entityId, kind, entityId }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown link." };
  const { workspaceId } = await getActiveContext();
  const res = await removeTaskLink(
    workspaceId,
    parsed.data.taskId,
    parsed.data.kind,
    parsed.data.entityId,
  );
  if (res.ok) {
    revalidatePath("/tasks");
    revalidatePath("/leads");
  }
  return res;
}
