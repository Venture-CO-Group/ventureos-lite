import { prismaUnsafe } from "./db";
import { tryGetActiveContext } from "./session";
import { GrantError, grantAllowed } from "./grants";
import { canSignIn } from "@/modules/members/lifecycle";

// Re-exported so existing callers keep importing them from here.
export { GrantError, grantAllowed };

/**
 * Grant checks (CLAUDE.md hard rule #7): documents.* / templates.* capabilities
 * are per user per workspace, default Owner-only. Checked server-side on every
 * mutation. Owner/Admin roles carry all grants implicitly.
 *
 * Deliberately uses the NON-redirecting context. Authorization answers a
 * question ("may this user do X?") and its callers wrap it in try/catch to turn
 * a denial into a friendly message. If this path redirected, `redirect()`'s
 * NEXT_REDIRECT signal would be swallowed by those catch blocks. No session
 * simply means no membership, which means no grant — a safe denial. Pages use
 * `getActiveContext()`, which redirects to /login.
 */
async function membershipOf() {
  const ctx = await tryGetActiveContext();
  if (!ctx) return null;
  const membership = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId: ctx.userId, workspaceId: ctx.workspaceId } },
    select: { role: true, grants: true, state: true },
  });
  // Belt and braces. `tryGetActiveContext` already refuses to resolve a
  // membership that may not sign in, so this should be unreachable — but
  // authorization is the wrong place to rely on somebody else having checked.
  if (!membership || !canSignIn(membership.state)) return null;
  return membership;
}

export async function hasGrant(grant: string): Promise<boolean> {
  const membership = await membershipOf();
  if (!membership) return false;
  const grants = Array.isArray(membership.grants) ? (membership.grants as string[]) : [];
  return grantAllowed(membership.role, grants, grant);
}

export async function requireGrant(grant: string): Promise<void> {
  if (!(await hasGrant(grant))) throw new GrantError(grant);
}

export async function isOwner(): Promise<boolean> {
  const membership = await membershipOf();
  return membership?.role === "OWNER";
}

export async function requireOwner(): Promise<void> {
  if (!(await isOwner())) throw new GrantError("owner");
}

/**
 * The platform operator.
 *
 * ── WHY THIS IS NOT A ROLE ─────────────────────────────────────────────────
 *
 * `Role` lives on the membership and answers "what may this person do inside
 * this workspace". This answers "who administers this installation" — a
 * different question, with a different scope, and one that must not be
 * answerable by anybody inside a workspace. If it were a role, an Owner (who
 * can already edit memberships) could grant it to themselves.
 *
 * So it is a column on the user that no UI writes. It is set on the server with
 * `scripts/set-super-admin.ts`, by whoever has the shell — which on a
 * self-hosted deployment is the operator, and that is the whole point.
 */
export async function isSuperAdmin(): Promise<boolean> {
  const ctx = await tryGetActiveContext();
  if (!ctx) return false;
  const user = await prismaUnsafe.user.findUnique({
    where: { id: ctx.userId },
    select: { isSuperAdmin: true },
  });
  return user?.isSuperAdmin === true;
}

export async function requireSuperAdmin(): Promise<void> {
  if (!(await isSuperAdmin())) throw new GrantError("super_admin");
}
