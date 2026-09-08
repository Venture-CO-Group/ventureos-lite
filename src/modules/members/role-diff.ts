import { GRANTS, grantAllowed, grantIsImplicit, type Grant } from "@/lib/grants";

/**
 * What changes if this person becomes that role (§4, §6).
 *
 * ── WHY THIS IS COMPUTED AND NEVER WRITTEN DOWN ─────────────────────────────
 *
 * The spec asks for "a preview of exactly what the person gains and loses,
 * computed from the grants model, not hardcoded prose", and that qualifier is
 * the whole requirement. A hand-written sentence — "Admins can do everything
 * except manage users" — is true on the day it is typed and becomes a lie the
 * first time the model changes, with nothing to catch it because the sentence
 * still reads perfectly well.
 *
 * So both sides are `grantAllowed` asked twice: once with the role they have,
 * once with the role they would have. The same function drives the drawer's
 * effective-permissions list, and §6's property-based test walks every role ×
 * grant combination to prove the two agree with the resolver.
 *
 * ── THE EXPLICIT GRANTS ARE CARRIED THROUGH ─────────────────────────────────
 *
 * Deliberately. A BDR with `templates.edit` granted explicitly does not lose
 * it by becoming an Admin, and an Admin whose `exports.run` was explicitly
 * WITHDRAWN keeps that withdrawal as a BDR. Diffing role-against-role while
 * ignoring the membership's own grants would tell somebody they are about to
 * lose a capability they will in fact keep.
 */
export interface RoleDiff {
  gains: Grant[];
  loses: Grant[];
  unchanged: Grant[];
  /** True when nothing at all would change — the button can say so. */
  identical: boolean;
}

export function roleDiff(input: {
  fromRole: string;
  toRole: string;
  grants: string[];
}): RoleDiff {
  const gains: Grant[] = [];
  const loses: Grant[] = [];
  const unchanged: Grant[] = [];

  for (const grant of GRANTS) {
    const before = grantAllowed(input.fromRole, input.grants, grant);
    const after = grantAllowed(input.toRole, input.grants, grant);
    if (before === after) unchanged.push(grant);
    else if (after) gains.push(grant);
    else loses.push(grant);
  }

  return {
    gains,
    loses,
    unchanged,
    identical: gains.length === 0 && loses.length === 0,
  };
}

/**
 * Why each capability is held, for the resolved view.
 *
 * Separate from the diff because the drawer asks a different question — not
 * "what would change" but "why can they do this now".
 */
export function grantSource(
  role: string,
  grants: string[],
  grant: string,
): "role" | "explicit" | "withdrawn" | "none" {
  if (grants.includes(`!${grant}`)) return "withdrawn";
  if (grantIsImplicit(role, grant)) return "role";
  return grants.includes(grant) ? "explicit" : "none";
}
