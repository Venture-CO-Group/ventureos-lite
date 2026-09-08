import { prismaUnsafe } from "@/lib/db";

/**
 * Teams (§5).
 *
 * ── TEAMS GRANT NOTHING, AND THIS IS WHERE THAT IS ENFORCED ─────────────────
 *
 * There is no permission logic in this file and there must never be. Authority
 * stays role + grant, resolved by `src/lib/grants.ts` and nothing else. A team
 * that could carry capabilities would be a SECOND authorization system running
 * beside the first, and the two would answer differently the first time
 * somebody was in two teams — at which point "why can Anna do that" stops
 * having an answer anybody can give.
 *
 * What a team gives instead: an assignment target, a filter, a grouping for
 * analytics, a notification route, and a page showing who is on it and how
 * much is on their plates.
 */

export interface TeamMemberView {
  userId: string;
  name: string;
  email: string;
  isLead: boolean;
  /** What they are carrying, so the team page answers "who is swamped". */
  openTasks: number;
  openDeals: number;
}

export interface TeamView {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  archivedAt: string | null;
  members: TeamMemberView[];
}

export async function listTeams(workspaceId: string): Promise<TeamView[]> {
  const teams = await prismaUnsafe.team.findMany({
    where: { workspaceId },
    orderBy: [{ archivedAt: "asc" }, { name: "asc" }],
    include: { members: true },
  });
  if (teams.length === 0) return [];

  const userIds = [...new Set(teams.flatMap((t) => t.members.map((m) => m.userId)))];
  const [users, taskCounts, dealCounts] = await Promise.all([
    userIds.length
      ? prismaUnsafe.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        })
      : Promise.resolve([]),
    /**
     * Workload, grouped once rather than per member.
     *
     * The obvious shape is a count inside the member loop, which on four teams
     * of six is forty-eight queries for a panel nobody thinks of as expensive.
     */
    prismaUnsafe.task.groupBy({
      where: { workspaceId, doneAt: null, assigneeId: { in: userIds } },
      by: ["assigneeId"],
      _count: { _all: true },
    }),
    prismaUnsafe.deal.groupBy({
      where: { workspaceId, status: "OPEN", ownerId: { in: userIds } },
      by: ["ownerId"],
      _count: { _all: true },
    }),
  ]);

  const byId = new Map(users.map((u) => [u.id, u]));
  const tasksBy = new Map(
    taskCounts
      .filter((t) => t.assigneeId)
      .map((t) => [t.assigneeId as string, t._count._all] as const),
  );
  const dealsBy = new Map(
    dealCounts.filter((d) => d.ownerId).map((d) => [d.ownerId as string, d._count._all] as const),
  );

  return teams.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    color: t.color,
    archivedAt: t.archivedAt?.toISOString() ?? null,
    members: t.members
      .map((m) => {
        const u = byId.get(m.userId);
        return {
          userId: m.userId,
          name: u?.name ?? "—",
          email: u?.email ?? "—",
          isLead: m.isLead,
          openTasks: tasksBy.get(m.userId) ?? 0,
          openDeals: dealsBy.get(m.userId) ?? 0,
        };
      })
      // Lead first, then by name: the person you escalate to is the one you
      // look for.
      .sort((a, b) =>
        a.isLead === b.isLead ? a.name.localeCompare(b.name, "hu") : a.isLead ? -1 : 1,
      ),
  }));
}

/**
 * What still points at this team, before it can be deleted (§5).
 *
 * Same pattern as removing a member, and for the same reason: deleting a team
 * that is somebody's escalation route or a workflow rule's target would leave
 * those pointing at nothing, silently.
 *
 * Only the members are counted today, because a team is not yet the OWNER of
 * anything — assignments resolve a team to a person at the moment of
 * assignment rather than storing the team on the row. When that changes, this
 * is the function that grows.
 */
export interface TeamImpact {
  members: number;
  canDelete: boolean;
  reason: string | null;
}

export async function teamImpact(workspaceId: string, teamId: string): Promise<TeamImpact> {
  const members = await prismaUnsafe.teamMember.count({ where: { workspaceId, teamId } });
  return {
    members,
    canDelete: members === 0,
    reason:
      members > 0
        ? `${members} ${members === 1 ? "person is" : "people are"} on it. Take them off first, or archive the team instead.`
        : null,
  };
}

/**
 * Who a team hands work to, round-robin (§5).
 *
 * ── WHY ROUND-ROBIN HERE AND THE LEAD IN A REMOVAL ──────────────────────────
 *
 * Two different jobs. Assigning ONE new thing to a team should spread the load,
 * so this picks whoever currently has the fewest open tasks. Handing over a
 * departing person's whole book should not: splitting twelve deals across four
 * people is how each of them assumes one of the others is handling it, which is
 * why `removal.ts` resolves a team to its lead instead.
 *
 * Ties break on the person who has been on the team longest, so the answer is
 * stable rather than arbitrary.
 */
export async function roundRobinPick(
  workspaceId: string,
  teamId: string,
): Promise<string | null> {
  const members = await prismaUnsafe.teamMember.findMany({
    where: { workspaceId, teamId },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  if (members.length === 0) return null;

  const eligible: string[] = [];
  for (const m of members) {
    const membership = await prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId: m.userId, workspaceId } },
      select: { state: true, role: true },
    });
    // Only somebody who can actually pick the work up.
    if (membership?.state === "ACTIVE" && membership.role !== "CLIENT") {
      eligible.push(m.userId);
    }
  }
  if (eligible.length === 0) return null;

  const counts = await prismaUnsafe.task.groupBy({
    where: { workspaceId, doneAt: null, assigneeId: { in: eligible } },
    by: ["assigneeId"],
    _count: { _all: true },
  });
  const load = new Map(
    counts.filter((c) => c.assigneeId).map((c) => [c.assigneeId as string, c._count._all] as const),
  );
  // `eligible` is already in join order, so the reduce below keeps the earliest
  // member on a tie.
  return eligible.reduce((best, id) =>
    (load.get(id) ?? 0) < (load.get(best) ?? 0) ? id : best,
  );
}
