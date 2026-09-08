/**
 * What a person owns, and where it can go when they leave (§1, used by §4).
 *
 * ── WHY THIS IS A DECLARED MAP AND NOT A FUNCTION PER TABLE ─────────────────
 *
 * Removing a member is the dangerous action in this product. Get it wrong in
 * one direction and open deals lose their owner and fall out of every
 * forecast; get it wrong in the other and a departed employee still appears in
 * assignee pickers for ever.
 *
 * The impact report, the reassignment step and the transaction that executes it
 * all read this one list. Three hand-written lists would agree until somebody
 * added a table — and the failure mode of a missed table is silent: the record
 * keeps pointing at a user who is no longer a member, and nothing complains.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 *
 * Historical attribution. `Activity.byUserId` ("who logged this note"),
 * `Call.byUserId` ("who made this call") and every `createdBy` stay exactly as
 * they are. Removal ends somebody's access; it does not rewrite what they did,
 * and a call record that changes who made it is a falsified record.
 *
 * `Campaign` has no owner column at all — cold campaigns belong to the
 * workspace — so there is nothing to reassign, and saying so here is better
 * than leaving a reader to wonder whether it was forgotten.
 *
 * `Subscription` has no owner column either: commission attribution walks
 * `subscription → lead → owner` (or the deal's owner when there is one), so
 * reassigning the LEAD moves the attribution with it. That is why leads are
 * reassigned before anything else reads them.
 */

export interface OwnedCategory {
  key: string;
  /** Prisma model, for the impact query and the update. */
  model:
    | "lead"
    | "deal"
    | "task"
    | "meeting"
    | "bookingPage"
    | "savedView"
    | "contentPost";
  /** The column holding the owner. */
  column: "ownerId" | "assigneeId" | "hostUserId" | "authorUserId";
  label: string;
  /** What is counted, in words, for the impact report. */
  hint: string;
  /**
   * May this category be left with nobody?
   *
   * False for open deals and open tasks — the spec is explicit and it is right:
   * an unowned open deal is money nobody is chasing, and an unassigned open
   * task is work that has quietly become nobody's. False for a booking page and
   * a saved view because their columns are NOT NULL, so "unassigned" is not a
   * state the database can hold.
   */
  mayUnassign: boolean;
  /**
   * Only rows matching this are moved; the rest are history.
   *
   * A closed deal keeps the person who closed it — that is who won it — and a
   * published content post keeps its author. Reassigning either would rewrite
   * a record of what happened.
   */
  openOnly: boolean;
}

export const OWNED_CATEGORIES: readonly OwnedCategory[] = [
  {
    key: "leads",
    model: "lead",
    column: "ownerId",
    label: "Leads",
    hint: "Open leads they own. Commission attribution follows the lead, so this moves that too.",
    mayUnassign: true,
    openOnly: false,
  },
  {
    key: "deals",
    model: "deal",
    column: "ownerId",
    label: "Open deals",
    hint: "Deals still open. A closed deal keeps whoever closed it.",
    // An unowned open deal is money nobody is chasing.
    mayUnassign: false,
    openOnly: true,
  },
  {
    key: "tasks",
    model: "task",
    column: "assigneeId",
    label: "Open tasks",
    hint: "Tasks not yet done. Completed ones keep their assignee.",
    // An unassigned open task is work that has quietly become nobody's.
    mayUnassign: false,
    openOnly: true,
  },
  {
    key: "meetings",
    model: "meeting",
    column: "hostUserId",
    label: "Upcoming meetings",
    hint: "Meetings still ahead. Past ones keep their host.",
    mayUnassign: true,
    openOnly: true,
  },
  {
    key: "bookingPages",
    model: "bookingPage",
    column: "hostUserId",
    label: "Booking pages",
    hint: "Public pages that book time with them. Prospects may be holding these links.",
    // The column is NOT NULL: "nobody" is not a state it can hold, and a live
    // public page pointing at a departed host is worse than one that moved.
    mayUnassign: false,
    openOnly: false,
  },
  {
    key: "savedViews",
    model: "savedView",
    column: "ownerId",
    label: "Saved views",
    hint: "Shared views they created. Their personal views go with them.",
    mayUnassign: false,
    openOnly: false,
  },
  {
    key: "contentPosts",
    model: "contentPost",
    column: "authorUserId",
    label: "Unpublished content",
    hint: "Drafts and posts in review. Published ones keep their author.",
    mayUnassign: true,
    openOnly: true,
  },
] as const;

export const OWNED_CATEGORY_KEYS: readonly string[] = OWNED_CATEGORIES.map((c) => c.key);

export function categoryFor(key: string): OwnedCategory | undefined {
  return OWNED_CATEGORIES.find((c) => c.key === key);
}

/** How the removal flow describes one target choice. */
export type ReassignTarget =
  | { kind: "user"; userId: string }
  | { kind: "team"; teamId: string }
  | { kind: "unassign" };

/**
 * Is this plan legal, before anything is written?
 *
 * Returns every problem rather than the first, because a removal flow that
 * reports one refusal at a time is a form somebody submits five times.
 */
export function validatePlan(
  counts: Record<string, number>,
  plan: Record<string, ReassignTarget | undefined>,
): string[] {
  const problems: string[] = [];
  for (const c of OWNED_CATEGORIES) {
    const n = counts[c.key] ?? 0;
    if (n === 0) continue;
    const target = plan[c.key];
    if (!target) {
      problems.push(`${c.label}: choose where these ${n} go.`);
      continue;
    }
    if (target.kind === "unassign" && !c.mayUnassign) {
      problems.push(
        `${c.label}: cannot be left unassigned — ${
          c.key === "deals"
            ? "an unowned open deal is money nobody is chasing"
            : c.key === "tasks"
              ? "an unassigned open task is work that has become nobody's"
              : "the record requires an owner"
        }.`,
      );
    }
  }
  return problems;
}
