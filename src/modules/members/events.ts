/**
 * The vocabulary of a membership's timeline (§1).
 *
 * ── WHY STRINGS AND NOT AN ENUM ─────────────────────────────────────────────
 *
 * A database enum would need a migration to add a kind, and the set will grow
 * — the first time somebody wants "email verified" recorded, it should not
 * need a schema change. The cost is that an unknown kind can reach the column,
 * so the timeline renders one it does not recognise as its raw name rather than
 * throwing, and `isMembershipEventKind` is what mutations check before writing.
 *
 * A plain module, not `"use server"`: a const exported from one of those fails
 * the build, and this is the fourth time that comment has been worth writing.
 */

export const MEMBERSHIP_EVENT_KINDS = [
  "invited",
  "invitation_resent",
  "invitation_revoked",
  "invitation_expired",
  "accepted",
  "role_changed",
  "grant_added",
  "grant_removed",
  "profile_changed",
  "email_change_requested",
  "email_changed",
  "password_reset_issued",
  "password_set_by_owner",
  "totp_reset",
  "sessions_revoked",
  "suspended",
  "reinstated",
  "removed",
  "records_reassigned",
  "team_joined",
  "team_left",
  "ownership_transferred",
  "account_deleted",
  "account_restored",
] as const;

export type MembershipEventKind = (typeof MEMBERSHIP_EVENT_KINDS)[number];

export function isMembershipEventKind(v: unknown): v is MembershipEventKind {
  return typeof v === "string" && (MEMBERSHIP_EVENT_KINDS as readonly string[]).includes(v);
}

/**
 * How each kind reads on the timeline.
 *
 * One sentence, past tense, naming the thing that changed rather than the
 * table it changed in. "Their role became Admin" is a timeline; "membership
 * updated" is a log nobody can use.
 */
const LABELS: Record<MembershipEventKind, string> = {
  invited: "Invited to the workspace",
  invitation_resent: "Invitation sent again",
  invitation_revoked: "Invitation revoked",
  invitation_expired: "Invitation expired",
  accepted: "Accepted the invitation",
  role_changed: "Role changed",
  grant_added: "Capability granted",
  grant_removed: "Capability withdrawn",
  profile_changed: "Profile edited",
  email_change_requested: "Email change requested — waiting for verification",
  email_changed: "Sign-in email changed",
  password_reset_issued: "Password reset link issued",
  password_set_by_owner: "Password set by an Owner",
  totp_reset: "Two-factor authentication reset",
  sessions_revoked: "Signed out of every device",
  suspended: "Suspended",
  reinstated: "Reinstated",
  removed: "Removed from the workspace",
  records_reassigned: "Their records were reassigned",
  team_joined: "Joined a team",
  team_left: "Left a team",
  ownership_transferred: "Workspace ownership transferred",
  account_deleted: "Account scheduled for deletion",
  account_restored: "Account restored",
};

export function eventLabel(kind: string): string {
  return isMembershipEventKind(kind) ? LABELS[kind] : kind;
}

/**
 * Kinds that MUST carry a reason (§4).
 *
 * A 2FA reset is the classic social-engineering target — "hi, it's Anna, I
 * lost my phone" — so the person doing it has to write down who asked and how
 * they were satisfied it was really them. Removing somebody and transferring
 * ownership are the two other actions nobody should be able to take silently.
 */
export const REASON_REQUIRED: MembershipEventKind[] = [
  "totp_reset",
  "removed",
  "ownership_transferred",
];

export function requiresReason(kind: string): boolean {
  return REASON_REQUIRED.includes(kind as MembershipEventKind);
}
