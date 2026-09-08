"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import {
  NOTIFICATION_TYPE_DEFS,
  isNotificationType,
  resolveChannels,
  visibleTypesFor,
  type Channels,
} from "./types";
import {
  countSubscriptions,
  publicVapidKey,
  removeSubscription,
  saveSubscription,
  vapidConfigured,
} from "./push";
import { isTrustedMember } from "@/lib/grants";

/**
 * The preference matrix and push registration (playbook-v2 P6/1).
 */

export interface PreferenceRow extends Channels {
  type: string;
  label: string;
  description: string;
}

export interface PreferenceMatrix {
  rows: PreferenceRow[];
  /** VAPID keys are configured on the server — without them push is unavailable. */
  pushAvailable: boolean;
  vapidPublicKey: string | null;
  /** Devices this user has registered in this workspace. */
  devices: number;
}

async function roleOf(userId: string, workspaceId: string): Promise<string> {
  const membership = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true },
  });
  return membership?.role ?? "BDR";
}

export async function getNotificationPreferences(): Promise<PreferenceMatrix> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const [stored, role, devices] = await Promise.all([
    db.notificationPreference.findMany({
      where: { userId },
      select: { type: true, inApp: true, push: true, emailDigest: true, emailNow: true },
    }),
    roleOf(userId, workspaceId),
    countSubscriptions(workspaceId, userId),
  ]);
  const byType = new Map(stored.map((s) => [s.type, s]));

  // Only the types this role may receive — a BDR is not shown a switch for a
  // notification they can never be sent.
  const rows = visibleTypesFor(role).map((type) => {
    const row = byType.get(type);
    const channels = resolveChannels(
      type,
      row
        ? {
            inApp: row.inApp,
            push: row.push,
            emailDigest: row.emailDigest,
            emailNow: row.emailNow,
          }
        : null,
      role,
    );
    return {
      type,
      label: NOTIFICATION_TYPE_DEFS[type].label,
      description: NOTIFICATION_TYPE_DEFS[type].description,
      ...channels,
    };
  });

  return {
    rows,
    pushAvailable: vapidConfigured(),
    vapidPublicKey: publicVapidKey(),
    devices,
  };
}

const setSchema = z.object({
  type: z.string(),
  channel: z.enum(["inApp", "push", "emailDigest", "emailNow"]),
  value: z.boolean(),
});

export async function setNotificationPreference(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = setSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown preference." };
  const { type, channel, value } = parsed.data;
  if (!isNotificationType(type)) return { ok: false, error: "Unknown notification type." };

  const { workspaceId, userId } = await getActiveContext();
  const role = await roleOf(userId, workspaceId);
  // A BDR cannot switch on a type they may not receive — the resolver would
  // silence it anyway, and an switch that does nothing is worse than no switch.
  if (NOTIFICATION_TYPE_DEFS[type].ownerOnly && !isTrustedMember(role)) {
    return { ok: false, error: "That notification is Owner-only." };
  }

  const db = getWorkspaceClient(workspaceId);
  const current = await db.notificationPreference.findFirst({
    where: { userId, type },
    select: { inApp: true, push: true, emailDigest: true, emailNow: true },
  });
  // The row is written from the RESOLVED state, not from defaults, so flipping
  // one switch cannot silently reset the other two.
  const base = resolveChannels(type, current, role);
  const next: Channels = { ...base, [channel]: value };

  await db.notificationPreference.upsert({
    where: { workspaceId_userId_type: { workspaceId, userId, type } },
    create: { workspaceId, userId, type, ...next },
    update: next,
  });

  revalidatePath("/settings");
  return { ok: true };
}

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  p256dh: z.string().min(1).max(500),
  auth: z.string().min(1).max(500),
  userAgent: z.string().max(400).optional(),
});

export async function registerPushDevice(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = subscribeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That subscription could not be stored." };
  if (!vapidConfigured()) return { ok: false, error: "Push is not configured on this server." };

  const { workspaceId, userId } = await getActiveContext();
  await saveSubscription(workspaceId, userId, parsed.data);
  revalidatePath("/settings");
  return { ok: true };
}

export async function unregisterPushDevice(
  endpoint: string,
): Promise<{ ok: true }> {
  // No workspace check: the endpoint IS the secret, and a user unsubscribing a
  // device they hold is always allowed.
  await getActiveContext();
  await removeSubscription(endpoint);
  revalidatePath("/settings");
  return { ok: true };
}
