"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { Role } from "@prisma/client";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { setSessionWorkspace } from "@/lib/auth/sessions";
import { requireOwner } from "@/lib/authz";
import { GRANTS, OWNER_GRANTS, type Grant } from "@/lib/grants";
import { NO_PASSWORD } from "@/lib/auth/password";
import { getBudgetStatus, type BudgetStatus } from "@/lib/ai/budget-status";
import { unreadCount } from "@/modules/notifications/store";
import { brandFrom, type WorkspaceBrand } from "@/modules/workspaces/brand";
import { provisionWorkspace, DEFAULT_ICP_CONFIG } from "./provision";
import { hiddenFeatures, sanitizeHidden } from "./nav-visibility";

// ---- reads (shell + settings) ---------------------------------------------

export interface WorkspaceOption {
  id: string;
  name: string;
  role: string;
  active: boolean;
}

export interface ShellContext {
  user: {
    id: string;
    name: string;
    email: string;
    initials: string;
    /** Their own photo, when they have uploaded one. Initials otherwise. */
    avatarUrl: string | null;
  };
  activeWorkspaceId: string;
  workspaces: WorkspaceOption[];
  role: string;
  /** Owner reset this user's 2FA; the shell redirects to enrollment. */
  mustEnrollTotp: boolean;
  /** Today's real Claude spend vs this workspace's cap — drives the shell meter. */
  budget: BudgetStatus;
  /** Unread notifications for this user in this workspace — the bell badge. */
  unreadNotifications: number;
  /** The workspace's letterhead, for the shell wordmark. */
  brand: WorkspaceBrand;
  /**
   * Nav keys this workspace has switched off (see ./nav-visibility).
   *
   * Decluttering, not permission: the shell and the palette drop these rows,
   * and every route behind them keeps exactly the checks it already had.
   */
  hiddenNav: string[];
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export async function getShellContext(): Promise<ShellContext> {
  const { workspaceId, userId } = await getActiveContext();
  const user = await prismaUnsafe.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, mustEnrollTotp: true, avatarPath: true },
  });
  const memberships = await prismaUnsafe.membership.findMany({
    where: { userId },
    include: { workspace: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const workspaces: WorkspaceOption[] = memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    role: m.role,
    active: m.workspace.id === workspaceId,
  }));
  const role = memberships.find((m) => m.workspaceId === workspaceId)?.role ?? "BDR";
  const budget = await getBudgetStatus(workspaceId);
  // The shell's wordmark is the WORKSPACE's, not the product's: once someone is
  // signed in there is a workspace to brand with (audit-v2 item 6).
  const brandRow = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { brand: true, featureFlags: true },
  });
  // Server-rendered so the bell badge is right on first paint rather than
  // popping in. A count on an indexed column — cheap enough for every page.
  const unreadNotifications = await unreadCount(workspaceId, userId);
  return {
    user: {
      id: userId,
      name: user?.name ?? "User",
      email: user?.email ?? "",
      initials: initials(user?.name ?? "U"),
      // Served by id through an authenticated route; the path's hash busts the
      // cache when the photo is replaced.
      avatarUrl: user?.avatarPath ? `/api/users/${userId}/avatar` : null,
    },
    activeWorkspaceId: workspaceId,
    workspaces,
    role,
    mustEnrollTotp: user?.mustEnrollTotp ?? false,
    budget,
    unreadNotifications,
    brand: brandFrom(brandRow?.brand),
    hiddenNav: [...hiddenFeatures(brandRow?.featureFlags)],
  };
}

// ---- what this workspace shows (Owner) ------------------------------------

/** The current hidden set, for the settings screen. */
export async function getHiddenNav(): Promise<string[]> {
  const { workspaceId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { featureFlags: true },
  });
  return [...hiddenFeatures(ws?.featureFlags)];
}

/**
 * Switch menu items off (or back on).
 *
 * Owner-only and audit-logged. It changes what an entire workspace sees, which
 * is not a preference — a BDR who cannot find Documents any more should be able
 * to learn from the log who removed it and when.
 */
