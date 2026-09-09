"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import {
  startProject,
  loadProject,
  closeProject,
  ensureTemplates,
  type ProjectView,
} from "./store";
import { projectProgress, parseMilestones } from "./templates";

/** A row on the project board. */
export interface ProjectBoardRow {
  id: string;
  name: string;
  dealId: string;
  companyName: string | null;
  startedAt: string;
  closedAt: string | null;
  done: number;
  total: number;
  pct: number;
  overdue: number;
  next: { title: string; dueAt: string | null } | null;
  certificateIssued: boolean;
  /**
   * Estimated and actual minutes (playbook-v5 P20/1) — the two numbers that
   * answer "what does a website project actually cost us", and the ones the
   * pricing intelligence is built on.
   */
  estimateMinutes: number;
  actualMinutes: number;
}

export interface ProjectBoard {
  active: ProjectBoardRow[];
  closed: ProjectBoardRow[];
  templates: Array<{ id: string; name: string; milestoneCount: number }>;
}

export async function getProjectBoard(): Promise<ProjectBoard> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await ensureTemplates(db, workspaceId);

  const projects = await db.project.findMany({
    orderBy: [{ closedAt: "asc" }, { startedAt: "desc" }],
    take: 100,
    include: { milestones: { orderBy: { position: "asc" } } },
  });

  const taskIds = projects.flatMap((p) => p.milestones.map((m) => m.taskId));
  const tasks = taskIds.length
    ? await db.task.findMany({
        where: { id: { in: taskIds } },
        select: { id: true, title: true, dueAt: true, doneAt: true, estimateMinutes: true },
      })
    : [];
  const byTask = new Map(tasks.map((t) => [t.id, t]));

  const companyIds = [...new Set(projects.map((p) => p.companyId).filter(Boolean))] as string[];
  const companies = companyIds.length
    ? await db.company.findMany({
        where: { id: { in: companyIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(companies.map((c) => [c.id, c.name]));

  /** Time logged against each project's milestone tasks, in one query. */
  const logged = taskIds.length
    ? await db.timeEntry.groupBy({
        by: ["taskId"],
        where: { taskId: { in: taskIds } },
        _sum: { minutes: true },
      })
    : [];
  const loggedByTask = new Map(logged.map((l) => [l.taskId, l._sum.minutes ?? 0]));
  const loggedByProject = new Map<string, number>();
  for (const project of projects) {
    loggedByProject.set(
      project.id,
      project.milestones.reduce((n, m) => n + (loggedByTask.get(m.taskId) ?? 0), 0),
    );
  }

  const rows: ProjectBoardRow[] = projects.map((p) => {
    const lines = p.milestones
      .map((m) => {
        const t = byTask.get(m.taskId);
        return t ? { title: t.title, dueAt: t.dueAt, doneAt: t.doneAt, kind: m.kind } : null;
      })
      .filter((l): l is { title: string; dueAt: Date | null; doneAt: Date | null; kind: string } => l !== null);
    const progress = projectProgress(lines);
    const cert = lines.find((l) => l.kind === "certificate");
    return {
      id: p.id,
      name: p.name,
      dealId: p.dealId,
      companyName: p.companyId ? (nameById.get(p.companyId) ?? null) : null,
      startedAt: p.startedAt.toISOString(),
      closedAt: p.closedAt?.toISOString() ?? null,
      done: progress.done,
      total: progress.total,
      pct: progress.pct,
      overdue: progress.overdue,
      next: progress.next
        ? { title: progress.next.title, dueAt: progress.next.dueAt?.toISOString() ?? null }
        : null,
      certificateIssued: !!cert?.doneAt,
      /**
       * What this project was estimated at, and what it has cost so far
       * (playbook-v5 P20/1).
       *
       * The playbook is explicit that this is the point of the whole item: it
       * is how the business answers "what does a website project actually cost
       * us", and the pricing intelligence is only as good as these two
       * numbers. A milestone's own estimate wins over its task's, because the
       * milestone is the costed unit.
       */
      estimateMinutes: p.milestones.reduce(
        (n, m) => n + (m.estimateMinutes ?? byTask.get(m.taskId)?.estimateMinutes ?? 0),
        0,
      ),
      actualMinutes: loggedByProject.get(p.id) ?? 0,
    };
  });

  const templates = await db.projectTemplate.findMany({
    where: { status: "active" },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, milestones: true },
  });

  return {
    active: rows.filter((r) => !r.closedAt),
    closed: rows.filter((r) => r.closedAt),
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      milestoneCount: Array.isArray(t.milestones) ? t.milestones.length : 0,
    })),
  };
}

const startSchema = z.object({
  dealId: z.string().min(1),
  templateId: z.string().min(1).optional(),
  name: z.string().trim().max(200).optional(),
});

export async function startProjectForDeal(
  raw: unknown,
): Promise<{ ok: true; projectId: string } | { ok: false; error: string }> {
  const parsed = startSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Incomplete request." };

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const result = await startProject(db, workspaceId, {
    dealId: parsed.data.dealId,
    templateId: parsed.data.templateId ?? null,
    name: parsed.data.name ?? null,
    // The person who won it owns the checklist until somebody says otherwise.
    ownerId: userId,
    createdBy: userId,
  });
  if (result.ok) {
    revalidatePath("/projects");
    revalidatePath("/deals");
  }
  return result;
}

export interface ProjectDetail {
  id: string;
  name: string;
  dealId: string;
  companyName: string | null;
  startedAt: string;
  closedAt: string | null;
  milestones: Array<{
    id: string;
    taskId: string;
    title: string;
    kind: "generic" | "certificate";
    dueAt: string | null;
    doneAt: string | null;
    note: string | null;
  }>;
  pct: number;
  done: number;
  total: number;
  /** The signed contract this project's certificate would be issued from. */
  contractId: string | null;
  certificateDocumentId: string | null;
}

