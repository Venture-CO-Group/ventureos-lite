/**
 * The Google consent URL, on its own.
 *
 * Pure, and in its own module, because the route that used to build it inline
 * cannot be imported by a test: it pulls in the session, which pulls in
 * Auth.js. That is how the one parameter that decides whether a host can
 * connect a SECOND calendar went unasserted while everything downstream of two
 * connected accounts was covered.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export const GOOGLE_SCOPES = [
  // Write bookings into the calendar.
  "https://www.googleapis.com/auth/calendar.events",
  // Read busy periods. calendar.events alone is NOT enough for freeBusy —
  // Google rejects it with insufficientPermissions, which made every slot look
  // free and let prospects book over existing meetings. readonly is the
  // least-privilege scope that satisfies the freeBusy endpoint.
  "https://www.googleapis.com/auth/calendar.readonly",
  // Email sync (playbook-v2 P2). Restricted scopes, which need Google
  // verification on an EXTERNAL consent screen — ours is Internal on the
  // Workspace domain, so they are granted without review and refresh tokens do
  // not expire. readonly + send rather than modify: we never need to change
  // anything in the user's mailbox, and asking for less is the difference
  // between a scope review and none.
  //
  // gmail.readonly also covers users.settings.sendAs.get, which is how the
  // outbound sender reads the account signature (playbook-v6 F5/2). The
  // playbook suggested gmail.settings.basic for that; it is a WRITE scope over
  // filters, forwarding and signatures, and is not needed to read one.
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
];

/**
 * ── WHY BOTH PROMPTS ───────────────────────────────────────────────────────
 *
 * A host connects a business calendar meetings are written to, and then a
 * personal one so nobody books over a dentist appointment.
 *
 * `consent` re-asks for CONSENT, which is what makes Google return a refresh
 * token. It does not ask WHICH ACCOUNT. With one Google account signed into the
 * browser — the normal case — Google skips the chooser entirely and hands back
 * the same account; the callback finds its row by email and updates it. So
 * "Connect another calendar" went to Google, came back without error, and still
 * showed one calendar. The second calendar was not merely unconnected, it was
 * unconnectABLE, and its busy times never blocked a slot.
 */
export const GOOGLE_PROMPT = "select_account consent";

export function googleConsentUrl(opts: { clientId: string; redirectUri: string }): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: GOOGLE_PROMPT,
    include_granted_scopes: "true",
  });
  return `${AUTH_URL}?${params.toString()}`;
}
