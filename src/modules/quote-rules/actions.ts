"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";
import { loadQuoteRules, ruleEffectiveness, type RuleEffectiveness } from "./store";
import { quoteRulesFrom, DEFAULT_QUOTE_RULES, type QuoteRulesSettings } from "./rules";

export interface QuoteRulesView {
  rules: QuoteRulesSettings;
  effectiveness: RuleEffectiveness[];
}

export async function getQuoteRulesView(): Promise<QuoteRulesView> {
  const { workspaceId } = await getActiveContext();
  const [rules, effectiveness] = await Promise.all([
    loadQuoteRules(workspaceId),
    ruleEffectiveness(workspaceId),
  ]);
  return { rules, effectiveness };
}

const schema = z.object({
  repeatOpen: z.object({
    enabled: z.boolean(),
    draft: z.boolean(),
    minSessions: z.number().int().min(2).max(20),
  }),
  priceDwell: z.object({
    enabled: z.boolean(),
    draft: z.boolean(),
    minPricingSeconds: z.number().int().min(15).max(3600),
    maxScopeRatio: z.number().min(0).max(1),
  }),
  wentQuiet: z.object({
    enabled: z.boolean(),
    draft: z.boolean(),
    quietDays: z.number().int().min(2).max(90),
  }),
});

/**
 * Owner-only: these thresholds decide when the whole team gets told to pick up
 * the phone, and a rule loosened quietly is a rule that stops meaning anything.
 */
export async function saveQuoteRules(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireGrant("settings.manage");
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the thresholds." };

  const { workspaceId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { featureFlags: true },
  });
  const flags = (ws?.featureFlags ?? {}) as Record<string, unknown>;
  await prismaUnsafe.workspace.update({
    where: { id: workspaceId },
    data: {
      featureFlags: {
        ...flags,
        quoteRules: quoteRulesFrom(parsed.data),
      } as unknown as Prisma.InputJsonValue,
    },
  });
  revalidatePath("/settings/admin");
  return { ok: true };
}

export async function resetQuoteRules(): Promise<{ ok: true }> {
  await requireGrant("settings.manage");
  const { workspaceId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { featureFlags: true },
  });
  const flags = (ws?.featureFlags ?? {}) as Record<string, unknown>;
  await prismaUnsafe.workspace.update({
    where: { id: workspaceId },
    data: {
      featureFlags: {
        ...flags,
        quoteRules: DEFAULT_QUOTE_RULES,
      } as unknown as Prisma.InputJsonValue,
    },
  });
  revalidatePath("/settings/admin");
  return { ok: true };
}
