/**
 * What actually leaves (spec §4.43.9): the approved body, the account's
 * signature, and the mandatory unsubscribe line — in that order, as plain
 * text. The approval card renders through the same function, so "the
 * message exactly as it will be sent" is literally the same string.
 */
import type { OutboundConfig } from "./config";

export function signatureFor(
  sending: Pick<OutboundConfig["sending"], "cachedSignature" | "fallbackSignature">,
  fallback: { senderName: string; company: string },
): string {
  const own = sending.cachedSignature?.trim();
  if (own) return own;
  const configured = sending.fallbackSignature.trim();
  if (configured) return configured;
  return [fallback.senderName, fallback.company].filter(Boolean).join("\n");
}

export function unsubscribeLine(language: "HU" | "EN", url: string): string {
  return language === "HU"
    ? `Ha nem szeretne több levelet kapni tőlünk, itt leiratkozhat: ${url}`
    : `If you would rather not hear from us again, unsubscribe here: ${url}`;
}

export function composeMessage(input: {
  body: string;
  signature: string;
  language: "HU" | "EN";
  unsubscribeUrl: string;
}): string {
  return [input.body.trim(), "", "--", input.signature.trim(), "", unsubscribeLine(input.language, input.unsubscribeUrl)].join("\n");
}

/** The link shape shown in previews before a message has its own token. */
export const PREVIEW_UNSUBSCRIBE_URL = "https://…/u/(personal link added on send)";
