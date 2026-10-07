import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { Prisma, type Role } from "@prisma/client";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { GRANTS, OWNER_GRANTS, type Grant } from "@/lib/grants";
import { canSignIn } from "@/modules/members/lifecycle";
import { recordMemberEvent } from "@/modules/members/timeline";

/**
 * Administering a workspace by id — not just the active one.
 *
 * ── WHY THIS IS NOT IN actions.ts ──────────────────────────────────────────
 *
 * The rules live here as plain functions taking the actor's id, so the
 * integration suite can exercise every refusal without a request context. The
 * server actions (./admin-actions.ts) add exactly one thing: who the actor is,
 * read from the session.
 *
 * ── THE ONE RULE EVERY FUNCTION OBEYS ──────────────────────────────────────
 *
 * The actor must be a live Owner of THE WORKSPACE BEING CHANGED. Being Owner of
 * the active workspace says nothing about another one; `requireOwner()` answers
 * only for the active one, so nothing here uses it.
 */

export const DELETE_GRACE_DAYS = 30;
const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

export async function isLiveOwner(userId: string, workspaceId: string): Promise<boolean> {
  const member = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true, state: true, workspace: { select: { deletedAt: true } } },
  });
  return member?.role === "OWNER" && canSignIn(member.state) && !member.workspace.deletedAt;
}

// ---------------------------------------------------------------------------
// members of a chosen workspace
// ---------------------------------------------------------------------------

export interface WorkspaceMemberRow {
  userId: string;
  name: string;
  email: string;
  role: string;
  state: string;
}

export async function membersOf(workspaceId: string): Promise<WorkspaceMemberRow[]> {
  const rows = await prismaUnsafe.membership.findMany({
    where: { workspaceId, state: { not: "REMOVED" } },
    select: { role: true, state: true, user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    userId: r.user.id,
    name: r.user.name,
    email: r.user.email,
    role: r.role,
    state: r.state,
  }));
}

export interface AssignableUser {
  userId: string;
  name: string;
  email: string;
}

/**
 * The people this Owner may add to `workspaceId` directly.
 *
 * Only people the Owner already works with: an ACTIVE member of some workspace
 * the actor is a live Owner of. That is the boundary that makes a direct add
 * (no invitation, no consent step) acceptable — the Owner is moving a colleague
 * between their own companies, not pulling a stranger's account in by email.
 * Anybody else goes through an invitation, which they accept themselves.
 */
