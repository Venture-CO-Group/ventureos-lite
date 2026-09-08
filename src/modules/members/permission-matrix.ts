import {
  DOCUMENT_GRANTS,
  GRANTS,
  grantAllowed,
  grantIsImplicit,
  type Grant,
} from "@/lib/grants";

/**
 * The permission matrix (§6).
 *
 * ── WHY THE FLAT CHECKLIST WAS NOT ENOUGH ───────────────────────────────────
 *
 * The grants panel was fourteen checkboxes with their identifiers next to
 * them. It could tell you a box was ticked and nothing else: not what the box
 * governs, not whether the role already carried it, not why the tick was there.
 * So the questions people actually have — "what does an Admin get that a BDR
 * does not", "is this ticked because I ticked it or because the role does" —
 * had no answer on the screen that was supposed to answer them.
 *
 * ── EVERY CELL IS THE RESOLVER, ASKED ───────────────────────────────────────
 *
 * Nothing here is written down. The rows are `GRANTS`, the cells are
 * `grantAllowed` and `grantIsImplicit`, and the modules are derived from the
 * grant identifiers themselves. That is the requirement, and the reason for it
 * is that a matrix maintained by hand is a matrix that disagrees with the
 * server the first time somebody edits the model — with nothing to catch it,
 * because a stale matrix still renders perfectly.
 */

export const MATRIX_ROLES = ["OWNER", "ADMIN", "BDR", "CLIENT"] as const;
export type MatrixRole = (typeof MATRIX_ROLES)[number];

/**
 * The module a capability belongs to, from its own identifier.
 *
 * `documents.quote.create` → documents. Derived rather than mapped, so a new
 * grant lands in the right group without anybody remembering to add it — and
 * a grant whose name does not follow the convention groups under itself, which
 * is visible rather than silent.
 */
export function moduleOf(grant: string): string {
  return grant.split(".")[0] ?? grant;
}

export interface MatrixCell {
  role: MatrixRole;
  /** The role carries it with no grant at all. */
  inherent: boolean;
  /** It can be handed over per person. */
  grantable: boolean;
}

export interface MatrixRow {
  grant: Grant;
  module: string;
  /** True for the five that stay behind an explicit grant whatever the role. */
  documentGrant: boolean;
  cells: MatrixCell[];
}

export interface MatrixGroup {
  module: string;
  rows: MatrixRow[];
}

export function buildMatrix(): MatrixGroup[] {
  const byModule = new Map<string, MatrixRow[]>();

  for (const grant of GRANTS) {
    // Not named `module`: Next.js lints that identifier because assigning to
    // it shadows the CommonJS binding in a client bundle.
    const group = moduleOf(grant);
    const row: MatrixRow = {
      grant,
      module: group,
      documentGrant: DOCUMENT_GRANTS.includes(grant),
      cells: MATRIX_ROLES.map((role) => ({
        role,
        inherent: grantIsImplicit(role, grant),
        /**
         * Grantable means "handing it over changes the answer".
         *
         * For a CLIENT it never does — the resolver refuses every capability
         * before it reads the list — so the matrix says so rather than showing
         * a column of empty boxes that look like an oversight.
         */
        grantable: !grantIsImplicit(role, grant) && grantAllowed(role, [grant], grant),
      })),
    };
    const list = byModule.get(group) ?? [];
    list.push(row);
    byModule.set(group, list);
  }

  // Modules in the order their first capability is declared, which is the
  // order somebody reading `grants.ts` meets them in.
  return [...byModule.entries()].map(([name, rows]) => ({ module: name, rows }));
}

/** A one-line summary per role, for the column headers. */
export function roleSummary(role: MatrixRole): string {
  const inherent = GRANTS.filter((g) => grantIsImplicit(role, g)).length;
  if (inherent === GRANTS.length) return `all ${GRANTS.length}`;
  if (inherent === 0) return "none";
  return `${inherent} of ${GRANTS.length}`;
}
