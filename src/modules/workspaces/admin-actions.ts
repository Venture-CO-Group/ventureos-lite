"use server";

/**
 * Server actions for administering ANY of an Owner's workspaces (members,
 * details, deletion) from the workspaces page, without switching into it.
 *
 * NOTE: nothing but async functions may be exported from a "use server" file.
 *
 * Each action reads exactly one thing from the request — who the actor is,
 * from the session — and hands it to ./admin.ts, where every rule lives and is
 * tested. The workspace id comes from the caller; the actor id never does.
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import { issueInvitation } from "@/modules/members/invitation-store";
import {
  assignExistingUser,
  assignableUsersFor,
  detailsOf,
  isLiveOwner,
  membersOf,
  restorableFor,
  restoreWorkspace,
  softDeleteWorkspace,
  updateDetails,
  type AssignableUser,
  type DeletedWorkspace,
  type WorkspaceDetails,
  type WorkspaceMemberRow,
} from "./admin";

type Fail = { ok: false; error: string };

const idSchema = z.string().trim().min(1).max(64);

export async function getWorkspaceAdmin(
  workspaceId: string,
): Promise<
  | {
      ok: true;
      details: WorkspaceDetails;
      members: WorkspaceMemberRow[];
      assignable: AssignableUser[];
    }
  | Fail
> {
  const id = idSchema.safeParse(workspaceId);
  if (!id.success) return { ok: false, error: "Unknown workspace." };
  const { userId } = await getActiveContext();
  if (!(await isLiveOwner(userId, id.data))) {
    return { ok: false, error: "Only an Owner of that workspace can manage it." };
  }
  const [details, members, assignable] = await Promise.all([
    detailsOf(id.data),
    membersOf(id.data),
    assignableUsersFor(userId, id.data),
  ]);
  if (!details) return { ok: false, error: "That workspace no longer exists." };
  return { ok: true, details, members, assignable };
}

const assignSchema = z.object({
  workspaceId: idSchema,
  userId: idSchema,
  role: z.enum(["OWNER", "ADMIN", "BDR"]),
  grants: z.array(z.string()).max(50).default([]),
});

export async function addExistingMember(raw: unknown): Promise<{ ok: true } | Fail> {
  const parsed = assignSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Pick a person and a role." };
  const { userId: actorId } = await getActiveContext();
  const res = await assignExistingUser({ actorId, ...parsed.data });
  if (res.ok) {
    revalidatePath("/settings/workspaces");
    revalidatePath("/settings/admin/members");
  }
  return res;
}

const inviteSchema = z.object({
  workspaceId: idSchema,
  email: z.string().trim().email().max(200),
  name: z.string().trim().max(120).optional(),
  role: z.enum(["OWNER", "ADMIN", "BDR"]),
  grants: z.array(z.string()).max(50).default([]),
});

/**
 * Invite somebody into a CHOSEN workspace — the same invitation flow the
 * members page uses, addressed by id rather than by whichever workspace
 * happens to be active.
 */
export async function inviteToWorkspace(
  raw: unknown,
): Promise<
  | { ok: true; url: string; existingAccount: boolean; emailError?: string }
  | Fail
> {
  const parsed = inviteSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the email and role." };
  const { userId: actorId } = await getActiveContext();
  if (!(await isLiveOwner(actorId, parsed.data.workspaceId))) {
    return { ok: false, error: "Only an Owner of that workspace can invite people to it." };
  }
  const res = await issueInvitation({
    workspaceId: parsed.data.workspaceId,
    actorUserId: actorId,
    email: parsed.data.email,
    name: parsed.data.name,
    role: parsed.data.role,
    grants: parsed.data.grants,
  });
  if (!res.ok) return res;
  revalidatePath("/settings/workspaces");
  return {
    ok: true,
    url: res.url,
    existingAccount: res.existingAccount,
    ...(res.emailError ? { emailError: res.emailError } : {}),
  };
}

const detailsSchema = z.object({
  workspaceId: idSchema,
  name: z.string().trim().min(1).max(120),
  legalName: z.string().trim().max(160).default(""),
  brandColor: z
    .string()
    .trim()
    .max(20)
    .refine((v) => v === "" || /^#[0-9a-fA-F]{6}$/.test(v), "A colour like #7427C6")
    .default(""),
  logoUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || v.startsWith("/") || /^https:\/\//.test(v), "An https:// URL")
    .default(""),
  mailgunDomain: z
    .string()
    .trim()
    .max(160)
    .refine((v) => v === "" || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v), "A domain like mg.example.com")
    .default(""),
  claudeBudget: z.coerce.number().min(0).max(1000),
  retentionDays: z.coerce.number().int().min(30).max(3650),
});

export async function saveWorkspaceDetails(raw: unknown): Promise<{ ok: true } | Fail> {
  const parsed = detailsSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first ? `${first.path.join(".")}: ${first.message}` : "Check the workspace details.",
    };
  }
  const { userId: actorId } = await getActiveContext();
  const res = await updateDetails({ actorId, ...parsed.data });
  if (res.ok) {
    revalidatePath("/settings/workspaces");
    revalidatePath("/", "layout");
  }
  return res;
}

export async function deleteWorkspace(
  raw: unknown,
): Promise<{ ok: true; purgeAfter: string } | Fail> {
  const parsed = z
    .object({ workspaceId: idSchema, confirmName: z.string().max(200) })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Type the workspace name to confirm." };
  const { userId: actorId } = await getActiveContext();
  const res = await softDeleteWorkspace({ actorId, ...parsed.data });
  if (res.ok) {
    // If it was the active one, the next request's session lookup moves them
    // to another workspace on its own (it ignores deleted workspaces).
    revalidatePath("/", "layout");
  }
  return res;
}

export async function getRestorableWorkspaces(): Promise<DeletedWorkspace[]> {
  const { userId } = await getActiveContext();
  return restorableFor(userId);
}

export async function undeleteWorkspace(workspaceId: string): Promise<{ ok: true } | Fail> {
  const id = idSchema.safeParse(workspaceId);
  if (!id.success) return { ok: false, error: "Unknown workspace." };
  const { userId: actorId } = await getActiveContext();
  const res = await restoreWorkspace({ actorId, workspaceId: id.data });
  if (res.ok) revalidatePath("/", "layout");
  return res;
}
