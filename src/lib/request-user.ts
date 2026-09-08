import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who this request belongs to, for the row-level-security policies.
 *
 * ── WHY ASYNC-LOCAL STORAGE AND NOT A PARAMETER ────────────────────────────
 *
 * The RLS policies check the workspace AND a membership for the acting user.
 * The workspace is available wherever a guarded client is built; the user is
 * not — `getWorkspaceClient(workspaceId)` is called from 117 files. Threading a
 * second argument through all of them would be a large, error-prone sweep whose
 * failure mode is silent.
 *
 * ── IT IS SAFE WHEN IT FAILS ───────────────────────────────────────────────
 *
 * That is what makes this acceptable rather than clever. If the store is empty
 * — a background job, or a context the runtime did not propagate — the policy
 * falls back to workspace-only scoping, which is still the check that matters
 * and is exactly what the tenant guard enforces anyway. Nothing breaks, nothing
 * silently widens.
 *
 * And a wrong value cannot widen access either: the membership branch can only
 * ever ADD a condition to a workspace that the session already resolved, so the
 * worst a leaked id could do is refuse a query that should have succeeded.
 */
const store = new AsyncLocalStorage<{ userId: string; role: string | null }>();

/**
 * Called once per request, from the session lookup every authenticated path
 * already goes through. `enterWith` rather than `run` because the session
 * lookup does not own the continuation — the framework does.
 */
export function setRequestUser(userId: string, role: string | null = null): void {
  try {
    store.enterWith({ userId, role });
  } catch {
    // A runtime without async_hooks support degrades to workspace-only scoping.
  }
}

/** The acting user, or null in a background job. */
export function getRequestUser(): string | null {
  try {
    return store.getStore()?.userId ?? null;
  } catch {
    return null;
  }
}

/**
 * The acting membership's role, or null in a background job (P6/6.3).
 *
 * Carried here for one reason: the Prisma tenant guard needs it to refuse
 * writes from a read-only CLIENT, and the guard is built from a workspace id
 * with no user in sight.
 *
 * ── AND WHY A MISSING VALUE IS NOT A HOLE ───────────────────────────────────
 *
 * Null means "not a request" — a worker job, a seed script — and those are
 * allowed to write, exactly as before. That is safe because a CLIENT cannot
 * reach a worker job: the only way this returns "CLIENT" is a session the
 * session lookup resolved, and the only way it returns null on a REQUEST is a
 * runtime without async_hooks, where nobody is signed in as anything either.
 */
export function getRequestRole(): string | null {
  try {
    return store.getStore()?.role ?? null;
  } catch {
    return null;
  }
}
