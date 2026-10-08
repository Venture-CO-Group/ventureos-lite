import { cookies } from "next/headers";
import { appLink } from "@/lib/public-links";
import { tryGetActiveContext } from "@/lib/session";
import { completeGoogleOAuth } from "@/modules/google/oauth-flow";
import { STATE_COOKIE } from "@/modules/google/oauth-state";
import { failureCode } from "@/modules/google/errors";

/**
 * Google OAuth callback (spec §4.8; per-workspace clients, item 2).
 *
 * One redirect URI for every client. Which client exchanges the code is
 * decided by the workspace inside the SIGNED state — see
 * modules/google/oauth-flow.ts for the checks, in order. Tokens are stored
 * server-side only and never reach the browser.
 *
 * Never shows a raw Google error: every failure becomes a code the settings
 * and meetings screens turn into a sentence (modules/google/errors.ts).
 */
export async function GET(req: Request) {
  const jar = await cookies();
  const cookieNonce = jar.get(STATE_COOKIE)?.value ?? null;
  // Single use, whatever happens next.
  jar.delete({ name: STATE_COOKIE, path: "/api/google" });

  const ctx = await tryGetActiveContext();
  const result = await completeGoogleOAuth({
    params: new URL(req.url).searchParams,
    cookieNonce,
    session: ctx ? { userId: ctx.userId, workspaceId: ctx.workspaceId } : null,
  });

  if (result.ok) {
    return Response.redirect(
      appLink(result.purpose === "test" ? "/settings/email?google_test=ok" : "/meetings?google=connected"),
      302,
    );
  }
  const code = failureCode(result.failure);
  const target =
    result.purpose === "test"
      ? `/settings/email?google_test=${encodeURIComponent(code)}`
      : `/settings/email?google_error=${encodeURIComponent(code)}`;
  return Response.redirect(appLink(target), 302);
}
