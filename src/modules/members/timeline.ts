import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { isMembershipEventKind, type MembershipEventKind } from "./events";

/**
 * Writing to a membership's timeline, and to the audit log, together (§1).
 *
 * ── WHY BOTH, EVERY TIME ────────────────────────────────────────────────────
 *
 * The ground rules for this whole section say every mutation writes an
 * AuditLog entry with actor, subject, before/after and reason. They also say a
 * member's drawer shows their own history as a timeline. Those are two
 * different reads of the same fact, and asking each mutation to remember both
 * is asking for the day one of them writes only half.
 *
 * So there is one function. It cannot write a timeline entry without an audit
 * entry, which is the property that matters.
 *
 * ── IT NEVER BREAKS THE MUTATION ────────────────────────────────────────────
 *
 * ...with one exception, stated because it is a real trade-off. A failure to
 * record is logged and swallowed, because a role change that succeeded and
 * then threw on its own bookkeeping would leave the caller believing it
 * failed — and they would do it again. The audit trail is a record OF the
 * change, not a precondition for it.
 */
export async function recordMemberEvent(input: {
  workspaceId: string;
  /** The person this happened to. */
  userId: string;
  actorUserId: string | null;
  kind: MembershipEventKind;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  /** Extra context for the audit log's `meta`, beyond before/after. */
  meta?: Record<string, unknown>;
}): Promise<void> {
  if (!isMembershipEventKind(input.kind)) return;
  try {
    const db = getWorkspaceClient(input.workspaceId);
    const subject = await prismaUnsafe.user.findUnique({
      where: { id: input.userId },
      select: { email: true },
    });

    await db.membershipEvent.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        actorUserId: input.actorUserId,
        kind: input.kind,
        reason: input.reason ?? null,
        before: (input.before ?? null) as never,
        after: (input.after ?? null) as never,
      },
    });

    await db.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        // Prefixed so the audit log's "access and permissions" category picks
        // it up without a new prefix per kind.
        action: `member.${input.kind}`,
        entityType: "User",
        entityId: input.userId,
        meta: {
          email: subject?.email ?? null,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.before !== undefined ? { before: input.before } : {}),
          ...(input.after !== undefined ? { after: input.after } : {}),
          ...(input.meta ?? {}),
        } as never,
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[members] could not record ${input.kind}`, e);
  }
}

/** One person's history, newest first, for the detail drawer. */
export interface TimelineEntry {
  id: string;
  kind: string;
  actorName: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  at: string;
}

export async function memberTimeline(
  workspaceId: string,
  userId: string,
  limit = 100,
): Promise<TimelineEntry[]> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.membershipEvent.findMany({
    where: { userId },
    orderBy: { at: "desc" },
    take: limit,
  });
  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((v): v is string => !!v))];
  const actors = actorIds.length
    ? await prismaUnsafe.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true },
      })
    : [];
  // Resolved to a name: a timeline whose actor column holds cuids answers
  // "somebody" to every question worth asking.
  const byId = new Map(actors.map((a) => [a.id, a.name]));

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    actorName: r.actorUserId ? (byId.get(r.actorUserId) ?? "somebody who has left") : null,
    reason: r.reason,
    before: r.before,
    after: r.after,
    at: r.at.toISOString(),
  }));
}
