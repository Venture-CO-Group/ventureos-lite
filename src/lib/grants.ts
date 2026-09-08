/**
 * Capability grants (spec §3). Layered on top of roles, assignable per user per
 * workspace. Default: all documents.* and templates.* belong to Owner only;
 * Fanni (BDR) gets none until explicitly granted. Checked server-side on every
 * mutation (CLAUDE.md hard rule #7).
 */
export const GRANTS = [
  "documents.quote.create",
  "documents.contract.create",
  "documents.certificate.create",
  "documents.send",
  "templates.edit",
  "signal_engine.approve",
  "exports.run",
  /// Owner-defined fields (v2 P5/1). Adding a REQUIRED field changes what every
  /// form in the workspace demands and archiving one changes what every table
  /// shows, so the definition set is a capability rather than an edit.
  "fields.manage",
  /// Merging two companies or two leads (v2 P5/2). Irreversible after 30 days,
  /// and it moves every activity, document and deal off one record onto
  /// another — a mistake here is not a typo, it is two clients becoming one.
  "data.merge",
  /// Hard-deleting a lead, in one or in bulk, and rolling back an import
  /// (which is a bulk delete of what that import created). Cascades to the
  /// derived data — GDPR erasure, not a soft flag — so it is a capability
  /// rather than an ordinary edit, and it is audit-logged either way.
  "leads.delete",
  /// Workspace behaviour a BDR tunes as part of the job: targets, workflow
  /// rules, account-health thresholds, quote-behaviour rules, the deals commit
  /// threshold, and the data-quality view. Not identity, not credentials,
  /// not money — those stay Owner-only and are not grants at all.
  "settings.manage",
  /// Reading the audit log. A read, but a revealing one: it names who did what
  /// and when, across the whole workspace.
  "audit_log.read",
  /// Publishing and withdrawing prospect-facing pages — audit share links and
  /// booking pages. Outward-facing, which is why it is nameable, but it is
  /// daily sales work.
  "public_pages.manage",
  /// Commissioning, generating and publishing a sector report.
  "sector_reports.manage",
] as const;

export type Grant = (typeof GRANTS)[number];

/** Owner's default grant set: everything. */
export const OWNER_GRANTS: Grant[] = [...GRANTS];

/**
 * The capabilities that stay behind an explicit grant, whatever the role.
 *
 * ── WHY THESE AND NOT THE OTHERS ───────────────────────────────────────────
 *
 * A quote, a contract and a completion certificate are the documents this
 * business is bound by; sending one puts the company's name behind a number.
 * `templates.edit` is the same power one step back — it decides what every
 * future document SAYS, so granting it is granting all of them.
 *
 * Everything else on the list is ordinary daily work that a BDR was being
 * stopped from doing for no reason anybody could name.
 */
export const DOCUMENT_GRANTS: Grant[] = [
  "documents.quote.create",
  "documents.contract.create",
  "documents.certificate.create",
  "documents.send",
  "templates.edit",
];

/**
 * Pure grant resolution. Lives here, not in authz.ts, so the rule can be
 * imported and unit-tested without pulling in Auth.js and the request-scoped
 * session.
 *
 * Owner and Admin carry everything. A BDR carries everything EXCEPT the
 * document capabilities, which still have to be handed over one by one.
 *
 * ── WHAT IS DELIBERATELY NOT A GRANT ────────────────────────────────────────
 *
 * User management, grant assignment, workspace provisioning, integration
 * credentials, the letterhead, commission figures, the cold-email sign-off and
 * the invoicing key are Owner-only through `requireOwner`, and no grant
 * reaches them. That is not an oversight and it is not a hierarchy for its own
 * sake: `setGrant` in particular MUST stay outside this system, because a role
 * that can hand itself capabilities has no capabilities — it has all of them.
 *
 * Everything else is the job. A BDR previously needed an explicit grant to run
 * an export, approve a signal or merge two obvious duplicates, and could not
 * delete a lead at all — daily work, gated as if it were a legal document.
 */
