/**
 * What a task attachment may be, and how big.
 *
 * ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────
 *
 * A `"use server"` file may only export ASYNC FUNCTIONS. These constants lived
 * in `board-actions.ts` for about ten minutes, which was long enough to take
 * the whole dev server down with `Cannot read properties of undefined (reading
 * '/_app')` — a message that says nothing about the actual cause. TypeScript
 * does not catch it; only Next's compiler does, and only at runtime.
 *
 * The same mistake was made and fixed once already this session, in
 * `users/actions.ts`. Twice is a pattern, so the rule is now written down where
 * the next person adding a constant will read it: if it is not an async
 * function, it does not belong in a "use server" file.
 */

/** What one task may carry. A board is not a file server. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TASK = 20;

/**
 * An allowlist rather than a blocklist.
 *
 * These files are served back through `/api/files` — from OUR origin. Anything
 * executable or scriptable would therefore be a stored file this product hands
 * a browser under its own domain, and a blocklist is only ever a list of the
 * extensions somebody happened to think of.
 *
 * SVG is deliberately NOT on it. An SVG can carry script, and "designers send
 * logos as SVGs" is a weak reason to accept an executable document when a PNG
 * does the job. The file route also serves everything under `tasks/` with
 * `Content-Disposition: attachment` so the browser saves rather than renders —
 * belt and braces, because either alone is one mistake away from an uploaded
 * file running on our own domain.
 */
export const ALLOWED_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/csv",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

/**
 * How many rows "My work" shows (P6/3.4).
 *
 * Lives here rather than beside the query, because that file is `"use server"`
 * and may only export async functions — the trap this module exists for.
 *
 * Two hundred is a cap on a list a person reads in the morning, not a
 * pagination scheme. If somebody has two hundred open tasks assigned to them,
 * the number is the finding.
 */
export const MY_WORK_LIMIT = 200;
