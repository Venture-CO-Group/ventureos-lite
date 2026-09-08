/**
 * Workspace-wide security policy (P5/5.1).
 *
 * ── WHY 2FA WAS PER-PERSON, AND WHY THAT IS NOT ENOUGH ──────────────────────
 *
 * Two-factor authentication existed, complete with TOTP enrolment, a QR code
 * and an Owner-triggered reset. It was entirely OPTIONAL per user: there was no
 * way to say "in this workspace, everybody". For a system holding other
 * people's client data that is the usual expectation, and the field that makes
 * it work — `User.mustEnrollTotp`, which the shell already redirects on — was
 * sitting there with nothing to set it.
 *
 * Pure over `Workspace.featureFlags`, so the resolution is testable without a
 * database and one function decides it for every surface.
 */

export interface SecurityPolicy {
  /** Everybody in this workspace must have an authenticator registered. */
  require2fa: boolean;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = { require2fa: false };

export function securityPolicyFrom(featureFlags: unknown): SecurityPolicy {
  if (!featureFlags || typeof featureFlags !== "object" || Array.isArray(featureFlags)) {
    return DEFAULT_SECURITY_POLICY;
  }
  const raw = (featureFlags as Record<string, unknown>).security;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_SECURITY_POLICY;
  const require2fa = (raw as Record<string, unknown>).require2fa;
  return { require2fa: require2fa === true };
}

/**
 * Must this person register an authenticator before they can work?
 *
 * Two independent reasons, and the distinction matters when explaining it:
 *
 *   - the WORKSPACE requires it and they have none;
 *   - an Owner reset THEIR second factor specifically, which is the existing
 *     `mustEnrollTotp` flag and is about one person rather than a policy.
 *
 * Either way the shell sends them to enrolment. The reason is returned so the
 * page can say which it is — "your workspace requires this" and "an Owner
 * reset your authenticator" call for different next actions.
 */
export type EnrolmentReason = "workspace_policy" | "reset_by_owner" | null;

export function enrolmentRequired(
  user: { totpEnabled: boolean; mustEnrollTotp: boolean },
  policy: SecurityPolicy,
): EnrolmentReason {
  // The personal reset is reported first: it is the more specific fact, and it
  // is true even in a workspace with no policy.
  if (user.mustEnrollTotp) return "reset_by_owner";
  if (policy.require2fa && !user.totpEnabled) return "workspace_policy";
  return null;
}

/**
 * How many members would be locked out of working until they enrol.
 *
 * Shown before the switch is flipped. An Owner turning this on for a team of
 * six deserves to know that four of them will hit an enrolment screen on their
 * next click — and that it is enrolment rather than a lockout, which is the
 * part people worry about.
 */
export function pendingEnrolments(
  members: Array<{ totpEnabled: boolean }>,
): number {
  return members.filter((m) => !m.totpEnabled).length;
}