export async function setHiddenNav(
  keys: unknown,
): Promise<{ ok: true; hidden: string[] } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can change what this workspace shows." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const hidden = sanitizeHidden(keys);

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { featureFlags: true },
  });
  // Merged rather than replaced: `featureFlags` is a shared bag that also holds
  // the retention settings and the cold-domain config.
  const flags =
    ws?.featureFlags && typeof ws.featureFlags === "object" && !Array.isArray(ws.featureFlags)
      ? (ws.featureFlags as Record<string, unknown>)
      : {};

  await prismaUnsafe.workspace.update({
    where: { id: workspaceId },
    data: { featureFlags: { ...flags, hiddenNav: hidden } },
  });

  const db = getWorkspaceClient(workspaceId);
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "workspace.nav_visibility",
      entityType: "Workspace",
      entityId: workspaceId,
      meta: { hidden },
    },
  });

  revalidatePath("/", "layout");
  return { ok: true, hidden };
}


// ---- switch (membership-validated, stored server-side) --------------------

/**
 * The active workspace lives on the session ROW, not in a cookie: a
 * client-writable value would be a tenancy control the client owns. Membership
 * is re-checked here and again in getActiveContext, so a stale or tampered
 * session can never read another tenant.
 */
export async function switchWorkspace(
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { userId, sessionId } = await getActiveContext();
  const member = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { id: true },
  });
  if (!member) return { ok: false, error: "You are not a member of that workspace." };
  await setSessionWorkspace(sessionId, workspaceId);
  revalidatePath("/", "layout");
  return { ok: true };
}

// ---- provisioning (Owner) -------------------------------------------------

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  legalName: z.string().trim().max(160).optional().default(""),
  brandColor: z.string().trim().max(20).optional().default(""),
  logoUrl: z.string().trim().max(500).optional().default(""),
  mailgunDomain: z.string().trim().max(160).optional().default(""),
  claudeBudget: z.coerce.number().min(0).max(1000).default(2),
  retentionDays: z.coerce.number().int().min(30).max(3650).default(365),
});

export async function createWorkspace(
  raw: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can provision a workspace." };
  }
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the workspace details and try again." };
  const input = parsed.data;
  const { userId } = await getActiveContext();

  const ws = await prismaUnsafe.workspace.create({
    data: {
      name: input.name,
      legalName: input.legalName || null,
      brand: { color: input.brandColor || null, logoUrl: input.logoUrl || null },
      mailgunConfig: input.mailgunDomain ? { domain: input.mailgunDomain } : undefined,
      claudeBudget: input.claudeBudget,
      retentionDays: input.retentionDays,
      icpConfig: DEFAULT_ICP_CONFIG,
      // The provisioning Owner is the first member (Owner) of the new workspace.
      memberships: { create: { userId, role: "OWNER", grants: OWNER_GRANTS } },
    },
  });

  /**
   * Fill it in before anybody can switch into it.
   *
   * This used to create the row and stop. The result was a workspace where the
   * Deals board had no columns, no quote could be rendered for want of a
   * template, and the dashboard measured against no targets — all of it
   * rendering as ordinary empty states, so the only available reading was that
   * switching workspaces did not work. Same scaffolding as `prisma/seed.ts`,
   * from one shared module.
   */
  await provisionWorkspace(prismaUnsafe, ws.id);

  const db = getWorkspaceClient(ws.id);
  await db.auditLog.create({
    data: { workspaceId: ws.id, actorUserId: userId, action: "workspace.create", entityType: "Workspace", entityId: ws.id, meta: { name: input.name } },
  });
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return { ok: true, id: ws.id };
}

/**
 * The workspaces this user administers, with what each actually contains.
 *
 * The counts are the point. A workspace provisioned before
 * `provisionWorkspace` existed has zero pipelines and zero templates, and
 * NOTHING in the product says so — every page renders a perfectly ordinary
 * empty state. Showing the numbers turns an invisible defect into a row with a
 * Repair button next to it.
 */
export interface WorkspaceSummary {
  id: string;
  name: string;
  legalName: string | null;
  role: string;
  active: boolean;
  members: number;
  leads: number;
  pipelines: number;
  templates: number;
  targets: number;
  /** True when the scaffolding is incomplete and Repair would do something. */
  needsProvisioning: boolean;
  createdAt: string;
}

