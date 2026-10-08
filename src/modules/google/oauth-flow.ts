import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { canSignIn } from "@/modules/members/lifecycle";
import { googleConsentUrl } from "@/modules/meetings/google-oauth";
import { googleRedirectUri, resolveGoogleClient, type GoogleOAuthClient } from "./clients";
import { signState, verifyState, type OAuthPurpose, type StateRejection } from "./oauth-state";

/**
 * The Google OAuth round-trip, independent of the request (item 2).
 *
 * The two route handlers read the session and the cookie and hand them in;
 * everything that decides anything happens here, where the integration suite
 * can reach it — the same split as `googleConsentUrl`.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

export type FlowFailure =
  | { code: "not_configured" }
  | { code: "state"; reason: StateRejection }
  | { code: "wrong_user" }
  | { code: "wrong_workspace" }
  | { code: "not_member" }
  | { code: "google"; error: string; description?: string | null }
  | { code: "exchange"; error: string; description?: string | null }
  | { code: "missing_code" };

/** Start: the consent URL, and the nonce the route must put in a cookie. */
export async function startGoogleOAuth(input: {
  workspaceId: string;
  userId: string;
  purpose: OAuthPurpose;
}): Promise<{ ok: true; url: string; nonce: string; client: GoogleOAuthClient } | { ok: false; failure: FlowFailure }> {
  const client = await resolveGoogleClient(input.workspaceId);
  const redirectUri = googleRedirectUri();
  if (!client || !redirectUri) return { ok: false, failure: { code: "not_configured" } };
  const { state, nonce } = signState(input);
  return {
    ok: true,
    nonce,
    client,
    url: googleConsentUrl({ clientId: client.clientId, redirectUri, state }),
  };
}

export interface CallbackInput {
  params: URLSearchParams;
  cookieNonce: string | null;
  /** The signed-in session. Null when there is none. */
  session: { userId: string; workspaceId: string } | null;
  now?: number;
  doFetch?: typeof fetch;
}

export type CallbackResult =
  | {
      ok: true;
      purpose: OAuthPurpose;
      workspaceId: string;
      accountEmail: string | null;
      clientRef: string;
    }
  | { ok: false; failure: FlowFailure; purpose: OAuthPurpose | null; workspaceId: string | null };

/**
 * Finish: verify everything, exchange the code with the RIGHT client, store.
 *
 * The order is the point. Nothing reaches Google until the state verifies, it
 * names this user, it names the workspace they are acting in right now, and
 * they are an active member of it. Only then is the client resolved — from
 * the workspace in the verified state, never from a request parameter.
 */
export async function completeGoogleOAuth(input: CallbackInput): Promise<CallbackResult> {
  const doFetch = input.doFetch ?? fetch;
  const verdict = verifyState(input.params.get("state"), {
    cookieNonce: input.cookieNonce,
    now: input.now,
  });
  if (!verdict.ok) {
    return { ok: false, failure: { code: "state", reason: verdict.reason }, purpose: null, workspaceId: null };
  }
  const st = verdict.state;
  const fail = (failure: FlowFailure): CallbackResult => ({
    ok: false,
    failure,
    purpose: st.purpose,
    workspaceId: st.workspaceId,
  });

  if (!input.session || input.session.userId !== st.userId) return fail({ code: "wrong_user" });
  // Through the client of the workspace they are acting in — not one they
  // switched away from, and not one named by a state minted elsewhere.
  if (input.session.workspaceId !== st.workspaceId) return fail({ code: "wrong_workspace" });
  const member = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId: st.userId, workspaceId: st.workspaceId } },
    select: { state: true, workspace: { select: { deletedAt: true } } },
  });
  if (!member || !canSignIn(member.state) || member.workspace.deletedAt) {
    return fail({ code: "not_member" });
  }

  // Google's own refusal (the user cancelled, org_internal, …) arrives here.
  const googleError = input.params.get("error");
  if (googleError) {
    return fail({ code: "google", error: googleError, description: input.params.get("error_description") });
  }
  const code = input.params.get("code");
  if (!code) return fail({ code: "missing_code" });

  const client = await resolveGoogleClient(st.workspaceId);
  const redirectUri = googleRedirectUri();
  if (!client || !redirectUri) return fail({ code: "not_configured" });

  const res = await doFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    let error = `http_${res.status}`;
    let description: string | null = null;
    try {
      const body = (await res.json()) as { error?: string; error_description?: string };
      error = body.error ?? error;
      description = body.error_description ?? null;
    } catch {
      /* not JSON — keep the status */
    }
    if (st.purpose === "test") await recordTest(st.workspaceId, client, false, error);
    return fail({ code: "exchange", error, description });
  }
  const tok = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };

  let accountEmail: string | null = null;
  try {
    const who = await doFetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (who.ok) accountEmail = ((await who.json()) as { email?: string }).email ?? null;
  } catch {
    // The connection is still valid without it; the UI shows "Google account".
  }

  if (st.purpose === "test") {
    // A round-trip that proves the client works for this person. Nothing is
    // stored: the tokens are discarded, the client is marked tested.
    await recordTest(st.workspaceId, client, true, null);
    return { ok: true, purpose: "test", workspaceId: st.workspaceId, accountEmail, clientRef: client.ref };
  }

  await storeCredential({
    userId: st.userId,
    workspaceId: st.workspaceId,
    accountEmail,
    clientRef: client.ref,
    tok,
  });
  return { ok: true, purpose: "connect", workspaceId: st.workspaceId, accountEmail, clientRef: client.ref };
}

