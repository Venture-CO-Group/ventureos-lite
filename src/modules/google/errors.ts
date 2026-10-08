import type { FlowFailure } from "./oauth-flow";

/**
 * A failure as a short, URL-safe code. The sentence for each lives with the
 * screens that show it; the code is what travels in the redirect.
 */
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
