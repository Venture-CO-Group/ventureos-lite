import type { FlowFailure } from "./oauth-flow";

/**
 * Google OAuth failures, as sentences somebody can act on (item 4).
 *
 * ── WHAT CAN AND CANNOT BE CAUGHT ──────────────────────────────────────────
 *
 * Some errors come back to our callback (`?error=access_denied`) or out of the
 * token exchange as JSON (`invalid_client`, `redirect_uri_mismatch`,
 * `invalid_grant`) — those are mapped here and the raw response is never
 * shown. Others Google refuses to redirect at all and renders on its own page
 * during consent: `org_internal`, and a redirect URI or client id that Google
 * does not recognise. Nothing can replace that page; so the same sentences are
 * also shown BEFORE the person goes to Google (see `GOOGLE_PAGE_ERRORS`), and
 * the code they will see there is named in them.
 */

export interface GoogleErrorExplanation {
  message: string;
  /** The settings field to fix, when there is one. */
  field?: "clientId" | "clientSecret" | "redirectUri" | null;
}

const ORG_INTERNAL =
  "This Google account is not part of the organisation that owns this workspace's Google client. Sign in with an account from that organisation, or configure the workspace's own Google client.";

const MESSAGES: Record<string, GoogleErrorExplanation> = {
  org_internal: { message: ORG_INTERNAL },
  invalid_client: {
    message:
      "Google does not recognise this workspace's client. Check the Client id and Client secret fields under Google connection — copy both again from Google Cloud Console → APIs & Services → Credentials.",
    field: "clientId",
  },
  unauthorized_client: {
    message:
      "This client is not allowed to use this flow. In Google Cloud Console the OAuth client must be of type “Web application” — check the Client id field points at that client.",
    field: "clientId",
  },
  redirect_uri_mismatch: {
    message:
      "The redirect URI does not match. In Google Cloud Console → Credentials → your OAuth client → Authorised redirect URIs, add the URI shown under Google connection exactly as written — same scheme, host and path, no trailing slash.",
    field: "redirectUri",
  },
  access_denied: {
    message:
      "Google did not grant access: either you cancelled on the consent screen, or your Google Workspace administrator has restricted this app. Try again, or ask your administrator to allow it.",
  },
  admin_policy_enforced: {
    message:
      "Your Google Workspace administrator has restricted this app. Ask them to allow it under Security → API controls → App access control.",
  },
  invalid_grant: {
    message: "The authorisation expired or was already used. Start the connection again.",
  },
  invalid_scope: {
    message:
      "Google refused one of the requested permissions. Check the OAuth consent screen allows every scope listed under Google connection.",
  },
  not_configured: {
    message:
      "Google is not set up for this workspace yet. An Owner can add the workspace's own Google client under Settings → Email → Google connection.",
  },
  state_expired: { message: "The connection took too long and expired. Start it again." },
  state_signature: { message: "That connection link was not issued by this app. Start the connection again from Settings." },
  state_malformed: { message: "That connection link was not issued by this app. Start the connection again from Settings." },
  state_nonce: {
    message: "The connection was started in a different browser or tab. Start it again here.",
  },
  wrong_user: { message: "You signed in as somebody else while connecting. Start the connection again." },
  wrong_workspace: {
    message:
      "You switched workspace while connecting. A Google account connects through the workspace you are working in — switch back, or start again here.",
  },
  not_member: { message: "You are no longer a member of the workspace this connection was for." },
  missing_code: { message: "Google returned without an authorisation. Start the connection again." },
};

const FALLBACK: GoogleErrorExplanation = {
  message: "Google could not complete the connection. Start it again; if it keeps failing, an Owner can run “Test connection” under Google connection.",
};

/** A failure as a short, URL-safe code — what travels in the redirect. */
export function failureCode(f: FlowFailure): string {
  switch (f.code) {
    case "state":
      return `state_${f.reason}`;
    case "google":
    case "exchange":
      return f.error.replace(/[^a-z0-9_]/gi, "").slice(0, 60) || "error";
    default:
      return f.code;
  }
}

/** The sentence for a code. Unknown codes never echo Google's raw text. */
export function googleErrorMessage(code: string | null | undefined): GoogleErrorExplanation {
  if (!code) return FALLBACK;
  return MESSAGES[code] ?? FALLBACK;
}

/**
 * The errors Google shows on ITS page and never sends back — explained before
 * the person leaves, keyed by the code Google will display.
 */
export const GOOGLE_PAGE_ERRORS: { code: string; message: string }[] = [
  { code: "org_internal", message: ORG_INTERNAL },
  { code: "redirect_uri_mismatch", message: MESSAGES.redirect_uri_mismatch.message },
  { code: "invalid_client", message: MESSAGES.invalid_client.message },
];
