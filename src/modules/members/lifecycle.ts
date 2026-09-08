/**
 * Membership states, and what each one may do (§1).
 *
 * ── WHY THIS IS PURE ────────────────────────────────────────────────────────
 *
 * Three questions get asked about a member from a dozen places: can they sign
 * in, can work be assigned to them, and do they appear in a picker. Answering
 * those inline meant `suspendedAt: null` scattered through the codebase — a
 * condition that was correct while membership was binary and is now simply
 * incomplete, because it says yes to INVITED and to REMOVED.
 *
 * One module, one answer each, and a test over every state so a new state
 * cannot be added without deciding what it means.
 */

export const MEMBERSHIP_STATES = ["INVITED", "ACTIVE", "SUSPENDED", "REMOVED"] as const;
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];

export interface StateDef {
  state: MembershipState;
  label: string;
  /** One line for the badge's tooltip. */
  hint: string;
  /** Resolves a session and can reach the app. */
  canSignIn: boolean;
  /** Can be given a lead, a deal, a task or a meeting. */
  assignable: boolean;
  /** Counts towards "how many people are in this workspace". */
  seated: boolean;
  /** The badge's tone. */
  tone: "ok" | "warn" | "muted";
}

export const MEMBERSHIP_STATE_DEFS: Record<MembershipState, StateDef> = {
  INVITED: {
    state: "INVITED",
    label: "Invited",
    hint: "An invitation is out. They have not accepted it yet.",
    // The invitation is the credential, and accepting it is what creates the
    // ability to sign in. Until then there may not even be a password.
    canSignIn: false,
    assignable: false,
    seated: false,
    tone: "warn",
  },
  ACTIVE: {
    state: "ACTIVE",
    label: "Active",
    hint: "Signed up and working.",
    canSignIn: true,
    assignable: true,
    seated: true,
    tone: "ok",
  },
  SUSPENDED: {
    state: "SUSPENDED",
    label: "Suspended",
    hint: "Cannot sign in and cannot be assigned. Everything they own is still theirs.",
    canSignIn: false,
    /**
     * Not assignable, but still the OWNER of everything they had.
     *
     * That distinction is the whole point of suspension. Removing somebody
     * takes the authorship of their history with them; standing them down
     * stops them working without rewriting what they did.
     */
    assignable: false,
    seated: true,
    tone: "warn",
  },
  REMOVED: {
    state: "REMOVED",
    label: "Removed",
    hint: "No longer a member. Their name still appears on what they created.",
    canSignIn: false,
    assignable: false,
    seated: false,
    tone: "muted",
  },
};

export function canSignIn(state: string): boolean {
  return MEMBERSHIP_STATE_DEFS[state as MembershipState]?.canSignIn === true;
}

export function isAssignable(state: string): boolean {
  return MEMBERSHIP_STATE_DEFS[state as MembershipState]?.assignable === true;
}

export function isSeated(state: string): boolean {
  return MEMBERSHIP_STATE_DEFS[state as MembershipState]?.seated === true;
}

/**
 * Which states a membership may move to from here.
 *
 * Written down because two of the transitions are wrong in ways that are not
 * obvious: an INVITED membership cannot be suspended (there is nothing to
 * suspend — revoke the invitation instead), and a REMOVED one cannot be
 * reinstated directly. Bringing somebody back is a fresh invitation, so that
 * they accept the terms again and so the timeline shows a return rather than
 * an edit.
 */
export const ALLOWED_TRANSITIONS: Record<MembershipState, MembershipState[]> = {
  INVITED: ["ACTIVE", "REMOVED"],
  ACTIVE: ["SUSPENDED", "REMOVED"],
  SUSPENDED: ["ACTIVE", "REMOVED"],
  REMOVED: ["INVITED"],
};

export function canTransition(from: string, to: string): boolean {
  const allowed = ALLOWED_TRANSITIONS[from as MembershipState];
  return Array.isArray(allowed) && allowed.includes(to as MembershipState);
}

/** States that count as "still here", for a member list's default filter. */
export const LIVE_STATES: MembershipState[] = ["INVITED", "ACTIVE", "SUSPENDED"];
