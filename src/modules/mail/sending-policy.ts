/**
 * Which domains a workspace may send from, per lane (CLAUDE.md hard rule 11).
 *
 * Pure: the policy is loaded by ./sending-domains.ts and every rule here is a
 * function of it, so the rules are unit-tested without a database.
 *
 * ── THE RULE, PER WORKSPACE ────────────────────────────────────────────────
 *
 * Every workspace has three lanes, never crossed:
 *   - transactional (Mailgun)  — quotes, contracts, invoices, invitations;
 *   - cold bulk (Mailgun)      — campaigns, on its own domain;
 *   - approved 1:1 cold outbound (Gmail) — the Outbound Motor, from ONE
 *     configured address.
 *
 * The two cold lanes are held to different domain rules, on purpose:
 *   - cold BULK (Mailgun campaigns) may never use a domain that shares a
 *     registrable domain with the workspace's transactional domain — a
 *     complaint on a campaign must never be able to burn the reputation
 *     quotes and invoices depend on;
 *   - the 1:1 Gmail outbound lane sends from a person's own mailbox, a small
 *     approved volume authenticated by the company's Google Workspace, so it
 *     may use the company's main domain; it may only never be the
 *     transactional SENDING domain itself. (The Venture workspace: Fanni
 *     sends from fanni.viragh@ventureco.group; mg.ventureco.group is refused.)
 *
 * And no workspace may send through a domain another workspace has
 * configured as its own: a sender identity belongs to one company.
 */

/** Two-label public suffixes we meet in practice; anything else is one label. */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz",
  "co.hu", "org.hu", "com.br", "co.jp", "co.za", "com.mx", "com.tr", "co.in",
]);

/** `mg.ventureco.group` → `ventureco.group`; `a.b.co.uk` → `b.co.uk`. */
export function registrableDomain(host: string | null | undefined): string | null {
  const h = (host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!h || !h.includes(".")) return null;
  const labels = h.split(".");
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length >= 3 && TWO_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

export function domainOfAddress(address: string | null | undefined): string {
  const a = (address ?? "").trim().toLowerCase();
  return a.includes("@") ? a.slice(a.lastIndexOf("@") + 1) : "";
}

export interface SendingPolicy {
  workspaceId: string;
  /** The Outbound Motor's one sending address, if configured. */
  outboundAddress: string | null;
  /** Mailgun transactional domain in effect (workspace's own, or the installation's). */
  transactionalDomain: string | null;
  /** Mailgun cold-bulk domain in effect. */
  coldDomain: string | null;
  /** Registrable domains other workspaces have configured as theirs. */
  foreignDomains: ReadonlySet<string>;
}

/** Raised when anything tries to send cold mail from an identity it may not use. */
export class ColdSenderError extends Error {
  constructor(message: string) {
    super(`Refused: ${message} (CLAUDE.md hard rule 11).`);
    this.name = "ColdSenderError";
    Object.setPrototypeOf(this, ColdSenderError.prototype);
  }
}

function sharesTransactional(domain: string, policy: SendingPolicy): boolean {
  const tx = registrableDomain(policy.transactionalDomain);
  return !!tx && registrableDomain(domain) === tx;
}

/** The transactional sending domain itself (not merely its registrable domain). */
function isTransactional(domain: string, policy: SendingPolicy): boolean {
  const tx = (policy.transactionalDomain ?? "").trim().toLowerCase();
  return !!tx && domain === tx;
}

function foreign(domain: string, policy: SendingPolicy): boolean {
  const r = registrableDomain(domain);
  return !!r && policy.foreignDomains.has(r);
}

/**
 * THE Outbound Motor guard: asserted on the mailbox a message is about to
 * leave from, immediately before the send. A refusal, never a warning.
 */
export function assertOutboundFrom(address: string | null | undefined, policy: SendingPolicy): string {
  const a = (address ?? "").trim().toLowerCase();
  const configured = (policy.outboundAddress ?? "").trim().toLowerCase();
  if (!configured) {
    throw new ColdSenderError("this workspace has no cold outbound sending address configured");
  }
  const domain = domainOfAddress(a);
  if (!a || a !== configured) {
    throw new ColdSenderError(
      `cold outbound may only be sent from ${configured}, not ${a || "an unknown address"}`,
    );
  }
  if (isTransactional(domain, policy)) {
    throw new ColdSenderError(
      `${a} is on this workspace's transactional sending domain (${policy.transactionalDomain})`,
    );
  }
  if (foreign(domain, policy)) {
    throw new ColdSenderError(`${domain} is configured by another workspace`);
  }
  return a;
}

/** The same rule for the Mailgun cold-bulk lane. */
export function assertColdBulkDomain(domain: string, policy: SendingPolicy): string {
  const d = domain.trim().toLowerCase();
  if (sharesTransactional(d, policy)) {
    throw new ColdSenderError(
      `cold campaigns may not send from ${d}: it shares a domain with the transactional domain ${policy.transactionalDomain}`,
    );
  }
  if (foreign(d, policy)) throw new ColdSenderError(`${d} is configured by another workspace`);
  return d;
}

/**
 * Whether an Owner may configure this address as the workspace's outbound
 * sender. The same rules as the send-time guard, asked at save time so a bad
 * value is refused in the form rather than at 3 a.m. by the scheduler.
 */
export function validateOutboundAddress(address: string, policy: SendingPolicy): string | null {
  const a = address.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) return "Enter a full email address.";
  const domain = domainOfAddress(a);
  if (isTransactional(domain, policy)) {
    return `${domain} is this workspace's transactional sending domain. Cold outbound may not send from it.`;
  }
  if (foreign(domain, policy)) return `${domain} is already configured by another workspace.`;
  return null;
}
