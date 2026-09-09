import { prismaUnsafe } from "@/lib/db";
import { DOCUMENT_GRANTS, grantAllowed } from "@/lib/grants";
import { INVITE_TTL_DAYS, invitationState } from "./invitation-logic";
import { DORMANT_DAYS, type AccessReview, type ReviewRow } from "./review-logic";

/**
 * The three lists an auditor asks for (§7).
 *
 * ── WHY THESE THREE AND NOT A DASHBOARD ─────────────────────────────────────
 *
 * Every access review, in every organisation, opens with the same three
 * questions: who has access they are not using, who holds the powerful
 * capabilities, and what invitations are outstanding. Anything else is a
 * report somebody builds once and never reads.
 *
 * ── THEY ARE FINDINGS, NOT FAILURES ────────────────────────────────────────
 *
 * A dormant account is not necessarily wrong — somebody may be on leave — and
 * a person holding `documents.send` is doing their job. The lists exist so a
 * human decides, which is why each row carries the fact that prompted it
 * rather than a verdict.
 *
 * The row shapes and `DORMANT_DAYS` live in `review-logic.ts` so the panel can
 * read them without pulling this file's Prisma import into the browser.
 */
export { DORMANT_DAYS } from "./review-logic";
export type { AccessReview, ReviewRow } from "./review-logic";

export async function accessReview(
  workspaceId: string,
  now: Date = new Date(),
): Promise<AccessReview> {
  const memberships = await prismaUnsafe.membership.findMany({
    where: { workspaceId, state: { in: ["ACTIVE", "SUSPENDED"] } },
    include: { user: { select: { id: true, name: true, email: true, lastLoginAt: true } } },
  });

  const dormantCutoff = new Date(now.getTime() - DORMANT_DAYS * 86_400_000);
  const dormant: ReviewRow[] = [];
  const documentHolders: ReviewRow[] = [];

  for (const m of memberships) {
    const base = {
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      state: m.state,
    };

    const last = m.user.lastLoginAt;
    if (!last) {
      // Never signed in at all. Different from dormant and worth saying so:
      // an account nobody has ever used is usually one nobody needed.
      dormant.push({ ...base, detail: "has never signed in" });
    } else if (last.getTime() < dormantCutoff.getTime()) {
      const days = Math.floor((now.getTime() - last.getTime()) / 86_400_000);
      dormant.push({ ...base, detail: `last signed in ${days} days ago` });
    }

    /**
     * Who holds the capabilities that bind the company.
     *
     * Resolved through `grantAllowed` rather than by reading the grants array,
     * because a role carries some of these implicitly — and a list that only
     * showed explicit grants would miss every Admin, which is exactly the set
     * an auditor is asking about.
     */
    const grants = Array.isArray(m.grants) ? (m.grants as string[]) : [];
    const held = DOCUMENT_GRANTS.filter((g) => grantAllowed(m.role, grants, g));
    if (held.length > 0) {
      documentHolders.push({
        ...base,
        detail:
          held.length === DOCUMENT_GRANTS.length
            ? "all document capabilities"
            : held.join(", "),
      });
    }
  }

  const invitations = await prismaUnsafe.invitation.findMany({
    where: { workspaceId, acceptedAt: null, revokedAt: null },
    orderBy: { createdAt: "asc" },
  });
  const staleInvitations = invitations
    .filter((i) => i.createdAt.getTime() < now.getTime() - INVITE_TTL_DAYS * 86_400_000)
    .map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      detail: `${invitationState(i, now)}, sent ${Math.floor(
        (now.getTime() - i.createdAt.getTime()) / 86_400_000,
      )} days ago`,
    }));

  return {
    dormant,
    documentHolders,
    staleInvitations,
    clean: dormant.length === 0 && staleInvitations.length === 0,
  };
}

/**
 * Everything the system holds about somebody AS A USER (§7).
 *
 * ── HOW THIS DIFFERS FROM A PROSPECT'S DATA, AND WHY IT MATTERS ─────────────
 *
 * A lead is a data subject we hold data about for a commercial purpose, under
 * a legitimate-interest basis, with a retention window and an erasure right
 * that cascades to everything derived from them. An employee is a data subject
 * we hold data about because they work here — a different basis, a different
 * retention period (employment records outlive an engagement), and a different
 * erasure story: their AUTHORSHIP of work records is not their personal data
 * to erase, it is the company's record of what happened.
 *
 * That is why removing somebody keeps `created by` and why the lead-erasure
 * path is not reused here. This export is the subject-access half — what we
 * hold about them as a person — and it deliberately does NOT include the leads
 * they worked, because those are somebody else's personal data.
 */
export interface EmployeeExport {
  generatedAt: string;
  user: Record<string, unknown>;
  memberships: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  timeline: Record<string, unknown>[];
  notificationPreferences: Record<string, unknown>[];
  teams: Record<string, unknown>[];
  /** Counts only — the records themselves are other people's data. */
  workCounts: Record<string, number>;
}

export async function employeeExport(
  workspaceId: string,
  userId: string,
): Promise<EmployeeExport | null> {
  const user = await prismaUnsafe.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      jobTitle: true,
      phone: true,
      timezone: true,
      locale: true,
      avatarPath: true,
      totpEnabled: true,
      lastLoginAt: true,
      createdAt: true,
      deletedAt: true,
    },
  });
  if (!user) return null;

  const [memberships, sessions, timeline, prefs, teams] = await Promise.all([
    prismaUnsafe.membership.findMany({
      where: { userId },
      select: {
        workspaceId: true,
        role: true,
        state: true,
        grants: true,
        createdAt: true,
        suspendedAt: true,
        removedAt: true,
      },
    }),
    prismaUnsafe.session.findMany({
      where: { userId },
      // No tokens, not even hashed: an export somebody can be handed must not
      // contain a credential, and a hash is still a credential's shadow.
      select: { ip: true, userAgent: true, createdAt: true, lastSeenAt: true, revokedAt: true },
    }),
    prismaUnsafe.membershipEvent.findMany({
      where: { userId },
      orderBy: { at: "asc" },
      select: { kind: true, reason: true, before: true, after: true, at: true },
    }),
    prismaUnsafe.notificationPreference.findMany({
      where: { userId },
      select: { type: true, inApp: true, push: true, emailDigest: true, emailNow: true },
    }),
    prismaUnsafe.teamMember.findMany({
      where: { userId },
      include: { team: { select: { name: true } } },
    }),
  ]);

  const [leads, deals, tasks] = await Promise.all([
    prismaUnsafe.lead.count({ where: { workspaceId, ownerId: userId } }),
    prismaUnsafe.deal.count({ where: { workspaceId, ownerId: userId } }),
    prismaUnsafe.task.count({ where: { workspaceId, assigneeId: userId } }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    user: user as unknown as Record<string, unknown>,
    memberships: memberships as unknown as Record<string, unknown>[],
    sessions: sessions as unknown as Record<string, unknown>[],
    timeline: timeline as unknown as Record<string, unknown>[],
    notificationPreferences: prefs as unknown as Record<string, unknown>[],
    teams: teams.map((t) => ({ team: t.team.name, isLead: t.isLead, since: t.createdAt })),
    /**
     * Counts, never contents.
     *
     * The leads they owned are other people's personal data. Handing an
     * employee a file containing four hundred prospects' names and phone
     * numbers because they asked what we hold about THEM would be a breach
     * dressed as a subject-access response.
     */
    workCounts: { leadsOwned: leads, dealsOwned: deals, tasksAssigned: tasks },
  };
}
