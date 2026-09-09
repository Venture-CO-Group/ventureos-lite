/**
 * The shapes and the one threshold the access review is built on (§7).
 *
 * ── WHY THIS IS A FILE OF ITS OWN ───────────────────────────────────────────
 *
 * The panel needs two things from the review: the row shape, and the number of
 * days that makes an account dormant — it prints "no sign-in for 60 days" so
 * the threshold is visible rather than folded into the query. Both are inert.
 *
 * `access-review.ts` runs the queries, so it imports the guarded Prisma client,
 * which imports the AsyncLocalStorage request context, which imports
 * `node:async_hooks`. A client component that reaches any of that drags the
 * whole chain into the browser bundle, and webpack refuses the `node:` scheme
 * with a build error — one that `tsc` cannot see, because the types are
 * perfectly valid. Constants and types live here; queries live there.
 *
 * The same split, for the same reason, as `invitation-logic.ts` beside
 * `invitation-store.ts`.
 */
export const DORMANT_DAYS = 60;

export interface ReviewRow {
  userId: string;
  name: string;
  email: string;
  role: string;
  state: string;
  detail: string;
}

export interface AccessReview {
  dormant: ReviewRow[];
  documentHolders: ReviewRow[];
  staleInvitations: { id: string; email: string; role: string; detail: string }[];
  /** So the panel can say "nothing to review" rather than showing three empty boxes. */
  clean: boolean;
}
