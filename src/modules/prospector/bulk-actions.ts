"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import type { BulkResult, SkippedRow } from "@/lib/bulk";
import { addProspectAsLead } from "./actions";
import { startAudit } from "@/modules/audit/actions";

/**
 * Bulk actions on prospector results (playbook-v5 P17/1).
 *
 * ── WHY THESE TAKE PAYLOADS RATHER THAN IDS ─────────────────────────────────
 *
 * A prospector result is not a row yet. It comes back from Places, lives in
 * the component, and only becomes a company when somebody adds it — so there
 * is no id to send. The bar's contract is id-based, so the surface keys its
 * results by placeId and hands the matching payloads through the action's
 * state. What arrives here is therefore the payloads, bounded by the batch.
 *
 * ── AND WHY DUPLICATES ARE SKIPS, NOT FAILURES ──────────────────────────────
 *
 * Adding forty prospects where nine are already companies is a normal outcome,
 * not an error. Each one comes back as a skip naming the company it matched,
 * which is what a person needs to go and look at it.
 */
const prospect = z.object({
  placeId: z.string().nullish(),
  name: z.string().min(1),
  category: z.string().nullish(),
  phone: z.string().nullish(),
  websiteUri: z.string().nullish(),
  address: z.string().nullish(),
  city: z.string().nullish(),
  businessStatus: z.string().nullish(),
  rating: z.number().nullish(),
  reviews: z.number().nullish(),
});

const batch = z.array(prospect).min(1).max(200);

export async function bulkAddProspects(raw: unknown): Promise<BulkResult> {
  const parsed = batch.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  await getActiveContext();

  const skipped: SkippedRow[] = [];
  let applied = 0;
  for (const item of parsed.data) {
    const key = item.placeId ?? item.name;
    try {
      const res = await addProspectAsLead(item);
      if (res.ok) applied += 1;
      else skipped.push({ id: key, reason: "Already in the workspace as a company." });
    } catch {
      // One bad row must not lose the other thirty-nine.
      skipped.push({ id: key, reason: "Could not be added — try it on its own to see why." });
    }
  }
  revalidatePath("/leads");
  return { applied, skipped };
}

export async function bulkAuditProspects(raw: unknown): Promise<BulkResult> {
  const parsed = z.array(z.object({ placeId: z.string().nullish(), name: z.string(), websiteUri: z.string().nullish() })).min(1).max(50).safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  await getActiveContext();

  const skipped: SkippedRow[] = [];
  let applied = 0;
  for (const item of parsed.data) {
    const key = item.placeId ?? item.name;
    /**
     * No site, no audit. The audit reads a website; a business without one is
     * the most interesting kind of prospect and the least auditable, so it is
     * named rather than silently dropped.
     */
    if (!item.websiteUri) {
      skipped.push({ id: key, reason: "No website to audit." });
      continue;
    }
    try {
      await startAudit({ url: item.websiteUri });
      applied += 1;
    } catch {
      skipped.push({ id: key, reason: "The audit could not be queued." });
    }
  }
  return { applied, skipped };
}