async function recordTest(
  workspaceId: string,
  client: GoogleOAuthClient,
  ok: boolean,
  error: string | null,
): Promise<void> {
  if (client.source !== "workspace") return;
  await getWorkspaceClient(workspaceId).workspaceGoogleClient.updateMany({
    where: { workspaceId },
    data: { status: ok ? "ok" : "error", lastTestedAt: new Date(), lastError: error },
  });
}

async function storeCredential(input: {
  userId: string;
  workspaceId: string;
  accountEmail: string | null;
  clientRef: string;
  tok: { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
}): Promise<void> {
  const { userId, accountEmail, tok } = input;
  const expiryDate = new Date(Date.now() + tok.expires_in * 1000);

  // First account → meetings are written here; later ones only block busy
  // time. A reconnect of the same account keeps its existing role.
  const existing = await prismaUnsafe.googleCredential.count({ where: { userId, invalidatedAt: null } });
  const purpose = existing === 0 ? "WRITE" : "BUSY_ONLY";

  const prior = await prismaUnsafe.googleCredential.findFirst({
    where: { userId, accountEmail },
    select: { id: true, clientRef: true },
  });
  let credentialId: string;
  if (prior) {
    // A reconnect through a DIFFERENT client must not keep the old refresh
    // token: it belongs to the old client and could never be refreshed.
    const sameClient = (prior.clientRef ?? "env") === input.clientRef;
    await prismaUnsafe.googleCredential.update({
      where: { id: prior.id },
      data: {
        accessToken: tok.access_token,
        ...(tok.refresh_token
          ? { refreshToken: tok.refresh_token }
          : sameClient
            ? {}
            : { refreshToken: null }),
        expiryDate,
        scope: tok.scope ?? null,
        clientRef: input.clientRef,
        invalidatedAt: null,
      },
    });
    credentialId = prior.id;
  } else {
    const row = await prismaUnsafe.googleCredential.create({
      data: {
        userId,
        accountEmail,
        purpose,
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token ?? null,
        expiryDate,
        scope: tok.scope ?? null,
        clientRef: input.clientRef,
      },
      select: { id: true },
    });
    credentialId = row.id;
  }

  // Mail sync rides on the same consent. Only when the grant actually
  // includes the Gmail scope — a user who unticked it connected a calendar,
  // not a mailbox.
  if (accountEmail && (tok.scope ?? "").includes("gmail.readonly")) {
    await prismaUnsafe.mailAccount.upsert({
      where: { userId_accountEmail: { userId, accountEmail } },
      create: {
        workspaceId: input.workspaceId,
        userId,
        accountEmail,
        credentialId,
        provider: "gmail",
        health: "ok",
      },
      update: { credentialId, health: "ok", lastError: null, enabled: true },
    });
  }
}
