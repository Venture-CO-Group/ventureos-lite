/**
 * Calling a Server Action from a client handler, without the silence.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Next.js redacts anything thrown out of a Server Action in production. The
 * client gets a bare Error carrying only a `digest` — no message, no stack. A
 * handler written as
 *
 *     startTransition(async () => {
 *       const res = await someAction(input);
 *       if (!res.ok) setMsg(res.error);
 *     });
 *
 * therefore fails COMPLETELY SILENTLY when the action throws rather than
 * returns: the rejection has no catch, the transition ends, the button flips
 * back from "Saving…" to "Save changes", and the operator is told nothing at
 * all. That is exactly what "the save does not work" looks like from a chair —
 * and it is indistinguishable from a dead button.
 *
 * Expected outcomes are still RETURNED as data (`{ ok: false, error }`), which
 * is the rule this codebase already follows. This is the net under the
 * UNEXPECTED ones, so that a bug shows up as a message instead of as nothing.
 *
 * The digest goes into the message on purpose: it is the only handle that
 * correlates what the operator saw with the line in the server log, and it is
 * not sensitive — it is a hash, which is precisely why Next.js sends it.
 */

/** A redirect is not a failure — it is how `redirect()` signals. Never swallow it. */
function isRedirect(e: unknown): boolean {
  const digest = (e as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

/**
 * The page was loaded from an older deployment than the one now serving it.
 *
 * Every Server Action is addressed by an id the BUILD derives, and a tab opened
 * before a deploy still carries the old ids. The server answers
 * "Failed to find Server Action" and the client throws an
 * `UnrecognizedActionError` — no digest, nothing the operator can act on, and
 * in a handler without a catch, nothing at all. That was the reported "Create
 * workspace does nothing": the code was fine, the page was stale.
 *
 * The only remedy is a reload, so that is what we say.
 */
export const STALE_DEPLOYMENT_EVENT = "venture:stale-deployment";

export function isStaleDeployment(e: unknown): boolean {
  const err = e as { name?: unknown; message?: unknown } | null;
  if (!err) return false;
  if (err.name === "UnrecognizedActionError") return true;
  return typeof err.message === "string" && /Server Action .* was not found on the server/i.test(err.message);
}

export const STALE_DEPLOYMENT_MESSAGE =
  "The app was updated since this page was opened. Reload the page and try again.";

function announceStale(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(STALE_DEPLOYMENT_EVENT));
  }
}

export function serverActionError(e: unknown): string {
  if (isStaleDeployment(e)) {
    announceStale();
    return STALE_DEPLOYMENT_MESSAGE;
  }
  const digest = (e as { digest?: unknown } | null)?.digest;
  if (typeof digest === "string" && digest.length > 0) {
    return `Something went wrong on the server. Reference ${digest.slice(0, 12)} — it is in the server log.`;
  }
  // Development, or a genuine client-side failure: the real message survives.
  const message = e instanceof Error ? e.message : String(e ?? "");
  if (/fetch|network|load failed/i.test(message)) {
    return "Could not reach the server. Check the connection and try again.";
  }
  return message ? `Something went wrong: ${message}` : "Something went wrong.";
}

/**
 * Await a Server Action and turn an unexpected throw into the same
 * `{ ok: false, error }` shape every caller already handles.
 */
export async function attempt<T extends { ok: boolean }>(
  work: Promise<T>,
): Promise<T | { ok: false; error: string }> {
  try {
    return await work;
  } catch (e) {
    if (isRedirect(e)) throw e;
    return { ok: false, error: serverActionError(e) };
  }
}

/**
 * For actions that return DATA rather than a result envelope.
 *
 * `attempt` needs the action to answer `{ ok }` itself, which most of this
 * codebase does. A reader — a preview, a lookup — has nothing to say but its
 * payload, and wrapping every one of those in an envelope purely to satisfy the
 * helper is noise. This puts the envelope on the outside instead, so the caller
 * still cannot forget the failure case.
 */
export async function attemptData<T>(
  work: Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await work };
  } catch (e) {
    if (isRedirect(e)) throw e;
    return { ok: false, error: serverActionError(e) };
  }
}

/** For actions that return nothing useful; gives back the error text or null. */
export async function attemptVoid(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (e) {
    if (isRedirect(e)) throw e;
    return serverActionError(e);
  }
}
