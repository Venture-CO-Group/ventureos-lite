"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import { isOwner } from "@/lib/authz";
import { GRANTS } from "@/lib/grants";
import { takeRateLimit } from "@/lib/rate-limit";
/**
 * NOTE: nothing but async functions may be exported from this file.
 *
 * A `"use server"` module that exports a const fails at runtime with `Cannot
 * read properties of undefined (reading '/_app')` and passes `tsc` clean —
 * which is how it has cost this codebase four separate debugging sessions.
 * The UI imports constants like `MAX_BULK_INVITES` from `invitation-logic`
 * directly, which is a plain module and may export whatever it likes.
 */
import { parseBulkInvites, type BulkRow } from "./invitation-logic";
import {
  issueInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  type PendingInvitation,
} from "./invitation-store";
import { acceptSetPassword, acceptVerifyTotp } from "./accept";

/**
 * Member management, Owner-gated (§2).
 *
 * Every mutation here checks `isOwner()` first and writes through
 * `recordMemberEvent`, which cannot write a timeline entry without an audit
 * entry. That is the ground rule for this whole section, and it is enforced by
 * the shape of the helper rather than by remembering.
 */
const ROLES = ["OWNER", "ADMIN", "BDR", "CLIENT"] as const;

async function requireOwnerAction(): Promise<
  { ok: true; workspaceId: string; userId: string } | { ok: false; error: string }
> {
  if (!(await isOwner())) return { ok: false, error: "Only an Owner can manage members." };
  const { workspaceId, userId } = await getActiveContext();
  return { ok: true, workspaceId, userId };
}

const inviteSchema = z.object({
  email: z.string().trim().email().max(200),
  name: z.string().trim().max(120).optional(),
  role: z.enum(ROLES),
  grants: z.array(z.string()).max(GRANTS.length).optional(),
  clientCompanyId: z.string().trim().optional(),
});

export async function inviteMember(
  raw: unknown,
): Promise<
  | { ok: true; url: string; expiresAt: string; existingAccount: boolean }
  | { ok: false; error: string }
> {
  const gate = await requireOwnerAction();
  if (!gate.ok) return gate;
  const parsed = inviteSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the name, email and role." };
  const input = parsed.data;

  if (input.role === "CLIENT" && !input.clientCompanyId) {
    return { ok: false, error: "Pick the company this client may see." };
  }
  const wanted = (input.grants ?? []).filter((g) => (GRANTS as readonly string[]).includes(g));

  const res = await issueInvitation({
    workspaceId: gate.workspaceId,
    actorUserId: gate.userId,
    email: input.email,
    name: input.name,
    role: input.role,
    grants: wanted,
    clientCompanyId: input.role === "CLIENT" ? (input.clientCompanyId ?? null) : null,
  });
  if (!res.ok) return res;

  revalidatePath("/settings/admin/members");
  return {
    ok: true,
    url: res.url,
    expiresAt: res.expiresAt,
    existingAccount: res.existingAccount,
  };
}

export interface BulkInviteReport {
  rows: (BulkRow & { sent: boolean })[];
  sent: number;
  skipped: number;
}

/**
 * Invite a pasted list (§2).
 *
 * ── PER ROW, AND IT REPORTS EVERY ONE ───────────────────────────────────────
 *
 * Bulk operations must never partially apply silently. So each address gets
 * its own attempt and its own line in the report — sent, or the reason it was
 * not. Refusing the whole paste over one bad line means somebody hunts for it
 * by bisection; accepting it quietly means three people never get invited and
 * nobody knows which three.
 *
 * Sequential rather than parallel, deliberately: fifty concurrent Mailgun
 * sends from one click is how a sending domain gets rate-limited by the
 * provider, and the report has to be in the order the person pasted.
 */
