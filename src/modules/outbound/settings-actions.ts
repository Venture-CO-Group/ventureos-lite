"use server";

import { revalidatePath } from "next/cache";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { isOwner } from "@/lib/authz";
import { outboundConfigSchema, parseOutboundConfig, type OutboundConfig } from "./config";
import { quotaMeter, type QuotaMeter } from "@/modules/registry/registry-service";

/**
 * Outbound motor settings (playbook-v6): registry quota, nightly schedule,
 * workspace cap, warm-up ramp, sending guardrails, follow-up offsets.
 *
 * Owner-only: every one of these decides how much quota, Claude budget and
 * mailbox reputation the motor may spend without anybody clicking.
 */
export async function getOutboundSettings(): Promise<{ config: OutboundConfig; meter: QuotaMeter }> {
  const { workspaceId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { outboundConfig: true } });
  return { config: parseOutboundConfig(ws?.outboundConfig), meter: await quotaMeter(workspaceId) };
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
