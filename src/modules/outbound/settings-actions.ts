"use server";

import { revalidatePath } from "next/cache";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { isOwner } from "@/lib/authz";
import { COLD_OUTBOUND_ADDRESS, outboundConfigSchema, parseOutboundConfig, warmupDailyCap, type OutboundConfig } from "./config";
import { quotaMeter, type QuotaMeter } from "@/modules/registry/registry-service";

/**
 * Outbound motor settings (playbook-v6): registry quota, nightly schedule,
 * workspace cap, warm-up ramp, sending guardrails, follow-up offsets.
 *
 * Owner-only: every one of these decides how much quota, Claude budget and
 * mailbox reputation the motor may spend without anybody clicking.
 */
export interface MailboxStatus {
  address: string;
  connected: boolean;
  health: string | null;
  connectedBy: string | null;
  sendCapToday: number;
  sentToday: number;
  signatureFetchedAt: string | null;
}

export async function getOutboundSettings(): Promise<{ config: OutboundConfig; meter: QuotaMeter; mailbox: MailboxStatus }> {
  const { workspaceId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { outboundConfig: true } });
  const config = parseOutboundConfig(ws?.outboundConfig);
  const account = await prismaUnsafe.mailAccount.findFirst({
    where: { workspaceId, accountEmail: COLD_OUTBOUND_ADDRESS },
    select: { health: true, userId: true, credentialId: true },
  });
  const user = account ? await prismaUnsafe.user.findUnique({ where: { id: account.userId }, select: { name: true } }) : null;
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sentToday = await getWorkspaceClient(workspaceId).outreachDraft.count({ where: { status: "SENT", sentAt: { gte: start } } });
  return {
    config,
    meter: await quotaMeter(workspaceId),
    mailbox: {
      address: COLD_OUTBOUND_ADDRESS,
      connected: !!account?.credentialId && account.health !== "reconnect_needed",
      health: account?.health ?? null,
      connectedBy: user?.name ?? null,
      sendCapToday: warmupDailyCap(config.warmup, now),
      sentToday,
      signatureFetchedAt: config.sending.signatureFetchedAt,
    },
  };
}

/** Clear a circuit-breaker pause. Owner-only and audit-logged: it re-opens a mailbox that was bouncing. */
export async function resumeSending(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await isOwner())) return { ok: false, error: "Only an Owner can resume outbound sending." };
  const { workspaceId, userId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { outboundConfig: true } });
  const cfg = parseOutboundConfig(ws?.outboundConfig);
  if (!cfg.sending.pausedAt) return { ok: true };
  await prismaUnsafe.workspace.update({
    where: { id: workspaceId },
    data: { outboundConfig: { ...cfg, sending: { ...cfg.sending, pausedAt: null, pausedReason: null } } },
  });
  await getWorkspaceClient(workspaceId).auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "outbound.sending.resumed",
      entityType: "Workspace",
      entityId: workspaceId,
      meta: { pausedAt: cfg.sending.pausedAt, reason: cfg.sending.pausedReason },
    },
  });
  revalidatePath("/settings/admin/outbound");
  return { ok: true };
}

export async function saveOutboundSettings(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await isOwner())) return { ok: false, error: "Only an Owner can change outbound settings." };
  const parsed = outboundConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, error: i ? `${i.path.join(".")}: ${i.message}` : "Invalid settings." };
  }
  const next = parsed.data;
  if (next.sending.spacingMinSec > next.sending.spacingMaxSec) {
    return { ok: false, error: "The minimum gap between sends is longer than the maximum." };
  }
  if (next.sending.windowStartHour >= next.sending.windowEndHour) {
    return { ok: false, error: "The sending window ends before it starts." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { outboundConfig: true } });
  const before = parseOutboundConfig(ws?.outboundConfig);

  // Ramp start dates and the circuit breaker's state are the system's to set,
  // not the form's: a stale tab must not restart a warm-up or clear a pause.
  const merged: OutboundConfig = {
    ...next,
    cap: { ...next.cap, startedAt: before.cap.startedAt },
    warmup: { ...next.warmup, startedAt: before.warmup.startedAt },
    sending: {
      ...next.sending,
      mailAccountId: before.sending.mailAccountId,
      cachedSignature: before.sending.cachedSignature,
      signatureFetchedAt: before.sending.signatureFetchedAt,
      pausedAt: before.sending.pausedAt,
      pausedReason: before.sending.pausedReason,
    },
  };
  await prismaUnsafe.workspace.update({ where: { id: workspaceId }, data: { outboundConfig: merged } });
  await getWorkspaceClient(workspaceId).auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "outbound.settings.updated",
      entityType: "Workspace",
      entityId: workspaceId,
      meta: { before, after: merged } as object,
    },
  });
  revalidatePath("/settings/admin/outbound");
  return { ok: true };
}
