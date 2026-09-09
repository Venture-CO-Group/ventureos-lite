import { prismaUnsafe } from "@/lib/db";
import { OWNED_CATEGORIES, validatePlan, type ReassignTarget } from "./reassignment";
import { recordMemberEvent } from "./timeline";
import { liveOwnerCount } from "./directory";

/**
 * Removing somebody from a workspace (§4).
 *
 * ── WHY THIS IS A FLOW AND NOT A BUTTON ─────────────────────────────────────
 *
 * It is the dangerous action in this product, and it is dangerous in two
 * directions at once. Leave the records behind and open deals lose their owner
 * and fall out of every forecast, while a departed employee stays in assignee
 * pickers for ever. Reassign carelessly and a client's whole history changes
 * hands with no record of why.
 *
 * So: count what they hold, choose where each category goes, execute in ONE
 * transaction, and roll the lot back if any part of it fails. A half-applied
 * removal is the worst outcome available — some deals moved, some not, and
 * nobody able to say which.
 *
 * ── WHAT REMOVAL DOES NOT DO ────────────────────────────────────────────────
 *
 * It does not erase their footprint. `created by` stays, `Activity.byUserId`
 * stays, `Call.byUserId` stays, and the membership ROW survives in the REMOVED
 * state so the audit trail and the timeline still read. Removal ends access;
 * it does not rewrite what somebody did, and a call record that changes who
 * made it is a falsified record.
 */

export interface ImpactCounts {
  [key: string]: number;
}

export interface ImpactReport {
  userId: string;
  email: string;
  name: string;
  counts: ImpactCounts;
  /** Mail and calendar connections that will be disconnected. */
  mailAccounts: number;
  /** Total, so the confirmation can lead with one number. */
  total: number;
  /** They are the only Owner who can sign in — removal is refused. */
  isLastOwner: boolean;
}

/**
 * What this person is holding, counted per category.
 *
 * Reads `OWNED_CATEGORIES` rather than a hand-written list of queries, because
 * the report, the plan validator and the transaction must agree — and three
 * hand-written lists agree right up until somebody adds a table.
 */
export async function impactOf(
  workspaceId: string,
  userId: string,
): Promise<ImpactReport | null> {
  const membership = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    include: { user: { select: { email: true, name: true } } },
  });
  if (!membership) return null;

  const counts: ImpactCounts = {};
  for (const c of OWNED_CATEGORIES) {
    counts[c.key] = await countFor(workspaceId, userId, c.key);
  }
  const mailAccounts = await prismaUnsafe.mailAccount.count({ where: { userId } });

  return {
    userId,
    email: membership.user.email,
    name: membership.user.name,
    counts,
    mailAccounts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    isLastOwner:
      membership.role === "OWNER" && (await liveOwnerCount(workspaceId, userId)) === 0,
  };
}

/**
 * One category's count.
 *
 * A switch rather than a dynamic `db[model]` lookup: the model names come from
 * a const array, but indexing the Prisma client by string loses every type and
 * turns a typo into a runtime crash on the one screen that must not crash.
 */
async function countFor(workspaceId: string, userId: string, key: string): Promise<number> {
  switch (key) {
    case "leads":
      return prismaUnsafe.lead.count({ where: { workspaceId, ownerId: userId } });
    case "deals":
      return prismaUnsafe.deal.count({ where: { workspaceId, ownerId: userId, status: "OPEN" } });
    case "tasks":
      return prismaUnsafe.task.count({ where: { workspaceId, assigneeId: userId, doneAt: null } });
    case "meetings":
      return prismaUnsafe.meeting.count({
        where: { workspaceId, hostUserId: userId, scheduledAt: { gte: new Date() } },
      });
    case "bookingPages":
      return prismaUnsafe.bookingPage.count({ where: { workspaceId, hostUserId: userId } });
    case "savedViews":
      return prismaUnsafe.savedView.count({ where: { workspaceId, ownerId: userId } });
    case "contentPosts":
      return prismaUnsafe.contentPost.count({
        where: { workspaceId, authorUserId: userId, publishedAt: null },
      });
    default:
      return 0;
  }
}

