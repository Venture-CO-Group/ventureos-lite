import { cookies } from "next/headers";
import { tryGetActiveContextOrThrow } from "@/lib/session";
import { isOwner } from "@/lib/authz";
import { startGoogleOAuth } from "@/modules/google/oauth-flow";
import { STATE_COOKIE, STATE_TTL_MS } from "@/modules/google/oauth-state";
import { appLink } from "@/lib/public-links";

/**
 * Start the Google OAuth flow (spec §4.8; per-workspace clients, item 2).
 *
 * The client is the ACTING workspace's own if it has one, otherwise the
 * installation's. The state is signed and names that workspace and this user;
 * its nonce also goes into an httpOnly cookie, so the callback only accepts it
 * in the browser that started it.
 *
 * `?purpose=test` is the Owner's "Test connection": the same round-trip, but
 * the callback stores nothing and marks the workspace's client as tested.
 */
export async function GET(req: Request) {
  let ctx: { workspaceId: string; userId: string };
  try {
    ctx = await tryGetActiveContextOrThrow();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const purpose = new URL(req.url).searchParams.get("purpose") === "test" ? "test" : "connect";
  if (purpose === "test" && !(await isOwner())) {
    return new Response("Only an Owner can test the workspace's Google client", { status: 403 });
  }

  const started = await startGoogleOAuth({ ...ctx, purpose });
  if (!started.ok) {
    return Response.redirect(appLink(`/settings/email?google_error=not_configured`), 302);
  }
  (await cookies()).set(STATE_COOKIE, started.nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Lax, not Strict: the callback is a top-level navigation from Google.
    sameSite: "lax",
    path: "/api/google",
    maxAge: Math.floor(STATE_TTL_MS / 1000),
  });
  return Response.redirect(started.url, 302);
}
