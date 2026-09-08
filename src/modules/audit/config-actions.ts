"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";
import { AUDIT_CATEGORIES, CATEGORY_LABEL, type AuditCategory } from "./categories";
import { auditThresholdsFromConfig, DEFAULT_AUDIT_THRESHOLDS } from "./config";

/**
 * The audit scoring panel the runner has always claimed existed.
 *
 * "Thresholds set in Settings, not by AI" is printed on the audit screen, and
 * there was no such screen: `Workspace.auditConfig` was read by
 * `auditThresholdsFromConfig` and written by nothing. So every workspace ran
 * on the defaults, and the sentence on the audit page was an aspiration.
 */

export interface AuditScoringView {
  verdict: { strong: number; possible: number };
  categories: Array<{
    key: AuditCategory;
    label: string;
    weight: number;
    /** Only a crawled internal audit produces these, and they never score. */
    internalOnly: boolean;
  }>;
  heavyPageMb: number;
  /** Sum of the weights, so the panel can show what a change actually did. */
  weightTotal: number;
  isDefault: boolean;
  canEdit: boolean;
}

export async function getAuditScoring(): Promise<AuditScoringView> {
  const { workspaceId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { auditConfig: true },
  });
  const t = auditThresholdsFromConfig(ws?.auditConfig);
  let canEdit = true;
  try {
    await requireGrant("settings.manage");
  } catch {
    canEdit = false;
  }

  const categories = AUDIT_CATEGORIES.map((key) => ({
    key,
    label: CATEGORY_LABEL[key].en,
    weight: t.categoryWeights[key],
    internalOnly: key === "structure",
  }));

  return {
    verdict: t.verdict,
    categories,
    heavyPageMb: Math.round((t.heavyPageBytes / 1_000_000) * 10) / 10,
    weightTotal: categories.reduce((n, c) => n + c.weight, 0),
    isDefault:
      JSON.stringify(t) === JSON.stringify(DEFAULT_AUDIT_THRESHOLDS),
    canEdit,
  };
}

const saveSchema = z.object({
  strong: z.coerce.number().int().min(1).max(100),
  possible: z.coerce.number().int().min(0).max(99),
  heavyPageMb: z.coerce.number().min(0.1).max(100),
  weights: z.record(z.string(), z.coerce.number().min(0).max(100)),
});

export async function saveAuditScoring(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireGrant("settings.manage");
  } catch {
    return { ok: false, error: "You need the settings.manage capability to change scoring." };
  }
  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the numbers and try again." };
  const input = parsed.data;

  // A STRONG band at or below POSSIBLE leaves one of the three verdicts
  // unreachable, and the panel would then be quietly lying about what it does.
  if (input.possible >= input.strong) {
    return {
      ok: false,
      error: "The Strong threshold has to be above the Possible one, or one verdict can never happen.",
    };
  }

  const categoryWeights: Record<string, number> = {};
  for (const key of AUDIT_CATEGORIES) {
    const v = input.weights[key];
    categoryWeights[key] = typeof v === "number" && v >= 0 ? v : 0;
  }
  // All zero would make every score 0 and every site a SKIP — a configuration
  // that turns the module off without saying so.
  if (Object.values(categoryWeights).every((v) => v === 0)) {
    return {
      ok: false,
      error: "At least one category has to carry weight, or every site scores zero.",
    };
  }

  const { workspaceId, userId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { auditConfig: true },
  });
  // Merged: `auditConfig` also carries the SERP keyword cap and the
  // category→service map, neither of which belongs to this panel.
  const existing =
    ws?.auditConfig && typeof ws.auditConfig === "object" && !Array.isArray(ws.auditConfig)
      ? (ws.auditConfig as Record<string, unknown>)
      : {};

  await prismaUnsafe.workspace.update({
    where: { id: workspaceId },
    data: {
      auditConfig: {
        ...existing,
        verdict: { strong: input.strong, possible: input.possible },
        categoryWeights,
        heavyPageBytes: Math.round(input.heavyPageMb * 1_000_000),
      },
    },
  });

  const db = getWorkspaceClient(workspaceId);
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "audit.scoring_changed",
      entityType: "Workspace",
      entityId: workspaceId,
      meta: { verdict: { strong: input.strong, possible: input.possible }, categoryWeights },
    },
  });

  revalidatePath("/settings/admin");
  revalidatePath("/audit");
  return { ok: true };
}

/** Put the defaults back. Cheaper than undoing eight numbers by hand. */
export async function resetAuditScoring(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireGrant("settings.manage");
  } catch {
    return { ok: false, error: "You need the settings.manage capability to change scoring." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { auditConfig: true },
  });
  const existing =
    ws?.auditConfig && typeof ws.auditConfig === "object" && !Array.isArray(ws.auditConfig)
      ? (ws.auditConfig as Record<string, unknown>)
      : {};
  // Delete the keys rather than write the defaults back: an absent key means
  // "whatever the product's default is", which keeps following the product.
  delete existing.verdict;
  delete existing.categoryWeights;
  delete existing.heavyPageBytes;

  await prismaUnsafe.workspace.update({
    where: { id: workspaceId },
    data: { auditConfig: existing as never },
  });
  const db = getWorkspaceClient(workspaceId);
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "audit.scoring_reset",
      entityType: "Workspace",
      entityId: workspaceId,
    },
  });
  revalidatePath("/settings/admin");
  return { ok: true };
}
