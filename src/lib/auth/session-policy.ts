/**
 * How long a session lives. Numbers only — no store, no crypto, no Prisma.
 *
 * ── WHY THE NUMBERS ARE NOT IN sessions.ts ──────────────────────────────────
 *
 * These are policy the UI has to state out loud: the security panel prints
 * "sessions expire 30 days after sign-in, or 7 days of not being used", and it
 * should print the values the code actually enforces rather than a sentence
 * somebody will forget to update. That makes them shared between a client
 * component and the session store.
 *
 * `sessions.ts` imports `prismaUnsafe`, which imports the guarded client, which
 * imports the AsyncLocalStorage request context and so `node:async_hooks`. A
 * client component that reaches it gets a webpack build error for the `node:`
 * scheme — invisible to `tsc`, because none of the types are wrong. So the
 * constants sit here and `sessions.ts` re-exports them for its own callers.
 *
 * ── THE TWO LIMBS ───────────────────────────────────────────────────────────
 *
 * ABSOLUTE: 30 days. However active you are, a session eventually ends and you
 * sign in again — that is what bounds the damage from a token that leaked
 * months ago and was never used.
 *
 * IDLE: 7 days. A session nobody has used for a week is a laptop in a drawer or
 * a browser on a machine that changed hands, and it should not still be able to
 * read a pipeline.
 *
 * This replaces a flat 12-hour TTL. The old value was safer per-session and
 * wrong in practice: it signed people out mid-week, and the honest fix for
 * "sessions live too long" is the idle limb, not a working-day timer that
 * punishes the people using the product most.
 */
export const SESSION_ABSOLUTE_TTL_MS = 30 * 86_400_000;
export const SESSION_IDLE_TTL_MS = 7 * 86_400_000;
/** Kept as the name the rest of the code already imports. */
export const SESSION_TTL_MS = SESSION_ABSOLUTE_TTL_MS;
export const SESSION_IDLE_REFRESH_MS = 15 * 60 * 1000; // throttle lastSeenAt writes
