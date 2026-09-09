/**
 * Editing one field from the lead detail panel, including the company block
 * (playbook-v5 P16/1).
 *
 * ── WHY THIS IS SEPARATE FROM inline.ts ─────────────────────────────────────
 *
 * The table's field set and this one are deliberately different, and the
 * difference is the COMPANY. `inline.ts` refuses company edits from a lead row
 * — a shared record renamed from one of the forty rows that point at it is a
 * change nobody expects — but the detail panel's company block is explicitly
 * about the company, so editing it there is exactly right. Same primitive,
 * different permission, because the surface means something different.
 *
 * ── WHAT THE SAVE BUTTON USED TO DO, THAT THIS HAS TO KEEP DOING ────────────
 *
 * `updateLeadDetail` carries three rules that are easy to lose when a form
 * becomes per-field commits, and all three are preserved here:
 *
 *   1. THE ADÓSZÁM IS UNIQUE per workspace, so a clash is REFUSED rather than
 *      silently merging two companies.
 *   2. A LEAD MAY HAVE NO COMPANY ROW at all — captured from LinkedIn, or typed
 *      by hand. The panel shows the company fields regardless, so filling one
 *      in has to CREATE the company and link it. The old code gated the whole
 *      branch on `companyId` and threw the typed values away.
 *   3. A HUMAN CHOOSING A LANGUAGE PINS IT (`languageConfidence = "manual"`),
 *      or the next capture re-detects from profile text and silently undoes
 *      the correction that was just made.
 */

import { z } from "zod";
import { getWorkspaceClient } from "@/lib/db";
import { MANUAL_CONFIDENCE } from "@/modules/capture/language";

/** Fields on the lead itself. */
export const LEAD_DETAIL_FIELDS = [
  "contactName",
  "title",
  "headline",
  "email",
  "phone",
  "locationRaw",
  "linkedinUrl",
  "language",
  "notes",
] as const;

/** Fields on the linked company, addressed as `company.<field>`. */
export const COMPANY_DETAIL_FIELDS = ["name", "domain", "city", "taxId"] as const;

export type DetailInlineResult = { ok: true; value: unknown } | { ok: false; error: string };

const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]);

const LONG_TEXT = new Set(["notes", "headline"]);

function isLeadField(f: string): f is (typeof LEAD_DETAIL_FIELDS)[number] {
  return (LEAD_DETAIL_FIELDS as readonly string[]).includes(f);
}

export async function applyDetailInlineEdit(
  workspaceId: string,
  actorUserId: string | null,
  input: { leadId: string; field: string; value: unknown },
): Promise<DetailInlineResult> {
  const parsedValue = valueSchema.safeParse(input.value ?? null);
  if (!parsedValue.success) return { ok: false, error: "That value is not allowed." };
  const raw = parsedValue.data;
  const text = typeof raw === "string" ? raw.trim() : raw === null ? "" : String(raw);

  const db = getWorkspaceClient(workspaceId);
  const lead = await db.lead.findUnique({
    where: { id: input.leadId },
    select: { id: true, companyId: true },
  });
  if (!lead) return { ok: false, error: "Lead not found." };

  // ---- the company block ---------------------------------------------------
  if (input.field.startsWith("company.")) {
    const field = input.field.slice("company.".length);
    if (!(COMPANY_DETAIL_FIELDS as readonly string[]).includes(field)) {
      return { ok: false, error: "That company field cannot be edited here." };
    }
    if (text.length > 200) return { ok: false, error: "That is too long." };
    if (field === "name" && !text) {
      return { ok: false, error: "A company needs a name." };
    }
    if (field === "domain" && text && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(text)) {
      return { ok: false, error: "A domain looks like example.hu — no https:// and no path." };
    }

    if (field === "taxId" && text) {
      const clash = await db.company.findFirst({
        where: { taxId: text, ...(lead.companyId ? { id: { not: lead.companyId } } : {}) },
        select: { name: true },
      });
      if (clash) {
        return { ok: false, error: `Another company (${clash.name}) already has that adószám.` };
      }
    }

    if (lead.companyId) {
      await db.company.update({
        where: { id: lead.companyId },
        data: { [field]: text || null },
      });
    } else {
      /**
       * No company row yet. A name is enough to create one — anything else on
       * its own would make a nameless company, which the list cannot render and
       * nobody can find again.
       */
      if (field !== "name") {
        return { ok: false, error: "Give the company a name first." };
      }
      const created = await db.company.create({ data: { workspaceId, name: text } });
      await db.lead.update({ where: { id: lead.id }, data: { companyId: created.id } });
    }
    await touch(db, workspaceId, lead.id, actorUserId);
    return { ok: true, value: text || null };
  }

  // ---- the lead ------------------------------------------------------------
  if (!isLeadField(input.field)) {
    return { ok: false, error: "That field cannot be edited here." };
  }

  const limit = LONG_TEXT.has(input.field) ? 5000 : 500;
  if (text.length > limit) return { ok: false, error: "That is too long." };

  if (input.field === "email" && text && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text)) {
    return { ok: false, error: "That email address does not look right." };
  }
  if (input.field === "linkedinUrl" && text && !/^https?:\/\/\S+$/i.test(text)) {
    return { ok: false, error: "The LinkedIn URL should start with https://." };
  }

  if (input.field === "language") {
    if (text !== "HU" && text !== "EN") return { ok: false, error: "Language is HU or EN." };
    await db.lead.update({
      where: { id: lead.id },
      // Pinned: see rule 3 in the header.
      data: { language: text, languageConfidence: MANUAL_CONFIDENCE, lastActivityAt: new Date() },
    });
    await logEdit(db, workspaceId, lead.id, actorUserId);
    return { ok: true, value: text };
  }

  await db.lead.update({
    where: { id: lead.id },
    data: { [input.field]: text || null, lastActivityAt: new Date() },
  });
  await logEdit(db, workspaceId, lead.id, actorUserId);
  return { ok: true, value: text || null };
}

type Db = ReturnType<typeof getWorkspaceClient>;

async function touch(db: Db, workspaceId: string, leadId: string, actorUserId: string | null) {
  await db.lead.update({ where: { id: leadId }, data: { lastActivityAt: new Date() } });
  await logEdit(db, workspaceId, leadId, actorUserId);
}

/**
 * One activity row per edit, as the Save button wrote.
 *
 * Per-field commits mean more rows than one "lead_edited" per session at the
 * form's Save — which is more truthful, not less: the timeline now says when
 * each thing changed rather than lumping six edits under one timestamp.
 */
async function logEdit(db: Db, workspaceId: string, leadId: string, actorUserId: string | null) {
  await db.activity.create({
    data: { workspaceId, leadId, type: "lead_edited", byUserId: actorUserId },
  });
}
