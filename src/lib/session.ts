import { redirect, unstable_rethrow } from "next/navigation";
import { currentSessionToken } from "./auth";
import { resolveSession, setSessionWorkspace } from "./auth/sessions";
import { prismaUnsafe } from "./db";
import { setRequestUser } from "./request-user";
import { canSignIn } from "@/modules/members/lifecycle";

export interface ActiveContext {
  workspaceId: string;
  userId: string;
  sessionId: string;
  /** The acting membership's role in `workspaceId` (P6/6.3). */
  role: string;
}

/**
 * Active session context (spec §7).
 *
 * Identity comes from the `sessions` table via the opaque token in the Auth.js
 * cookie — never from a client-writable value. There is NO fallback: an
 * unauthenticated request is redirected to /login. (This replaced a pre-auth
 * stand-in that read the user id straight from a `vos_user` cookie, which meant
 * anyone who could reach the app was the Owner. Do not reintroduce a fallback
 * here; background jobs pass their workspace id explicitly instead.)
 *
 * TENANCY INVARIANT: the returned workspace is ALWAYS one the user is a member
 * of, and is not suspended. A session pointing at a workspace the user no
 * longer belongs to — or has been stood down from — is ignored and repaired to
 * one of their own live memberships; a workspace switch can never cross into
 * another tenant. Enforced here, on top of the Prisma guard and RLS.
 */
export async function tryGetActiveContext(): Promise<ActiveContext | null> {
  const token = await currentSessionToken();
  const session = await resolveSession(token);
  if (!session) return null;

  /**
   * Only a membership that may sign in is a membership.
   *
   * Enforced HERE rather than only at sign-in, because a suspension has to bite
   * a session that already exists — somebody stood down at 14:00 with a browser
   * open must not keep reading the workspace until their token expires. Every
   * authenticated path in the product passes through this function, so this is
   * the one place that makes it true everywhere.
   *
   * ── WHY THE STATE AND NOT `suspendedAt: null` ─────────────────────────────
   *
   * That condition was right while membership was binary and became incomplete
   * the moment INVITED and REMOVED existed (§1): both have a null
   * `suspendedAt`, and both would have resolved a session. An invitation is
   * not access, and a membership that ended is not access — the row survives
   * only so that "created by" and the timeline stay readable.
   *
   * A user with no signable membership anywhere resolves to no context at all,
   * which the caller turns into a redirect to /login.
   */
  const memberships = (
    await prismaUnsafe.membership.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: "asc" },
      select: { workspaceId: true, role: true, state: true },
    })
  ).filter((m) => canSignIn(m.state));
  if (memberships.length === 0) return null;

  const memberWsIds = new Map(memberships.map((m) => [m.workspaceId, m.role as string]));
  const stored = session.workspaceId;

  /**
   * Which membership is acting, resolved BEFORE anything is published.
   *
   * The role has to travel with the user id (P6/6.3): the Prisma tenant guard
   * refuses writes from a read-only CLIENT and has no other way to learn who is
   * asking. Publishing the user without the role would leave a window in which
   * a CLIENT's request looked like a background job — which is allowed to
   * write.
   */
  const workspaceId = stored && memberWsIds.has(stored) ? stored : memberships[0].workspaceId;
  const role = memberWsIds.get(workspaceId) ?? "BDR";

  // Hand the acting user to the row-level-security policies (src/lib/rls.ts).
  // Set here because this is the one place every authenticated path passes
  // through, and because an unset value degrades safely to workspace-only.
  setRequestUser(session.userId, role);

  if (workspaceId === stored) {
    return { workspaceId, userId: session.userId, sessionId: session.sessionId, role };
  }

  // Session points nowhere valid (revoked membership, deleted workspace, or a
  // brand-new session): fall back to their own first workspace and repair it.
  await setSessionWorkspace(session.sessionId, workspaceId).catch(() => {
    /* repair is best-effort; the returned context is already safe */
  });
  return { workspaceId, userId: session.userId, sessionId: session.sessionId, role };
}

/**
 * The context every page and server action uses. Redirects to /login when
 * there is no live session.
 *
 * Redirecting here rather than throwing matters: middleware can only see that a
 * cookie EXISTS (it runs on the edge, with no database), so a revoked or
 * expired session still reaches the page. Without this, that combination
 * rendered a 500 instead of a login form.
 *
 * `redirect()` signals by throwing a NEXT_REDIRECT error. Callers that wrap
 * this in try/catch must `unstable_rethrow(e)` first — see `src/lib/authz.ts`.
 */
export async function getActiveContext(): Promise<ActiveContext> {
  const ctx = await tryGetActiveContext();
  if (!ctx) redirect("/login");
  return ctx;
}

/** Thrown by `tryGetActiveContextOrThrow` when there is no live session. */
export class UnauthenticatedError extends Error {
  constructor(message = "Not signed in.") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

/**
 * For route handlers, which must answer with a status code rather than a
 * redirect — a `fetch()` or an <img> cannot do anything useful with a login
 * page, and following the redirect would hand the caller HTML where it expected
 * a file. Callers catch this and return 401.
 */
export async function tryGetActiveContextOrThrow(): Promise<ActiveContext> {
  const ctx = await tryGetActiveContext();
  if (!ctx) throw new UnauthenticatedError();
  return ctx;
}

/** Re-export so callers do not need to reach into next/navigation themselves. */
export { unstable_rethrow };