export async function getProject(projectId: string): Promise<ProjectDetail | null> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const project: ProjectView | null = await loadProject(db, projectId);
  if (!project) return null;

  /**
   * The chain, resolved here rather than guessed in the UI.
   *
   * The certificate milestone is only useful if it can open the generator
   * pre-filled — which needs the SIGNED contract on the same deal. If there
   * isn't one, the milestone says so instead of offering a dead button.
   */
  const contract = await db.document.findFirst({
    where: { dealId: project.dealId, type: "CONTRACT", status: "SIGNED" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const certificate = await db.document.findFirst({
    where: { dealId: project.dealId, type: "CERTIFICATE" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  return {
    id: project.id,
    name: project.name,
    dealId: project.dealId,
    companyName: project.companyName,
    startedAt: project.startedAt.toISOString(),
    closedAt: project.closedAt?.toISOString() ?? null,
    milestones: project.milestones.map((m) => ({
      id: m.id,
      taskId: m.taskId,
      title: m.title,
      kind: m.kind,
      dueAt: m.dueAt?.toISOString() ?? null,
      doneAt: m.doneAt?.toISOString() ?? null,
      note: m.note,
    })),
    pct: project.progress.pct,
    done: project.progress.done,
    total: project.progress.total,
    contractId: contract?.id ?? null,
    certificateDocumentId: certificate?.id ?? null,
  };
}

export async function closeProjectAction(
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const result = await closeProject(db, projectId);
  if (result.ok) revalidatePath("/projects");
  return result;
}

const addSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  dueAt: z.string().optional(),
});

/** A free-form extra line — the playbook asks for it and every project needs one. */
export async function addMilestone(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = addSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Give the milestone a title." };

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const project = await db.project.findUnique({
    where: { id: parsed.data.projectId },
    select: { id: true, closedAt: true },
  });
  if (!project) return { ok: false, error: "Project not found." };
  if (project.closedAt) return { ok: false, error: "This project is closed." };

  const last = await db.milestone.findFirst({
    where: { projectId: project.id },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const task = await db.task.create({
    data: {
      workspaceId,
      type: "todo",
      title: parsed.data.title,
      dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : null,
      entityType: "project",
      entityId: project.id,
      assigneeId: userId,
      source: "project_milestone",
      createdBy: userId,
    },
  });
  await db.milestone.create({
    data: {
      workspaceId,
      projectId: project.id,
      taskId: task.id,
      position: (last?.position ?? -1) + 1,
      kind: "generic",
    },
  });
  revalidatePath("/projects");
  return { ok: true };
}

// ---- template editor (P11/2d) ---------------------------------------------

export interface TemplateRow {
  id: string;
  name: string;
  version: number;
  status: string;
  milestones: Array<{ title: string; dayOffset: number; kind: string }>;
  inUse: number;
}

export async function listProjectTemplates(): Promise<TemplateRow[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await ensureTemplates(db, workspaceId);

  const templates = await db.projectTemplate.findMany({
    where: { status: { not: "archived" } },
    orderBy: { createdAt: "asc" },
  });
  const counts = await Promise.all(
    templates.map((t) => db.project.count({ where: { templateId: t.id } })),
  );
  return templates.map((t, i) => ({
    id: t.id,
    name: t.name,
    version: t.version,
    status: t.status,
    milestones: parseMilestones(t.milestones),
    inUse: counts[i] ?? 0,
  }));
}

const saveTemplateSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(120),
  milestones: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        dayOffset: z.number().int().min(0).max(3650),
        kind: z.enum(["generic", "certificate"]),
      }),
    )
    .min(1)
    .max(40),
});

/**
 * Save a template — as a NEW VERSION when it already exists.
 *
 * Versioned like a document template, and for the same reason: a project
 * records the version it was built from, so editing the template must not
 * rewrite what a running project agreed to deliver. The row's `version` moves
 * forward and projects keep pointing at the number they started with.
 */
export async function saveProjectTemplate(
  raw: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const parsed = saveTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "A template needs a name and at least one milestone." };
  }
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const certificates = parsed.data.milestones.filter((m) => m.kind === "certificate").length;
  if (certificates > 1) {
    return { ok: false, error: "Egy sablonban legfeljebb egy teljesítésigazolás lehet." };
  }

  if (parsed.data.id) {
    const existing = await db.projectTemplate.findUnique({
      where: { id: parsed.data.id },
      select: { version: true },
    });
    if (!existing) return { ok: false, error: "Template not found." };
    await db.projectTemplate.update({
      where: { id: parsed.data.id },
      data: {
        name: parsed.data.name,
        milestones: parsed.data.milestones,
        version: existing.version + 1,
      },
    });
    revalidatePath("/settings");
    return { ok: true, id: parsed.data.id };
  }

  const created = await db.projectTemplate.create({
    data: {
      workspaceId,
      name: parsed.data.name,
      milestones: parsed.data.milestones,
    },
    select: { id: true },
  });
  revalidatePath("/settings");
  return { ok: true, id: created.id };
}

/** Archive rather than delete: a project points at the version it used. */
export async function archiveProjectTemplate(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const remaining = await db.projectTemplate.count({
    where: { status: "active", NOT: { id } },
  });
  if (remaining === 0) {
    return { ok: false, error: "Ez az utolsó sablon — enélkül nem indítható projekt." };
  }
  await db.projectTemplate.update({
    where: { id },
    data: { status: "archived", archivedAt: new Date() },
  });
  revalidatePath("/settings");
  return { ok: true };
}
