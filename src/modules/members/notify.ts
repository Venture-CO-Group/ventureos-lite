import { prismaUnsafe } from "@/lib/db";
import { safeDeliver } from "../notifications/notify";

/**
 * Telling an Owner that somebody accepted (§2).
 *
 * ── WHY THE INVITER AND NOT EVERY OWNER ─────────────────────────────────────
 *
 * The person who sent the invitation is the one waiting on it, and they are
 * the one who has to hand over whatever the new member is here to do. Mailing
 * every Owner would turn a two-person handover into a workspace announcement,
 * which is how a notification type gets switched off.
 *
 * Falls back to the Owners when the inviter has since left — an acceptance
 * nobody hears about is a person sitting in a workspace with nothing assigned.
 */
export async function notifyInvitationAccepted(input: {
  workspaceId: string;
  userId: string;
  inviterId: string | null;
}): Promise<void> {
  try {
    const joiner = await prismaUnsafe.user.findUnique({
      where: { id: input.userId },
      select: { name: true, email: true },
    });
    if (!joiner) return;

    let recipients: string[] = [];
    if (input.inviterId) {
      const inviter = await prismaUnsafe.membership.findUnique({
        where: { userId_workspaceId: { userId: input.inviterId, workspaceId: input.workspaceId } },
        select: { userId: true, state: true },
      });
      if (inviter?.state === "ACTIVE") recipients = [inviter.userId];
    }
    if (recipients.length === 0) {
      const owners = await prismaUnsafe.membership.findMany({
        where: { workspaceId: input.workspaceId, role: "OWNER", state: "ACTIVE" },
        select: { userId: true },
      });
      recipients = owners.map((o) => o.userId);
    }
    if (recipients.length === 0) return;

    await safeDeliver({
      workspaceId: input.workspaceId,
      userIds: recipients,
      // Reuses an existing type rather than adding a fourteenth: this IS an
      // escalation in the sense the type means — something that needs a person
      // to do the next thing.
      type: "escalation",
      title: `${joiner.name} joined the workspace`,
      body: `${joiner.email} accepted their invitation. Nothing is assigned to them yet.`,
      href: "/settings/admin/members",
      entityType: "User",
      entityId: input.userId,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[members] could not notify on acceptance", e);
  }
}