export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const { userId, workspaceId } = await getActiveContext();
  const memberships = await prismaUnsafe.membership.findMany({
    where: { userId },
    include: {
      workspace: { select: { id: true, name: true, legalName: true, createdAt: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Counted per workspace rather than through `_count`: only `memberships` is
  // a declared relation on Workspace, so the rest have no aggregate to ask for.
  // A handful of workspaces makes this cheap, and it avoids a schema change
  // whose only purpose would be a settings screen.
  return Promise.all(
    memberships.map(async (m) => {
      const id = m.workspace.id;
      const [members, leads, pipelines, templates, targets] = await Promise.all([
        prismaUnsafe.membership.count({ where: { workspaceId: id } }),
        prismaUnsafe.lead.count({ where: { workspaceId: id } }),
        prismaUnsafe.pipeline.count({ where: { workspaceId: id } }),
        prismaUnsafe.template.count({ where: { workspaceId: id } }),
        prismaUnsafe.target.count({ where: { workspaceId: id } }),
      ]);
      return {
        id,
        name: m.workspace.name,
        legalName: m.workspace.legalName,
        role: m.role,
        active: id === workspaceId,
        members,
        leads,
        pipelines,
        templates,
        targets,
        needsProvisioning: pipelines === 0 || templates === 0 || targets === 0,
        createdAt: m.workspace.createdAt.toISOString(),
      };
    }),
  );
}

/**
 * Fill in whatever a workspace is missing, after the fact.
 *
 * For the workspaces created by the form that used to provision nothing. It is
 * the same idempotent routine a new workspace runs, so it adds only what is
 * absent and never touches a pipeline somebody has tuned.
 */
export async function repairWorkspace(
  workspaceId: string,
): Promise<{ ok: true; added: string } | { ok: false; error: string }> {
  const { userId } = await getActiveContext();
  const member = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true },
  });
  if (member?.role !== "OWNER") {
    return { ok: false, error: "Only an Owner of that workspace can repair it." };
  }

  const added = await provisionWorkspace(prismaUnsafe, workspaceId);
  const db = getWorkspaceClient(workspaceId);
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "workspace.repair",
      entityType: "Workspace",
      entityId: workspaceId,
      meta: added as unknown as object,
    },
  });
  revalidatePath("/settings/workspaces");
  revalidatePath("/", "layout");

  const parts = [
    added.pipelines ? `${added.pipelines} pipeline(s)` : null,
    added.templates ? `${added.templates} template(s)` : null,
    added.targets ? `${added.targets} target(s)` : null,
    added.icpConfig ? "the ICP config" : null,
  ].filter(Boolean);
  return {
    ok: true,
    added: parts.length ? `Added ${parts.join(", ")}.` : "Nothing was missing.",
  };
}

/** Rename a workspace. Owner of THAT workspace only. */
export async function renameWorkspace(
  workspaceId: string,
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 120) {
    return { ok: false, error: "A workspace name is between 1 and 120 characters." };
  }
  const { userId } = await getActiveContext();
  const member = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true },
  });
  if (member?.role !== "OWNER") {
    return { ok: false, error: "Only an Owner of that workspace can rename it." };
  }
  await prismaUnsafe.workspace.update({ where: { id: workspaceId }, data: { name: trimmed } });
  const db = getWorkspaceClient(workspaceId);
  await db.auditLog.create({
    data: { workspaceId, actorUserId: userId, action: "workspace.rename", entityType: "Workspace", entityId: workspaceId, meta: { name: trimmed } },
  });
  revalidatePath("/settings/workspaces");
  revalidatePath("/", "layout");
  return { ok: true };
}

// ---- member assignment (Owner) --------------------------------------------

const memberSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().max(120).optional().default(""),
  role: z.enum(["OWNER", "ADMIN", "BDR"]),
  grants: z.array(z.string()).default([]),
});

export async function addMember(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can assign members." };
  }
  const parsed = memberSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the member details." };
  const { email, name, role, grants } = parsed.data;
  const validGrants = grants.filter((g): g is Grant => (GRANTS as readonly string[]).includes(g));
  const { workspaceId, userId: actorId } = await getActiveContext();

  const user = await prismaUnsafe.user.upsert({
    where: { email },
    update: {},
    // No usable password: NO_PASSWORD cannot satisfy bcrypt, so the account
    // exists but cannot be signed into until an Owner sets one. That is the
    // intended flow — invites do not ship credentials.
    create: {
      email,
      name: name || email.split("@")[0],
      passwordHash: NO_PASSWORD,
      mustChangePassword: true,
    },
  });

  await prismaUnsafe.membership.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId } },
    update: { role: role as Role, grants: validGrants },
    create: { userId: user.id, workspaceId, role: role as Role, grants: validGrants },
  });

  const db = getWorkspaceClient(workspaceId);
  await db.auditLog.create({
    data: { workspaceId, actorUserId: actorId, action: "member.assign", entityType: "User", entityId: user.id, meta: { email, role, grants: validGrants } },
  });
  revalidatePath("/settings");
  return { ok: true };
}