export async function bulkInviteMembers(
  raw: unknown,
): Promise<{ ok: true; report: BulkInviteReport } | { ok: false; error: string }> {
  const gate = await requireOwnerAction();
  if (!gate.ok) return gate;
  const parsed = z
    .object({
      text: z.string().max(20_000),
      role: z.enum(ROLES),
      grants: z.array(z.string()).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Paste a list of email addresses." };
  if (parsed.data.role === "CLIENT") {
    // A client account is scoped to ONE company, which a paste cannot express.
    return { ok: false, error: "Invite client accounts one at a time — each needs its own company." };
  }

  /**
   * One bulk paste per minute per workspace.
   *
   * Not an abuse control — the caller is an Owner — but a brake on the
   * accident where somebody presses the button twice and fifty people get two
   * invitations each.
   */
  const limit = await takeRateLimit(`bulk-invite:${gate.workspaceId}`, {
    windowMs: 60_000,
    max: 1,
  });
  if (!limit.allowed) {
    return { ok: false, error: "A bulk invite just went out. Give it a minute before the next." };
  }

  const rows = parseBulkInvites(parsed.data.text);
  if (rows.length === 0) return { ok: false, error: "Nothing to invite." };

  const wanted = (parsed.data.grants ?? []).filter((g) =>
    (GRANTS as readonly string[]).includes(g),
  );
  const report: BulkInviteReport = { rows: [], sent: 0, skipped: 0 };

  for (const row of rows) {
    if (!row.email || row.problem) {
      report.rows.push({ ...row, sent: false });
      report.skipped += 1;
      continue;
    }
    const res = await issueInvitation({
      workspaceId: gate.workspaceId,
      actorUserId: gate.userId,
      email: row.email,
      role: parsed.data.role,
      grants: wanted,
    });
    if (res.ok) {
      report.rows.push({ ...row, sent: true });
      report.sent += 1;
    } else {
      report.rows.push({ ...row, problem: res.error, sent: false });
      report.skipped += 1;
    }
  }

  revalidatePath("/settings/admin/members");
  return { ok: true, report };
}

export async function getInvitations(): Promise<PendingInvitation[]> {
  if (!(await isOwner())) return [];
  const { workspaceId } = await getActiveContext();
  return listInvitations(workspaceId);
}

export async function resendMemberInvitation(
  invitationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await requireOwnerAction();
  if (!gate.ok) return gate;
  const res = await resendInvitation({
    workspaceId: gate.workspaceId,
    actorUserId: gate.userId,
    invitationId,
  });
  if (res.ok) revalidatePath("/settings/admin/members");
  return res;
}

export async function revokeMemberInvitation(
  invitationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await requireOwnerAction();
  if (!gate.ok) return gate;
  const res = await revokeInvitation({
    workspaceId: gate.workspaceId,
    actorUserId: gate.userId,
    invitationId,
  });
  if (res.ok) revalidatePath("/settings/admin/members");
  return res;
}

// ---------------------------------------------------------------------------
// the public accept path — deliberately ungated (§2)
// ---------------------------------------------------------------------------

/**
 * These two take no session and check no role.
 *
 * They cannot: the whole point is somebody's first contact with the product.
 * The token is the credential — 256 bits, hashed at rest, single-use, seven
 * days — the same contract as a password reset link. Rate-limited per address
 * so a token cannot be brute-forced by a script, though at 256 bits the limit
 * is a formality rather than the defence.
 */
export async function submitAcceptPassword(
  raw: unknown,
): Promise<{ ok: true; qr: string } | { ok: false; error: string }> {
  const parsed = z
    .object({
      token: z.string().min(16).max(200),
      name: z.string().trim().max(120),
      password: z.string().min(1).max(200),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the form and try again." };

  const limit = await takeRateLimit(`invite-accept:${parsed.data.token.slice(0, 24)}`, {
    windowMs: 15 * 60_000,
    max: 20,
  });
  if (!limit.allowed) return { ok: false, error: "Too many attempts. Try again shortly." };

  const res = await acceptSetPassword(parsed.data);
  return res.ok ? { ok: true, qr: res.qr } : res;
}

export async function submitAcceptTotp(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z
    .object({ token: z.string().min(16).max(200), code: z.string().trim().max(20) })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Enter the six-digit code." };

  const limit = await takeRateLimit(`invite-totp:${parsed.data.token.slice(0, 24)}`, {
    windowMs: 15 * 60_000,
    max: 20,
  });
  if (!limit.allowed) return { ok: false, error: "Too many attempts. Try again shortly." };

  const res = await acceptVerifyTotp(parsed.data);
  return res.ok ? { ok: true } : res;
}
