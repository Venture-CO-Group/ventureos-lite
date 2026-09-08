import { prismaUnsafe } from "@/lib/db";
import { LIVE_STATES, isAssignable, isSeated } from "./lifecycle";

/**
 * Who is in this workspace, asked once (§1, §3, §5).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * Twenty places asked `membership.findMany` and each one decided for itself
 * what "a member" meant. Most said nothing at all — the task board's assignee
 * picker returned every membership row it could find, which now includes
 * suspended people, read-only client accounts, and (since §1) pending
 * invitations and ended memberships. Handing work to somebody who cannot sign
 * in is a task that never gets done, and nobody notices for a week.
 *
 * So there are three questions and three functions. The state module decides
 * which states qualify; this decides which ROLES do, which is the other half
 * the callers were missing.
 */

export interface MemberOption {
  id: string;
  name: string;
  email: string;
  role: string;
  state: string;
}

/**
 * People work can be given to.
 *
 * Excludes CLIENT on top of the state check: a read-only client account has no
 * tasks, cannot open the board, and appearing in an assignee dropdown is how
 * somebody's customer ends up owning a lead.
 */
export async function assignableMembers(workspaceId: string): Promise<MemberOption[]> {
  const rows = await prismaUnsafe.membership.findMany({
    where: { workspaceId, role: { not: "CLIENT" } },
    include: { user: { select: { id: true, name: true, email: true, deletedAt: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows
    .filter((m) => isAssignable(m.state) && !m.user.deletedAt)
    .map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      state: m.state,
    }));
}

/**
 * People who count as being in the workspace, for a list or a count.
 *
 * Wider than `assignableMembers`: a suspended person is still a member and
 * still owns their records, so a members screen that hid them would be hiding
 * the very rows somebody came to act on.
 */
export async function seatedMembers(workspaceId: string): Promise<MemberOption[]> {
  const rows = await prismaUnsafe.membership.findMany({
    where: { workspaceId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows
    .filter((m) => isSeated(m.state))
    .map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      state: m.state,
    }));
}

/**
 * Everybody the members screen shows, pending invitations included.
 *
 * The one place REMOVED is excluded by default rather than by state semantics:
 * a list that grows for ever with people who left is a list nobody reads. The
 * screen offers a filter to see them.
 */
export async function directoryMembers(
  workspaceId: string,
  opts: { includeRemoved?: boolean } = {},
): Promise<MemberOption[]> {
  const rows = await prismaUnsafe.membership.findMany({
    where: {
      workspaceId,
      ...(opts.includeRemoved ? {} : { state: { in: LIVE_STATES } }),
    },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    email: m.user.email,
    role: m.role,
    state: m.state,
  }));
}

/**
 * How many Owners this workspace still has who can actually sign in.
 *
 * Guards every path that could reduce that number to zero. A workspace with no
 * live Owner cannot grant a role, provision anything or restore itself, and
 * recovering one needs shell access to the server — which is not a support
 * process, it is an outage.
 */
export async function liveOwnerCount(
  workspaceId: string,
  excludeUserId?: string,
): Promise<number> {
  return prismaUnsafe.membership.count({
    where: {
      workspaceId,
      role: "OWNER",
      state: "ACTIVE",
      ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
    },
  });
}
