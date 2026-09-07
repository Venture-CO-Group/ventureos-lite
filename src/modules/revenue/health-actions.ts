"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";
import { DEFAULT_HEALTH_RULES, healthRulesFrom, type HealthRules } from "./health";
import { loadClientHealth } from "./health-data";

/**
 * The support flag, the health thresholds, and turning a red client into a task
 * (playbook-v3 P11/1c).
 */

export async function setSupportFlag(
  companyId: string,
  open: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const company = await db.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!company) return { ok: false, error: "Company not found." };
  await db.company.update({ where: { id: companyId }, data: { supportFlag: open } });
  revalidatePath("/analytics");
  return { ok: true };
}

const rulesSchema = z.object({
  paymentLateAmberDays: z.number().positive().optional(),
  paymentLateRedDays: z.number().positive().optional(),
  quietAmberMonths: z.number().positive().optional(),
  quietRedMonths: z.number().positive().optional(),
  youngClientMonths: z.number().positive().optional(),
});

export async function getHealthRules(): Promise<HealthRules> {
  const { workspaceId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { featureFlags: true },
  });
  const flags = (ws?.featureFlags ?? {}) as Record<string, unknown>;
  return healthRulesFrom(flags.clientHealth);
}

/**
 * Owner-only: the thresholds decide who appears on a list the whole team acts
 * on, and loosening them quietly is how a health score stops meaning anything.
 */
export async function saveHealthRules(
  raw: unknown,
): Promise<{ ok: true; rules: HealthRules } | { ok: false; error: string }> {
  const parsed = rulesSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Every threshold must be a positive number." };
  try {
    await requireGrant("settings.manage");
  } catch {
    return { ok: false, error: "Only an Owner can change the health rules." };
  }

  const { workspaceId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { featureFlags: true },
  });
  const flags = (ws?.featureFlags ?? {}) as Record<string, unknown>;
  // Normalised on the way IN as well as on the way out, so an incoherent pair
  // (red below amber) is never what is stored.
  const rules = healthRulesFrom({ ...(flags.clientHealth ?? {}), ...parsed.data });

  await prismaUnsafe.workspace.update({
    where: { id: workspaceId },
    data: {
      featureFlags: { ...flags, clientHealth: { ...rules } } as unknown as Prisma.InputJsonValue,
    },
  });
  revalidatePath("/settings");
  revalidatePath("/analytics");
  return { ok: true, rules };
}

export async function resetHealthRules(): Promise<{ ok: true; rules: HealthRules } | { ok: false; error: string }> {
  return saveHealthRules(DEFAULT_HEALTH_RULES);
}

/**
 * Create the suggested task for a red client.
 *
 * A task rather than a notification: this is work someone has to do, and the
 * Today Queue is where work lives. Idempotent per client per day, so opening
 * the Revenue tab twice does not queue the same call twice.
 */
export async function createHealthTask(
  companyId: string,
): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  const { workspaceId, userId } = await getActiveContext();
  const rows = await loadClientHealth(workspaceId);
  const row = rows.find((r) => r.companyId === companyId);
  if (!row?.suggestedTask) return { ok: false, error: "That client is not flagged red." };

  const db = getWorkspaceClient(workspaceId);
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const existing = await db.task.findFirst({
    where: {
      entityType: "company",
      entityId: companyId,
      source: "client_health",
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  if (existing) return { ok: true, created: false };

  await db.task.create({
    data: {
      workspaceId,
      type: "call",
      title: row.suggestedTask.title,
      note: row.suggestedTask.note,
      dueAt: new Date(),
      entityType: "company",
      entityId: companyId,
      assigneeId: userId,
      source: "client_health",
      createdBy: userId,
    },
  });
  revalidatePath("/analytics");
  revalidatePath("/");
  return { ok: true, created: true };
}