export interface RemovalPlan {
  [categoryKey: string]: ReassignTarget | undefined;
}

/**
 * Resolve a target to the user id that will own the rows.
 *
 * A team resolves to its lead, or — failing that — to its first member. Not
 * round-robin: this is a one-off handover of somebody's book, and splitting a
 * departing person's twelve deals across four people is how each of them
 * assumes one of the others is handling it.
 */
async function resolveTarget(
  workspaceId: string,
  target: ReassignTarget,
): Promise<string | null | { error: string }> {
  if (target.kind === "unassign") return null;
  if (target.kind === "user") {
    const m = await prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId: target.userId, workspaceId } },
      select: { state: true, role: true },
    });
    if (!m || m.state !== "ACTIVE") {
      return { error: "The person you chose is not an active member." };
    }
    if (m.role === "CLIENT") {
      return { error: "A read-only client account cannot own work." };
    }
    return target.userId;
  }
  const members = await prismaUnsafe.teamMember.findMany({
    where: { workspaceId, teamId: target.teamId },
    orderBy: [{ isLead: "desc" }, { createdAt: "asc" }],
    select: { userId: true },
  });
  for (const candidate of members) {
    const m = await prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId: candidate.userId, workspaceId } },
      select: { state: true, role: true },
    });
    if (m?.state === "ACTIVE" && m.role !== "CLIENT") return candidate.userId;
  }
  return { error: "That team has nobody active on it to hand the work to." };
}

export interface RemovalResult {
  ok: true;
  moved: Record<string, number>;
}

/**
 * Execute the removal.
 *
 * ── ONE TRANSACTION, AND WHY ────────────────────────────────────────────────
 *
 * Every reassignment plus the membership change, together. If the fourth
 * category throws, the first three roll back and nothing has happened — which
 * is the only acceptable outcome, because the alternative is a workspace where
 * some of a departed person's deals moved and nobody can say which.
 *
 * The timeline entries are written AFTER the transaction commits, deliberately.
 * They are a record OF the change; writing them inside would mean a failure to
 * record could roll back a removal that was otherwise correct.
 */
