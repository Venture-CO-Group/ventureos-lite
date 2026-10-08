import { getWorkspaceClient } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";

/**
 * Which Google OAuth client a Google operation uses.
 *
 * ── WHY MORE THAN ONE ──────────────────────────────────────────────────────
 *
 * The installation's own client (GOOGLE_CLIENT_ID/SECRET) is an INTERNAL app
 * in the Venture Google Workspace. Google admits only that organisation's
 * accounts to it and answers everybody else with `Error 403: org_internal`.
 * Publishing it instead would put the Gmail scopes through Google's
 * verification and security assessment. So a workspace whose company has its
 * own Google Workspace brings its own Internal client, created there, and its
 * people connect through that.
 *
 * ── THE TWO RULES ──────────────────────────────────────────────────────────
 *
 * 1. Resolution: the acting workspace's own client if it has one, otherwise
 *    the env client — so a workspace that configures nothing behaves exactly
 *    as before.
 * 2. Refresh: by the `clientRef` stored on the credential, never by "whatever
 *    the workspace uses now". A refresh token is bound to the client that
 *    issued it; Google refuses it from any other.
 */

export const ENV_CLIENT_REF = "env";

export interface GoogleOAuthClient {
  /** Stored on every credential this client issues. */
  ref: string;
  clientId: string;
  clientSecret: string;
  /** Whose client it is — the installation's, or one workspace's. */
  source: "env" | "workspace";
  workspaceId: string | null;
}

/** Raised when a credential's issuing client no longer exists or cannot be read. */
export class GoogleClientUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleClientUnavailableError";
    Object.setPrototypeOf(this, GoogleClientUnavailableError.prototype);
  }
}

export function workspaceClientRef(workspaceId: string, rowId: string): string {
  return `ws:${workspaceId}:${rowId}`;
}

/** `ws:<workspaceId>:<rowId>` → its parts; anything else → null. */
export function parseClientRef(ref: string | null | undefined): { workspaceId: string; rowId: string } | null {
  if (!ref || !ref.startsWith("ws:")) return null;
  const [, workspaceId, rowId] = ref.split(":");
  return workspaceId && rowId ? { workspaceId, rowId } : null;
}

export function envGoogleClient(): GoogleOAuthClient | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { ref: ENV_CLIENT_REF, clientId, clientSecret, source: "env", workspaceId: null };
}

/** The single redirect URI, on our own domain, shared by every client. */
export function googleRedirectUri(): string | null {
  return process.env.GOOGLE_REDIRECT_URI?.trim() || null;
}

/** The workspace's own client row, through the tenant-guarded client. */
async function workspaceRow(workspaceId: string) {
  return getWorkspaceClient(workspaceId).workspaceGoogleClient.findFirst({
    where: { workspaceId },
  });
}

/**
 * The client a NEW connection in this workspace goes through.
 * Null when neither the workspace nor the installation has one.
 */
export async function resolveGoogleClient(workspaceId: string): Promise<GoogleOAuthClient | null> {
  const row = await workspaceRow(workspaceId);
  if (row) {
    return {
      ref: workspaceClientRef(workspaceId, row.id),
      clientId: row.clientId,
      clientSecret: decryptSecret(row.clientSecretEnc),
      source: "workspace",
      workspaceId,
    };
  }
  return envGoogleClient();
}

/**
 * The client that issued a stored credential — for refreshing it.
 *
 * Throws rather than falling back: refreshing with a different client cannot
 * work, and silently trying the env client would turn "this client was
 * replaced" into an opaque `invalid_grant` from Google.
 */
export async function googleClientForRef(ref: string | null | undefined): Promise<GoogleOAuthClient> {
  if (!ref || ref === ENV_CLIENT_REF) {
    const env = envGoogleClient();
    if (!env) throw new GoogleClientUnavailableError("google_client_not_configured");
    return env;
  }
  const parsed = parseClientRef(ref);
  if (!parsed) throw new GoogleClientUnavailableError(`google_client_ref_invalid: ${ref}`);
  const row = await workspaceRow(parsed.workspaceId);
  if (!row || row.id !== parsed.rowId) {
    // Replaced or deleted: the tokens it issued are dead.
    throw new GoogleClientUnavailableError("google_client_replaced");
  }
  return {
    ref,
    clientId: row.clientId,
    clientSecret: decryptSecret(row.clientSecretEnc),
    source: "workspace",
    workspaceId: parsed.workspaceId,
  };
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Refresh an access token with the client that issued it. The one refresh
 * implementation — Calendar and Gmail both call it, so neither can drift back
 * to reading the env client directly.
 */
export async function refreshGoogleAccessToken(
  input: { refreshToken: string; clientRef: string | null | undefined },
  doFetch: typeof fetch = fetch,
): Promise<{ accessToken: string; expiryDate: Date }> {
  const client = await googleClientForRef(input.clientRef);
  const res = await doFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`google_token_refresh ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  return { accessToken: data.access_token, expiryDate: new Date(Date.now() + data.expires_in * 1000) };
}