export async function assignableUsersFor(
  actorId: string,
  workspaceId: string,
): Promise<AssignableUser[]> {
  const owned = await prismaUnsafe.membership.findMany({
    where: { userId: actorId, role: "OWNER", state: "ACTIVE", workspace: { deletedAt: null } },
    select: { workspaceId: true },
  });
  const ownedIds = owned.map((o) => o.workspaceId).filter((id) => id !== workspaceId);
  if (ownedIds.length === 0) return [];

  const [candidates, present] = await Promise.all([
    prismaUnsafe.membership.findMany({
      where: {
        workspaceId: { in: ownedIds },
        state: "ACTIVE",
        role: { not: "CLIENT" },
        user: { deletedAt: null },
      },
      select: { user: { select: { id: true, name: true, email: true } } },
    }),
    prismaUnsafe.membership.findMany({
      // INVITED is NOT "present": a stuck invitation is exactly what a direct
      // add should be able to finish.
      where: { workspaceId, state: { in: ["ACTIVE", "SUSPENDED"] } },
      select: { userId: true },
    }),
  ]);
  const here = new Set(present.map((p) => p.userId));
  const seen = new Map<string, AssignableUser>();
  for (const c of candidates) {
    if (here.has(c.user.id) || seen.has(c.user.id)) continue;
    seen.set(c.user.id, { userId: c.user.id, name: c.user.name, email: c.user.email });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function assignExistingUser(input: {
  actorId: string;
  workspaceId: string;
  userId: string;
  role: Role;
  grants: string[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await isLiveOwner(input.actorId, input.workspaceId))) {
    return { ok: false, error: "Only an Owner of that workspace can add people to it." };
  }
  if (input.role === "CLIENT") {
    return { ok: false, error: "A client account is added by invitation, with the company it may see." };
  }
  const allowed = await assignableUsersFor(input.actorId, input.workspaceId);
  if (!allowed.some((u) => u.userId === input.userId)) {
    return {
      ok: false,
      error: "That person is not in one of your workspaces. Send them an invitation instead.",
    };
  }

  const before = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId: input.userId, workspaceId: input.workspaceId } },
    select: { state: true, role: true },
  });
  const grants: Grant[] =
    input.role === "OWNER"
      ? [...OWNER_GRANTS]
      : input.grants.filter((g): g is Grant => (GRANTS as readonly string[]).includes(g));

  await prismaUnsafe.membership.upsert({
    where: { userId_workspaceId: { userId: input.userId, workspaceId: input.workspaceId } },
    update: {
      state: "ACTIVE",
      role: input.role,
      grants,
      clientCompanyId: null,
      suspendedAt: null,
      suspendedBy: null,
      removedAt: null,
      removedBy: null,
    },
    create: {
      userId: input.userId,
      workspaceId: input.workspaceId,
      state: "ACTIVE",
      role: input.role,
      grants,
    },
  });

  // A stuck invitation for the same person is finished by this, not left
  // lying around as a second working token.
  const user = await prismaUnsafe.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { email: true },
  });
  await getWorkspaceClient(input.workspaceId).invitation.updateMany({
    where: { email: user.email.toLowerCase(), acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await recordMemberEvent({
    workspaceId: input.workspaceId,
    userId: input.userId,
    actorUserId: input.actorId,
    kind: "accepted",
    reason: "Added directly by an Owner from another of their workspaces",
    before: before ? { state: before.state, role: before.role } : null,
    after: { state: "ACTIVE", role: input.role, grants },
    meta: { direct: true },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// details
// ---------------------------------------------------------------------------

export interface WorkspaceDetails {
  id: string;
  name: string;
  legalName: string;
  brandColor: string;
  logoUrl: string;
  mailgunDomain: string;
  claudeBudget: number;
  retentionDays: number;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export async function detailsOf(workspaceId: string): Promise<WorkspaceDetails | null> {
  const ws = await prismaUnsafe.workspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: {
      id: true,
      name: true,
      legalName: true,
      brand: true,
      mailgunConfig: true,
      claudeBudget: true,
      retentionDays: true,
    },
  });
  if (!ws) return null;
  const brand = asObject(ws.brand);
  const mail = asObject(ws.mailgunConfig);
  return {
    id: ws.id,
    name: ws.name,
    legalName: ws.legalName ?? "",
    brandColor: typeof brand.color === "string" ? brand.color : "",
    logoUrl: typeof brand.logoUrl === "string" ? brand.logoUrl : "",
    mailgunDomain: typeof mail.domain === "string" ? mail.domain : "",
    claudeBudget: Number(ws.claudeBudget),
    retentionDays: ws.retentionDays,
  };
}

export async function updateDetails(input: {
  actorId: string;
  workspaceId: string;
  name: string;
  legalName: string;
  brandColor: string;
  logoUrl: string;
  mailgunDomain: string;
  claudeBudget: number;
  retentionDays: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await isLiveOwner(input.actorId, input.workspaceId))) {
    return { ok: false, error: "Only an Owner of that workspace can edit it." };
  }
  const ws = await prismaUnsafe.workspace.findUniqueOrThrow({
    where: { id: input.workspaceId },
    select: { brand: true, mailgunConfig: true },
  });
  const before = await detailsOf(input.workspaceId);

  // Merged, never replaced: `brand` also carries the letterhead, fonts and an
  // uploaded logo's path, and `mailgunConfig` the sender identity. This form
  // owns only the fields it shows.
  const brand = asObject(ws.brand);
  const nextBrand: Record<string, unknown> = { ...brand, color: input.brandColor || null };
  if ((input.logoUrl || "") !== (typeof brand.logoUrl === "string" ? brand.logoUrl : "")) {
    // A typed URL replaces an uploaded file; the upload's path would otherwise
    // keep serving the old picture.
    nextBrand.logoUrl = input.logoUrl || null;
    nextBrand.logoPath = null;
  }
  const mail = asObject(ws.mailgunConfig);
  const nextMail = { ...mail };
  if (input.mailgunDomain) nextMail.domain = input.mailgunDomain;
  else delete nextMail.domain;

  await prismaUnsafe.workspace.update({
    where: { id: input.workspaceId },
    data: {
      name: input.name,
      legalName: input.legalName || null,
      brand: nextBrand as Prisma.InputJsonValue,
      mailgunConfig:
        Object.keys(nextMail).length > 0 ? (nextMail as Prisma.InputJsonValue) : Prisma.DbNull,
      claudeBudget: input.claudeBudget,
      retentionDays: input.retentionDays,
    },
  });

  const after = await detailsOf(input.workspaceId);
  await getWorkspaceClient(input.workspaceId).auditLog.create({
    data: {
      workspaceId: input.workspaceId,
      actorUserId: input.actorId,
      action: "workspace.update",
      entityType: "Workspace",
      entityId: input.workspaceId,
      meta: { before, after } as unknown as Prisma.InputJsonValue,
    },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// deletion: hidden at once, purged after a grace period
// ---------------------------------------------------------------------------

export interface DeletedWorkspace {
  id: string;
  name: string;
  deletedAt: string;
  purgeAfter: string;
}

/**
 * Delete a workspace — the reversible half.
 *
 * From this moment the workspace is in nobody's switcher, no session resolves
 * to it, no sign-in lands in it and no background job sweeps it (every
 * `workspace.findMany` filters `deletedAt`). Its data stays for
 * DELETE_GRACE_DAYS so a wrong click can be undone; then the purge erases it.
 *
 * Refused when it is the actor's last workspace: deleting it would leave them
 * an account that can sign in to nothing, including to undo this.
 */
export async function softDeleteWorkspace(input: {
  actorId: string;
  workspaceId: string;
  confirmName: string;
  now?: Date;
}): Promise<{ ok: true; purgeAfter: string } | { ok: false; error: string }> {
  const now = input.now ?? new Date();
  if (!(await isLiveOwner(input.actorId, input.workspaceId))) {
    return { ok: false, error: "Only an Owner of that workspace can delete it." };
  }
  const ws = await prismaUnsafe.workspace.findUniqueOrThrow({
    where: { id: input.workspaceId },
    select: { name: true },
  });
  if (input.confirmName.trim() !== ws.name.trim()) {
    return { ok: false, error: `Type the workspace name exactly — "${ws.name}" — to delete it.` };
  }
  const elsewhere = await prismaUnsafe.membership.findFirst({
    where: {
      userId: input.actorId,
      state: "ACTIVE",
      workspaceId: { not: input.workspaceId },
      workspace: { deletedAt: null },
    },
    select: { workspaceId: true },
  });
  if (!elsewhere) {
    return {
      ok: false,
      error: "This is your only workspace. Create or join another one before deleting it.",
    };
  }

  const purgeAfter = new Date(now.getTime() + DELETE_GRACE_DAYS * 86_400_000);
  await prismaUnsafe.workspace.update({
    where: { id: input.workspaceId },
    data: { deletedAt: now, deletedBy: input.actorId, purgeAfter },
  });

  const meta = { name: ws.name, purgeAfter: purgeAfter.toISOString() };
  await getWorkspaceClient(input.workspaceId).auditLog.create({
    data: {
      workspaceId: input.workspaceId,
      actorUserId: input.actorId,
      action: "workspace.delete",
      entityType: "Workspace",
      entityId: input.workspaceId,
      meta,
    },
  });
  // The deleted workspace's own log goes with it at the purge. The fact of the
  // deletion must outlive it, so it is written where the actor still works.
  await getWorkspaceClient(elsewhere.workspaceId).auditLog.create({
    data: {
      workspaceId: elsewhere.workspaceId,
      actorUserId: input.actorId,
      action: "workspace.delete",
      entityType: "Workspace",
      entityId: input.workspaceId,
      meta,
    },
  });
  return { ok: true, purgeAfter: purgeAfter.toISOString() };
}

/** The workspaces this person deleted (or co-owned) that can still be restored. */
export async function restorableFor(actorId: string, now: Date = new Date()): Promise<DeletedWorkspace[]> {
  const rows = await prismaUnsafe.membership.findMany({
    where: {
      userId: actorId,
      role: "OWNER",
      state: "ACTIVE",
      workspace: { deletedAt: { not: null }, purgeAfter: { gt: now } },
    },
    select: { workspace: { select: { id: true, name: true, deletedAt: true, purgeAfter: true } } },
  });
  return rows.map((r) => ({
    id: r.workspace.id,
    name: r.workspace.name,
    deletedAt: r.workspace.deletedAt!.toISOString(),
    purgeAfter: r.workspace.purgeAfter!.toISOString(),
  }));
}

export async function restoreWorkspace(input: {
  actorId: string;
  workspaceId: string;
  now?: Date;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = input.now ?? new Date();
  const restorable = await restorableFor(input.actorId, now);
  if (!restorable.some((w) => w.id === input.workspaceId)) {
    return { ok: false, error: "That workspace cannot be restored any more." };
  }
  await prismaUnsafe.workspace.update({
    where: { id: input.workspaceId },
    data: { deletedAt: null, deletedBy: null, purgeAfter: null },
  });
  await getWorkspaceClient(input.workspaceId).auditLog.create({
    data: {
      workspaceId: input.workspaceId,
      actorUserId: input.actorId,
      action: "workspace.restore",
      entityType: "Workspace",
      entityId: input.workspaceId,
      meta: {},
    },
  });
  return { ok: true };
}

/**
 * Every model that carries a `workspaceId`, read from the schema itself.
 *
 * Generated rather than listed so a table added next month cannot be left
 * behind by a purge that predates it — the same reason the RLS coverage test
 * compares against the schema rather than trusting a list.
 */
export function workspaceScopedModels(): string[] {
  return Prisma.dmmf.datamodel.models
    // Memberships cascade with the workspace row. A session is the PERSON's,
    // and only points at a workspace as the one it last had open — it is
    // re-pointed, not deleted, so nobody is signed out by somebody else's purge.
    .filter((m) => !["Membership", "Session"].includes(m.name))
    .filter((m) => m.fields.some((f) => f.name === "workspaceId"))
    .map((m) => m.name);
}

function delegateFor(model: string): { deleteMany: (args: unknown) => Promise<{ count: number }> } {
  const key = model.charAt(0).toLowerCase() + model.slice(1);
  return (prismaUnsafe as unknown as Record<string, never>)[key] as never;
}

/** Files under FILES_DIR that belong to this workspace, found through their rows. */
async function filesOf(workspaceId: string): Promise<string[]> {
  const [docs, reports, meetings, attachments, audits, leads, ws] = await Promise.all([
    prismaUnsafe.document.findMany({ where: { workspaceId }, select: { pdfUrl: true } }),
    prismaUnsafe.report.findMany({ where: { workspaceId }, select: { pdfPath: true } }),
    prismaUnsafe.meeting.findMany({ where: { workspaceId }, select: { briefPdfPath: true } }),
    prismaUnsafe.taskAttachment.findMany({ where: { workspaceId }, select: { path: true } }),
    prismaUnsafe.auditResult.findMany({ where: { workspaceId }, select: { id: true } }),
    prismaUnsafe.lead.findMany({ where: { workspaceId }, select: { avatarPath: true } }),
    prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { brand: true } }),
  ]);
  const out: (string | null | undefined)[] = [
    ...docs.map((d) => d.pdfUrl),
    ...reports.map((r) => r.pdfPath),
    ...meetings.map((m) => m.briefPdfPath),
    ...attachments.map((a) => a.path),
    ...leads.map((l) => l.avatarPath),
    ...audits.flatMap((a) => [
      `audits/${a.id}.pdf`,
      `audits/${a.id}-desktop.png`,
      `audits/${a.id}-mobile.png`,
    ]),
  ];
  const logoPath = asObject(ws?.brand).logoPath;
  if (typeof logoPath === "string") out.push(logoPath);
  // Only relative paths inside FILES_DIR — never anything that could climb out.
  return out.filter(
    (p): p is string => typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.includes(".."),
  );
}

/**
 * Erase a workspace and everything in it. Irreversible; run only by the purge
 * job once the grace period is over (and by tests).
 *
 * Only `memberships` is a declared relation on Workspace, so deleting the row
 * alone would orphan every lead, document and log. Instead every scoped model
 * is emptied, in as many passes as the foreign keys between them need: a model
 * whose rows are still referenced fails this pass and succeeds on a later one,
 * after the rows pointing at it are gone. No progress in a full pass means a
 * real problem, and it throws rather than leaving a half-erased workspace
 * pretending to be finished.
 */
export async function purgeWorkspace(workspaceId: string): Promise<{ rows: number; files: number }> {
  const files = await filesOf(workspaceId);
  await prismaUnsafe.session.updateMany({ where: { workspaceId }, data: { workspaceId: null } });
  let pending = workspaceScopedModels();
  let rows = 0;
  let lastError: unknown = null;

  while (pending.length > 0) {
    const failed: string[] = [];
    for (const model of pending) {
      try {
        const res = await delegateFor(model).deleteMany({ where: { workspaceId } });
        rows += res.count;
      } catch (e) {
        lastError = e;
        failed.push(model);
      }
    }
    if (failed.length === pending.length) {
      throw new Error(
        `purge of ${workspaceId} is stuck on ${failed.join(", ")}: ${(lastError as Error)?.message}`,
      );
    }
    pending = failed;
  }

  // Memberships cascade with the row.
  await prismaUnsafe.workspace.delete({ where: { id: workspaceId } });

  let removed = 0;
  for (const rel of files) {
    try {
      await unlink(join(FILES_DIR, rel));
      removed += 1;
    } catch {
      // Already gone, or never written — nothing to erase.
    }
  }
  return { rows, files: removed };
}

/** The nightly sweep: purge every workspace whose grace period has run out. */
export async function purgeDueWorkspaces(now: Date = new Date()): Promise<number> {
  const due = await prismaUnsafe.workspace.findMany({
    where: { deletedAt: { not: null }, purgeAfter: { lte: now } },
    select: { id: true },
  });
  for (const ws of due) {
    await purgeWorkspace(ws.id);
  }
  return due.length;
}
