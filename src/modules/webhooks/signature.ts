import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signing an outbound payload (P5/5.2).
 *
 * ── WHY A SIGNATURE AND NOT A SHARED URL SECRET ─────────────────────────────
 *
 * A receiver has to be able to tell our POST from anybody else's POST to the
 * same endpoint. A token in the URL cannot do that: it leaks into their access
 * logs, their proxy, their error tracker, and anybody who has read one request
 * can replay it for ever.
 *
 * So: HMAC-SHA256 over `timestamp.body`, in the header, the way Stripe and
 * GitHub do it. The timestamp is inside the signed material, which is what
 * makes a replay detectable — a captured request is only valid for the window
 * the receiver chooses to allow.
 */
export const SIGNATURE_HEADER = "X-Venture-Signature";
export const TIMESTAMP_HEADER = "X-Venture-Timestamp";
export const EVENT_HEADER = "X-Venture-Event";
export const DELIVERY_HEADER = "X-Venture-Delivery";

/** 32 bytes of hex. Long enough that nobody tries to guess it. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * What a receiver should do, written here so the docs can be generated from
 * something that is actually run by the tests.
 *
 * Constant-time comparison, because a receiver that compares with `===` leaks
 * the signature one byte at a time to anybody willing to make enough requests.
 */
export function verifyPayload(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
  toleranceSeconds = 300,
): boolean {
  const expected = signPayload(secret, timestamp, body);
  if (signature.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"))) {
    return false;
  }
  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  return age <= toleranceSeconds;
}
