"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";
import { TARGET_METRICS } from "./metrics";

/**
 * Weekly KPI targets (spec §4.1, §4.14).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The Friday report has compared four numbers against a target since it was
 * built, and NOTHING in the product could ever set one. `Target` was read twice
 * and written never, so every KPI measured itself against null and the report's
 * whole "vs target" column was decoration.
 *
 * Four metrics, one period. Deliberately not a general goal-setting system: a
 * target the team looks at once a week is worth having, and a matrix of
 * periods and owners is worth having only once somebody has asked for it.
 */

export interface TargetRow {
  metric: string;
  label: string;
  unit: string;
  hint: string;
  value: number | null;
}

export async function listTargets(): Promise<TargetRow[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.target.findMany({ where: { period: "weekly" } });
  const byMetric = new Map(rows.map((r) => [r.metric, r.value]));
  return TARGET_METRICS.map((t) => ({
    metric: t.metric,
    label: t.label,
    unit: t.unit,
    hint: t.hint,
    // Null, not zero: "no target set" and "a target of zero" are different
    // statements, and the report already knows how to say the first one.
    value: byMetric.get(t.metric) ?? null,
  }));
}

const saveSchema = z.object({
  targets: z
    .array(
      z.object({
        metric: z.enum(["invites_sent", "acceptance_rate", "reply_rate", "meetings_booked"]),
        /** Null clears the target rather than setting it to zero. */
        value: z.number().int().min(0).max(100_000).nullable(),
      }),
    )
    .max(8),
});

/** Owner-only: a target is what the team is measured against. */
export async function saveTargets(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireGrant("settings.manage");
  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Csak egész számok, 0 és 100 000 között." };

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  for (const t of parsed.data.targets) {
    const existing = await db.target.findFirst({
      where: { metric: t.metric, period: "weekly" },
      select: { id: true },
    });
    if (t.value === null) {
      if (existing) await db.target.delete({ where: { id: existing.id } });
      continue;
    }
    if (existing) {
      await db.target.update({ where: { id: existing.id }, data: { value: t.value } });
    } else {
      await db.target.create({
        data: { workspaceId, metric: t.metric, period: "weekly", value: t.value },
      });
    }
  }

  revalidatePath("/settings/admin");
  revalidatePath("/analytics");
  return { ok: true };
}