export async function executeRemoval(input: {
  workspaceId: string;
  actorUserId: string;
  userId: string;
  plan: RemovalPlan;
  reason: string;
  disconnectMail: boolean;
  now?: Date;
}): Promise<RemovalResult | { ok: false; error: string; problems?: string[] }> {
  const now = input.now ?? new Date();
  const impact = await impactOf(input.workspaceId, input.userId);
  if (!impact) return { ok: false, error: "Not a member of this workspace." };

  if (input.userId === input.actorUserId) {
    return { ok: false, error: "You cannot remove yourself. Transfer ownership first." };
  }
  if (impact.isLastOwner) {
    return {
      ok: false,
      error:
        "This is the last Owner who can sign in. Transfer ownership to somebody else first.",
    };
  }
  if (!input.reason.trim()) {
    // Mandatory: removal is one of the three actions nobody should be able to
    // take silently.
    return { ok: false, error: "Say why. It goes on the record." };
  }

  const problems = validatePlan(impact.counts, input.plan);
  if (problems.length > 0) {
    return { ok: false, error: "The plan is not complete.", problems };
  }

  // Every target resolved BEFORE the transaction opens, so a bad choice is a
  // refusal rather than a rollback.
  const targets: Record<string, string | null> = {};
  for (const c of OWNED_CATEGORIES) {
    if ((impact.counts[c.key] ?? 0) === 0) continue;
    const target = input.plan[c.key]!;
    const resolved = await resolveTarget(input.workspaceId, target);
    if (resolved && typeof resolved === "object") {
      return { ok: false, error: `${c.label}: ${resolved.error}` };
    }
    targets[c.key] = resolved;
  }

  const moved: Record<string, number> = {};
  const { workspaceId, userId, actorUserId } = input;

  try {
    await prismaUnsafe.$transaction(async (tx) => {
      for (const c of OWNED_CATEGORIES) {
        const n = impact.counts[c.key] ?? 0;
        if (n === 0) continue;
        const to = targets[c.key] ?? null;

        switch (c.key) {
          case "leads":
            moved.leads = (
              await tx.lead.updateMany({
                where: { workspaceId, ownerId: userId },
                data: { ownerId: to },
              })
            ).count;
            break;
          case "deals":
            moved.deals = (
              await tx.deal.updateMany({
                where: { workspaceId, ownerId: userId, status: "OPEN" },
                data: { ownerId: to },
              })
            ).count;
            break;
          case "tasks":
            moved.tasks = (
              await tx.task.updateMany({
                where: { workspaceId, assigneeId: userId, doneAt: null },
                data: { assigneeId: to },
              })
            ).count;
            break;
          case "meetings":
            moved.meetings = (
              await tx.meeting.updateMany({
                where: { workspaceId, hostUserId: userId, scheduledAt: { gte: now } },
                data: { hostUserId: to },
              })
            ).count;
            break;
          case "bookingPages":
            if (!to) throw new Error("a booking page must have a host");
            moved.bookingPages = (
              await tx.bookingPage.updateMany({
                where: { workspaceId, hostUserId: userId },
                data: { hostUserId: to },
              })
            ).count;
            break;
          case "savedViews":
            if (!to) throw new Error("a saved view must have an owner");
            moved.savedViews = (
              await tx.savedView.updateMany({
                where: { workspaceId, ownerId: userId },
                data: { ownerId: to },
              })
            ).count;
            break;
          case "contentPosts":
            moved.contentPosts = (
              await tx.contentPost.updateMany({
                where: { workspaceId, authorUserId: userId, publishedAt: null },
                data: { authorUserId: to },
              })
            ).count;
            break;
        }
      }

      /**
       * Their mailbox and calendar.
       *
       * Disconnected, and the threads already synced STAY: they are
       * correspondence with a client, filed against a lead, and deleting them
       * because the person who synced them left would destroy the history the
       * inbox exists to keep. Nothing new arrives, which is the point.
       */
      if (input.disconnectMail) {
        await tx.mailAccount.deleteMany({ where: { userId } });
        await tx.googleCredential.deleteMany({ where: { userId } });
      }

      // The row survives in REMOVED. It is what keeps `created by` readable.
      await tx.membership.update({
        where: { userId_workspaceId: { userId, workspaceId } },
        data: {
          state: "REMOVED",
          removedAt: now,
          removedBy: actorUserId,
          suspendedAt: null,
          suspendedBy: null,
        },
      });
      // Team memberships go: they are an assignment target, and a departed
      // person on a team is a team that routes work to nobody.
      await tx.teamMember.deleteMany({ where: { workspaceId, userId } });
      /**
       * Their shortcuts go too (playbook-v5 P17/2).
       *
       * Recents and favourites are a record of what somebody was working on,
       * and that has no business surviving their access — the playbook asks
       * for exactly this. Inside the same transaction as the rest of the
       * removal, so a rollback leaves them intact along with everything else.
       */
      await tx.userPin.deleteMany({ where: { workspaceId, userId } });
    });
  } catch (e) {
    return {
      ok: false,
      error: `Nothing was changed — the reassignment failed and was rolled back: ${
        (e as Error).message
      }`,
    };
  }

  // Sessions after the commit: the membership is already REMOVED, so
  // `tryGetActiveContext` refuses them anyway — this closes the window.
  const { revokeAllUserSessions } = await import("@/lib/auth/sessions");
  const revoked = await revokeAllUserSessions(userId);

  await recordMemberEvent({
    workspaceId,
    userId,
    actorUserId,
    kind: "removed",
    reason: input.reason.trim(),
    before: { state: "ACTIVE" },
    after: { state: "REMOVED" },
    meta: { sessionsRevoked: revoked, disconnectedMail: input.disconnectMail },
  });
  if (Object.values(moved).some((n) => n > 0)) {
    await recordMemberEvent({
      workspaceId,
      userId,
      actorUserId,
      kind: "records_reassigned",
      reason: input.reason.trim(),
      after: moved,
      meta: { plan: input.plan },
    });
  }

  return { ok: true, moved };
}
