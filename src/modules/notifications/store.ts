/**
 * Reading and writing notifications (playbook-v2 P6/1).
 *
 * Takes workspace and user explicitly rather than resolving a session, so the
 * rules are provable against a real database and so BACKGROUND JOBS can deliver
 * — most notifications originate in the worker, where there is no request and
 * therefore no session to read.
 *
 * Delivery decides nothing itself: `types.ts` owns which channels a person gets
 * for a type, and this module applies that answer.
 */

import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import {
  dedupeKeyFor,
  isNotificationType,
  resolveChannels,
  type NotificationType,
} from "./types";

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  href: string;
  entityType: string | null;
  entityId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

const VIEW_SELECT = {
  id: true,
  type: true,
  title: true,
  body: true,
  href: true,
  entityType: true,
  entityId: true,
  readAt: true,
  createdAt: true,
} as const;

/** How many the bell panel holds. Nobody scrolls a bell. */
export const BELL_LIMIT = 20;

export interface DeliverInput {
  workspaceId: string;
  /** Everyone who should hear about it; filtered by membership and preference. */
  userIds: string[];
  type: NotificationType;
  title: string;
  body?: string | null;
  /** Where clicking it goes. */
  href: string;
  entityType?: string | null;
  entityId?: string | null;
  /** Lets a legitimately recurring event notify again — see dedupeKeyFor(). */
  discriminator?: string;
}

export interface DeliverResult {
  created: number;
  /**
   * Recipients whose immediate-email channel is on for this type (P8/2).
   *
   * Returned rather than mailed, for exactly the reason `pushUserIds` is:
   * this store stays free of network I/O so it can be tested against a
   * database without a mail provider. `safeDeliver` does the sending.
   */
  emailUserIds: string[];
  /**
   * Recipients whose push channel is on. Returned rather than pushed to,
   * because the store must stay free of network I/O to be testable — the
   * caller (or the push module) decides whether to actually send.
   */
  pushUserIds: string[];
}

/**
 * Create the in-app notifications for one event.
 *
 * Silently drops recipients who are not members of the workspace: a stale user
 * id in a job payload is not a reason to fail an event that already happened.
 */
export async function deliverNotification(input: DeliverInput): Promise<DeliverResult> {
  const NOTHING: DeliverResult = { created: 0, pushUserIds: [], emailUserIds: [] };
  if (!isNotificationType(input.type)) return NOTHING;
  const userIds = [...new Set(input.userIds)].filter(Boolean);
  if (userIds.length === 0) return NOTHING;

  // Membership carries the role, and the role decides Owner-only types.
  const memberships = await prismaUnsafe.membership.findMany({
    where: { workspaceId: input.workspaceId, userId: { in: userIds } },
    select: { userId: true, role: true },
  });
  if (memberships.length === 0) return NOTHING;

  const db = getWorkspaceClient(input.workspaceId);
  const prefs = await db.notificationPreference.findMany({
    where: { userId: { in: memberships.map((m) => m.userId) }, type: input.type },
    select: { userId: true, inApp: true, push: true, emailDigest: true, emailNow: true },
  });
  const prefByUser = new Map(prefs.map((p) => [p.userId, p]));

  const dedupeKey = dedupeKeyFor(input.type, input.entityId ?? "", input.discriminator);
  let created = 0;
  const pushUserIds: string[] = [];
  const emailUserIds: string[] = [];

  for (const membership of memberships) {
    const stored = prefByUser.get(membership.userId);
    const channels = resolveChannels(
      input.type,
      stored
        ? {
            inApp: stored.inApp,
            push: stored.push,
            emailDigest: stored.emailDigest,
            emailNow: stored.emailNow,
          }
        : null,
      membership.role,
    );
    if (channels.push) pushUserIds.push(membership.userId);
    if (channels.emailNow) emailUserIds.push(membership.userId);
    if (!channels.inApp) continue;

    // The unique index is what actually enforces once-only; this is the
    // ordinary path and the catch is the concurrent one.
    try {
      await db.notification.create({
        data: {
          workspaceId: input.workspaceId,
          userId: membership.userId,
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          href: input.href,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          dedupeKey,
        },
      });
      created += 1;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "P2002") throw e;
      // Already delivered — the point of the key.
    }
  }

  return { created, pushUserIds, emailUserIds };
}

export async function listNotifications(
  workspaceId: string,
  userId: string,
  opts: { limit?: number; unreadOnly?: boolean } = {},
): Promise<NotificationView[]> {
  const db = getWorkspaceClient(workspaceId);
  return db.notification.findMany({
    where: { userId, ...(opts.unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? BELL_LIMIT,
    select: VIEW_SELECT,
  });
}

export async function unreadCount(workspaceId: string, userId: string): Promise<number> {
  const db = getWorkspaceClient(workspaceId);
  return db.notification.count({ where: { userId, readAt: null } });
}

/**
 * Mark specific notifications read.
 *
 * Scoped to the acting user as well as the workspace, so one person cannot
 * clear another's bell by passing ids — the guarded client stops the tenant
 * crossing, and the userId in the WHERE stops the within-tenant one.
 */
export async function markRead(
  workspaceId: string,
  userId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const db = getWorkspaceClient(workspaceId);
  const result = await db.notification.updateMany({
    where: { id: { in: ids }, userId, readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}

export async function markAllRead(workspaceId: string, userId: string): Promise<number> {
  const db = getWorkspaceClient(workspaceId);
  const result = await db.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}

/**
 * 90-day retention (playbook P6/1).
 *
 * Cross-workspace by design — it is a maintenance sweep over the whole table,
 * exactly like the anonymization and log-retention jobs, so it uses the
 * unguarded client deliberately rather than by omission.
 */
export async function purgeExpiredNotifications(cutoff: Date): Promise<number> {
  const result = await prismaUnsafe.notification.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return result.count;
}
