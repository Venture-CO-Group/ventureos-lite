/**
 * The email channel (playbook-v2 P6/1).
 *
 * "Email" in the preference matrix does NOT mean a message per notification —
 * the playbook says so in as many words: *email fallback batches into the
 * existing digests rather than sending per-event mail*. So there is no mailer
 * here. This counts the unread notifications whose type the user has left
 * switched on for email, and the Monday digest renders that as one line.
 */

import type { WorkspaceClient } from "@/lib/db";
import { resolveChannels, type NotificationType } from "./types";

/**
 * How many unread notifications this user would want mentioned in their digest.
 *
 * Preferences are resolved per type rather than filtered in SQL because the
 * default for a type with no stored row lives in code, not in the database —
 * a query could only see the rows that exist.
 */
export async function countDigestableUnread(
  db: WorkspaceClient,
  userId: string,
  role: string,
): Promise<number> {
  const [unread, prefs] = await Promise.all([
    db.notification.groupBy({
      by: ["type"],
      where: { userId, readAt: null },
      _count: { _all: true },
    }),
    db.notificationPreference.findMany({
      where: { userId },
      select: { type: true, inApp: true, push: true, emailDigest: true, emailNow: true },
    }),
  ]);

  const byType = new Map(prefs.map((p) => [p.type, p]));
  let total = 0;
  for (const row of unread) {
    const stored = byType.get(row.type);
    const channels = resolveChannels(
      row.type as NotificationType,
      stored
        ? {
            inApp: stored.inApp,
            push: stored.push,
            emailDigest: stored.emailDigest,
            emailNow: stored.emailNow,
          }
        : null,
      role,
    );
    if (channels.emailDigest) total += row._count._all;
  }
  return total;
}