export function grantAllowed(role: string, grants: string[], grant: string): boolean {
  /**
   * A client carries nothing, and cannot be given anything (P6/6.3).
   *
   * Checked FIRST, before the explicit-grants list is even read, so a stray
   * entry in a CLIENT membership's `grants` array — set by hand, or left behind
   * by a role change — cannot hand a read-only account a capability.
   */
  if (role === "CLIENT") return false;
  if (role === "OWNER" || role === "ADMIN") return true;
  // An explicit revocation beats the role default. Without this, a capability
  // a BDR carries implicitly could never be taken back: the grants UI rendered
  // its checkbox ticked and DISABLED, so "grants" that everyone always had
  // were not grants at all.
  if (grants.includes(denyToken(grant))) return false;
  if (role === "BDR" && !DOCUMENT_GRANTS.includes(grant as Grant)) return true;
  return grants.includes(grant);
}

/**
 * How a withdrawn capability is written down.
 *
 * A membership's `grants` array is a list of strings, and it has always meant
 * "additionally allowed". A role that carries something by default needs the
 * opposite word, so a `!`-prefixed entry means "explicitly withdrawn from this
 * person". `!` cannot collide with a real grant: every one of them is
 * lower-case dotted identifiers.
 *
 * Stored rather than derived because the alternative — enumerating what each
 * role implies and diffing — puts the role table in two places, and they drift.
 */
export function denyToken(grant: string): string {
  return `!${grant}`;
}

export function isDenyToken(entry: string): boolean {
  return entry.startsWith("!");
}

/**
 * Whether the role hands this capability over without anybody asking.
 *
 * Drives the grants UI: an implicit capability renders ticked, and — unlike
 * before — remains clickable, because unticking it is how an Owner takes it
 * away.
 */
export function grantIsImplicit(role: string, grant: string): boolean {
  if (role === "CLIENT") return false;
  if (role === "OWNER" || role === "ADMIN") return true;
  return role === "BDR" && !DOCUMENT_GRANTS.includes(grant as Grant);
}

/**
 * A seated member of the workspace, as opposed to somebody merely signed in.
 *
 * Gates the shared furniture: curating saved lead views, approving content,
 * running the prospect backfill, seeing the Owner-only notification types.
 * The comment here used to say that a read-only role could be introduced later
 * with a single edit rather than a hunt through five files. That turned out to
 * be true, and this is the edit: CLIENT does not qualify (P6/6.3).
 */
export function isTrustedMember(role: string | null | undefined): boolean {
  return role === "OWNER" || role === "ADMIN" || role === "BDR";
}

/**
 * A read-only client account (P6/6.3).
 *
 * Not a smaller BDR. A CLIENT sees ONE company's delivery — its projects,
 * milestones and finalized documents — and nothing else in the workspace. This
 * predicate is what the shell branches on; the guarantees are enforced
 * elsewhere and do not depend on it:
 *
 *   - `grantAllowed` hands a CLIENT no capability, ever;
 *   - the Prisma tenant guard refuses every write on every business table;
 *   - the portal resolves the ONE company from the membership.
 *
 * Three independent checks, so forgetting one of them in a future screen
 * narrows what a client can see rather than widening it.
 */
export function isClientRole(role: string | null | undefined): boolean {
  return role === "CLIENT";
}

/**
 * The only paths a client account may render.
 *
 * `/portal` matches its sub-routes too, because the portal will grow pages and
 * each one would otherwise be a silent redirect nobody notices in testing.
 *
 * `/settings` and `/enroll-2fa` match EXACTLY. A client needs to change their
 * own password and register an authenticator — refusing that would make a
 * workspace-wide 2FA policy impossible for them to satisfy — but `/settings`
 * has sub-pages (`/settings/admin`, `/settings/workspaces`) that are somebody
 * else's business, and an exact match is the difference between "your profile"
 * and "a list of the workspaces you can see".
 */
export const CLIENT_PORTAL_PREFIX = "/portal";
export const CLIENT_ALLOWED_EXACT: readonly string[] = ["/settings", "/enroll-2fa"];

export function clientMayVisit(path: string | undefined): boolean {
  if (!path) return false;
  if (path === CLIENT_PORTAL_PREFIX || path.startsWith(`${CLIENT_PORTAL_PREFIX}/`)) return true;
  return CLIENT_ALLOWED_EXACT.includes(path);
}

/** Raised when a server-side mutation is attempted without its capability. */
export class GrantError extends Error {
  readonly grant: string;
  constructor(grant: string) {
    super(`Missing capability: ${grant}`);
    this.name = "GrantError";
    this.grant = grant;
    Object.setPrototypeOf(this, GrantError.prototype);
  }
}
