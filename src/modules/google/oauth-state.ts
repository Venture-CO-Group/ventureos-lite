import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The OAuth `state` parameter: signed, short-lived, and bound to a browser.
 *
 * ── WHY IT CARRIES THE WORKSPACE ───────────────────────────────────────────
 *
 * There is one redirect URI for every client, so the callback cannot tell from
 * the URL which client's code it is holding. The state says which workspace
 * started the flow, and the workspace decides the client. Signing it means the
 * callback can trust that — a forged state naming another workspace fails the
 * signature, and an old one fails the expiry.
 *
 * ── WHY ALSO A COOKIE ──────────────────────────────────────────────────────
 *
 * The nonce in the state must equal the nonce in an httpOnly cookie set when
 * the flow began. Without that, a valid state captured from one browser could
 * be replayed in another (login CSRF: tricking somebody into connecting the
 * attacker's mailbox to their account).
 */

export const STATE_TTL_MS = 10 * 60_000;
export const STATE_COOKIE = "vos_google_oauth";

export type OAuthPurpose = "connect" | "test";

export interface OAuthState {
  workspaceId: string;
  userId: string;
  nonce: string;
  purpose: OAuthPurpose;
  /** Issued at, ms since epoch. */
  iat: number;
}

/** Derived from the session secret with its own label, so it signs nothing else. */
export function stateKey(secret: string | undefined = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET): Buffer {
  if (!secret) throw new Error("No AUTH_SECRET/NEXTAUTH_SECRET: cannot sign OAuth state");
  return createHmac("sha256", secret).update("google-oauth-state:v1").digest();
}

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function newNonce(): string {
  return randomBytes(18).toString("base64url");
}

export function signState(
  input: Omit<OAuthState, "iat" | "nonce"> & { nonce?: string; iat?: number },
  key: Buffer = stateKey(),
): { state: string; nonce: string } {
  const body: OAuthState = {
    workspaceId: input.workspaceId,
    userId: input.userId,
    purpose: input.purpose,
    nonce: input.nonce ?? newNonce(),
    iat: input.iat ?? Date.now(),
  };
  const payload = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return { state: `${payload}.${sign(payload, key)}`, nonce: body.nonce };
}

export type StateRejection = "malformed" | "signature" | "expired" | "nonce";

export function verifyState(
  token: string | null | undefined,
  opts: { cookieNonce: string | null | undefined; now?: number; key?: Buffer },
): { ok: true; state: OAuthState } | { ok: false; reason: StateRejection } {
  if (!token || token.length > 2000) return { ok: false, reason: "malformed" };
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload, opts.key ?? stateKey()));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature" };
  }

  let body: OAuthState;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof body.workspaceId !== "string" ||
    typeof body.userId !== "string" ||
    typeof body.nonce !== "string" ||
    typeof body.iat !== "number" ||
    (body.purpose !== "connect" && body.purpose !== "test")
  ) {
    return { ok: false, reason: "malformed" };
  }
  const now = opts.now ?? Date.now();
  if (body.iat > now + 60_000 || now - body.iat > STATE_TTL_MS) return { ok: false, reason: "expired" };

  const cookie = Buffer.from(opts.cookieNonce ?? "");
  const nonce = Buffer.from(body.nonce);
  if (cookie.length !== nonce.length || !timingSafeEqual(cookie, nonce)) {
    return { ok: false, reason: "nonce" };
  }
  return { ok: true, state: body };
}
