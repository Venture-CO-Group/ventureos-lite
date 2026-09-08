"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { Stage } from "@prisma/client";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";
import { eraseLeadData } from "@/modules/gdpr/erase";
import { callClaude } from "@/lib/ai/call-claude";
import {
  LEAD_RESEARCH_SYSTEM,
  leadCardSchema,
  buildResearchUserMessage,
  type LeadCard,
} from "@/lib/ai/prompts/lead-research";
import { computeIcpScore, MAX_ICP_SCORE, gateThresholdFromConfig, assessIcp } from "./scoring";
import { preParse, hasAnalyzableText, researchSource } from "./preparse";
import { enrichCompanySite } from "./enrichment";
import { assertCanEnterStage, ScoreGateError, ResearchInputError } from "./gate";
import {
  requiresReason,
  schedulesFollowups,
  cancelsFollowups,
  STAGE_LABELS,
} from "../pipeline/transitions";
import { recordUndo, type UndoToken } from "../undo/store";
import { onLeadCreated, onLeadStageChanged } from "../workflow/triggers";
import { emitLeadCreated, emitWebhookEvent } from "../webhooks/emit";
import { wakeUpDate } from "../pipeline/schedule";
import { scheduleFollowups, cancelFollowups } from "../pipeline/jobs";
import { canQualify, type Qualification } from "../inbox/qualification";
import { enqueueBriefForLead } from "../meetings/trigger";
import {
  findDuplicate,
  normalizeDomain,
  type DedupeKeys,
  type ExistingLead,
} from "./dedupe";
import { findByTaxId, normalizeTaxId } from "../registry/dedupe";
import { autoWatchForStage } from "../audit/watch-actions";

// ---- input schemas (internal — a "use server" file may only export async fns)

const companyInput = z.object({
  name: z.string().min(1),
  domain: z.string().optional(),
  industry: z.string().optional(),
  sizeBand: z.string().optional(),
  taxId: z.string().optional(),
});

const manualLeadSchema = z.object({
  contactName: z.string().optional(),
  title: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  linkedinUrl: z.string().optional(),
  company: companyInput,
  notes: z.string().optional(),
  // Source + referrer assignment on capture (spec §4.18).
  source: z.enum(["PROSPECTOR", "LINKEDIN", "MANUAL", "REFERRAL", "COLD_EMAIL"]).default("MANUAL"),
  referrerId: z.string().optional(),
});

const linkedinSchema = z.object({
  url: z.string().min(1),
  pageText: z.string().default(""),
  contactName: z.string().optional(),
  companyName: z.string().optional(),
});

async function loadExistingLeadKeys(
  db: ReturnType<typeof getWorkspaceClient>,
): Promise<ExistingLead[]> {
  const rows = await db.lead.findMany({
    select: {
      id: true,
      email: true,
      linkedinUrl: true,
      company: { select: { domain: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    linkedinUrl: r.linkedinUrl,
    companyDomain: r.company?.domain ?? null,
  }));
}

async function findOrCreateCompany(
  db: ReturnType<typeof getWorkspaceClient>,
  workspaceId: string,
  c: z.infer<typeof companyInput>,
) {
  const domain = normalizeDomain(c.domain);
  if (domain) {
    const existing = await db.company.findFirst({ where: { domain } });
    if (existing) return existing;
  }
  return db.company.create({
    data: {
      workspaceId,
      name: c.name,
      domain: domain ?? undefined,
      industry: c.industry,
      sizeBand: c.sizeBand,
      taxId: normalizeTaxId(c.taxId) ?? undefined,
    },
  });
}

// ---- 4.2 Manual entry (no AI) --------------------------------------------

export async function createLeadManual(raw: unknown): Promise<
  { ok: true; leadId: string } | { ok: false; duplicateOf: string }
> {
  const input = manualLeadSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  // adószám is the strongest dedupe key (spec §4.19) — check it first.
  if (input.company.taxId) {
    const companies = await db.company.findMany({ select: { id: true, taxId: true } });
    const taxClash = findByTaxId(input.company.taxId, companies);
    if (taxClash) return { ok: false, duplicateOf: taxClash.id };
  }

  const keys: DedupeKeys = {
    email: input.email || null,
    linkedinUrl: input.linkedinUrl || null,
    companyDomain: input.company.domain || null,
  };
  const dup = findDuplicate(keys, await loadExistingLeadKeys(db));
  if (dup) return { ok: false, duplicateOf: dup.id };

  const company = await findOrCreateCompany(db, workspaceId, input.company);
  const lead = await db.lead.create({
    data: {
      workspaceId,
      companyId: company.id,
      contactName: input.contactName,
      title: input.title,
      email: input.email || undefined,
      phone: input.phone,
      linkedinUrl: input.linkedinUrl,
      source: input.source,
      referrerId: input.source === "REFERRAL" ? input.referrerId || undefined : undefined,
      stage: "RESEARCHED",
      notes: input.notes,
    },
  });
  await onLeadCreated(workspaceId, lead.id);
  await emitLeadCreated(workspaceId, lead.id);
  revalidatePath("/leads");
  revalidatePath("/referrers");
  return { ok: true, leadId: lead.id };
}

// ---- 4.2 LinkedIn capture (assistive; no scraping, no AI auto-run) --------

export async function captureLinkedin(raw: unknown): Promise<{ leadId: string }> {
  const input = linkedinSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const company = await findOrCreateCompany(db, workspaceId, {
    name: input.companyName || "Unknown company",
  });
  const lead = await db.lead.create({
    data: {
      workspaceId,
      companyId: company.id,
      contactName: input.contactName,
      linkedinUrl: input.url,
      source: "LINKEDIN",
      stage: "RESEARCHED",
      notes: input.pageText,
    },
  });
  await onLeadCreated(workspaceId, lead.id);
  await emitLeadCreated(workspaceId, lead.id);
  revalidatePath("/leads");
  return { leadId: lead.id };
}

// CSV import moved to modules/import (playbook-v2 P5/3). The v1 pair that lived
// here — previewCsvImport / commitCsvImport — could only create, could only say
// "new" or "duplicate", and left no way back. `runImport` replaces both with a
// tracked batch; the dedupe helpers below are still used by manual capture.

// ---- 4.2 Claude research run (Sonnet, structured) -------------------------

/**
 * The result of a research run.
 *
 * ── WHY THIS RETURNS INSTEAD OF THROWING ────────────────────────────────────
 *
 * Because in a production build it CANNOT throw usefully. Next.js redacts every
 * error that escapes a Server Action — the client receives a bare Error carrying
 * only a `digest`, and the message is stripped on the server before it is sent.
 * So a perfectly ordinary, user-fixable condition ("there is no profile text
 * yet") reached the operator as:
 *
 *     An error occurred in the Server Components render. The specific message is
 *     omitted in production builds to avoid leaking sensitive details.
 *
 * The UI was already catching it and rendering `e.message`; there was simply
 * nothing left in the message to render. It worked in development, which is
 * exactly why it survived.
 *
 * The rule this settles: an EXPECTED outcome is data, and only a bug is an
 * exception. `moveLeadStage` in this same file already worked that way, which is
 * the pattern followed here.
 */
export type ResearchResult =
  | { ok: true; card: LeadCard; icpScore: number }
  | { ok: false; error: string; reason: "no_text" | "not_found" | "ai_failed" | "budget" };

export async function runResearch(leadId: string): Promise<ResearchResult> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    include: { company: true },
  });
  if (!lead) {
    return { ok: false, reason: "not_found", error: "That lead no longer exists." };
  }

  // Everything on the lead a research call could read — not just `notes`, which
  // is what made research impossible on extension-captured leads.
  const analyzable = researchSource(lead);

  // P1/1b — deterministic extraction first. These are real fields, found with
  // regexes, and they cost nothing. Persisting them before the call means a
  // paste yields something even if the research is never run.
  const parsed = preParse(analyzable);
  const companyId = lead.companyId;
  if (parsed.emails[0] || parsed.phones[0] || parsed.city || parsed.domain) {
    await db.lead.update({
      where: { id: leadId },
      data: {
        email: lead.email ?? parsed.emails[0] ?? undefined,
        phone: lead.phone ?? parsed.phones[0] ?? undefined,
      },
    });
    if (companyId && (parsed.domain || parsed.city)) {
      await db.company.update({
        where: { id: companyId },
        data: {
          domain: lead.company?.domain ?? parsed.domain ?? undefined,
          city: lead.company?.city ?? parsed.city ?? undefined,
        },
      });
    }
  }

  /**
   * THE COMPANY'S OWN SITE, FETCHED BEFORE THE GATE — not after it.
   *
   * This ordering was the whole reason a Google-sourced lead could never be
   * researched. Places gives a name, an address, a phone and a website but no
   * prose, so `hasAnalyzableText` refused and returned before the site was ever
   * fetched — and the site is exactly where the prose is. A lead with a perfectly
   * good website was declared unanalysable because we had not looked at it.
   *
   * Fetched once and cached for thirty days, robots.txt honoured, so moving it
   * above the gate costs a request only on leads that would otherwise have been
   * refused outright.
   */
  const site = companyId ? await enrichCompanySite(companyId) : null;

  /**
   * The contacts on that page, applied to the lead.
   *
   * Places has no email for any business, ever — so a prospected lead arrived
   * with an empty Email field and stayed that way. The address is in the site's
   * footer or impresszum, in the page we just downloaded. Only ever FILLS a blank
   * field: a value a human typed is never overwritten by a scrape.
   */
  const siteContacts = site?.contacts ?? { emails: [], phones: [] };
  if (companyId && (siteContacts.emails[0] || siteContacts.phones[0])) {
    const current = await db.lead.findUnique({
      where: { id: leadId },
      select: { email: true, phone: true },
    });
    if ((!current?.email && siteContacts.emails[0]) || (!current?.phone && siteContacts.phones[0])) {
      await db.lead.update({
        where: { id: leadId },
        data: {
          email: current?.email ?? siteContacts.emails[0] ?? undefined,
          phone: current?.phone ?? siteContacts.phones[0] ?? undefined,
        },
      });
    }
    // Company carries a phone but no email column, so the address lives on the
    // lead — which is where an operator looks for it anyway.
    if (!lead.company?.phone && siteContacts.phones[0]) {
      await db.company.update({
        where: { id: companyId },
        data: { phone: siteContacts.phones[0] },
      });
    }
  }

  /**
   * P1/1a — refuse to spend a Sonnet call on a lead with nothing to read.
   *
   * "Nothing" now includes the website, so this only fires when there is
   * genuinely no prose anywhere: no notes, no bio, no posts, and either no site
   * or one that could not be read.
   */
  if (!hasAnalyzableText(analyzable) && !site?.text) {
    return {
      ok: false,
      reason: "no_text",
      error: site?.skipped
        ? `There is nothing to analyse yet: this lead has no pasted text, and its website could not be read (${String(site.skipped).replace(/_/g, " ")}). Paste the company's page text and try again.`
        : "There is nothing to analyse on this lead yet. Add the company's website, paste its page text, or capture a LinkedIn profile with the extension, then run research again.",
    };
  }

  const profile = [
    lead.company?.name && `Company: ${lead.company.name}`,
    lead.company?.industry && `Industry: ${lead.company.industry}`,
    lead.contactName && `Contact: ${lead.contactName}${lead.title ? `, ${lead.title}` : ""}`,
    lead.linkedinUrl && `LinkedIn: ${lead.linkedinUrl}`,
    parsed.emails[0] && `Email: ${parsed.emails[0]}`,
    parsed.phones[0] && `Phone: ${parsed.phones[0]}`,
    parsed.city && `City: ${parsed.city}`,
    lead.notes && `Notes / pasted page:\n${lead.notes}`,
    // Only when it is not already inside the notes, which is where a capture
    // now puts it — the model should not be shown the About section twice.
    !lead.notes && lead.bio && `Profile text:\n${lead.bio}`,
    site?.text && `Company website copy:\n${site.text}`,
  ]
    .filter(Boolean)
    .join("\n");

  /**
   * A model that refuses, returns unparseable JSON, or runs the workspace out of
   * budget is an EXPECTED outcome, not a bug — and in production every one of
   * them reached the operator as the same opaque "Server Components render"
   * error, because Next.js strips the message off anything thrown out of a
   * Server Action.
   *
   * Reported by name instead, so the next step is obvious: retry, or top up the
   * budget, or paste better text.
   */
  let data: unknown;
  try {
    ({ data } = await callClaude({
      useCase: "lead_research",
      workspaceId,
      system: LEAD_RESEARCH_SYSTEM,
      messages: [{ role: "user", content: buildResearchUserMessage(profile) }],
      schema: leadCardSchema,
    }));
  } catch (e) {
    const name = (e as Error)?.name ?? "Error";
    if (name === "BudgetExceededError") {
      return {
        ok: false,
        reason: "budget",
        error: "This workspace has reached its Claude budget for today. Research again tomorrow, or raise the cap in Settings.",
      };
    }
    return {
      ok: false,
      reason: "ai_failed",
      error:
        name === "ClaudeRefusalError"
          ? "Claude declined to analyse this lead. Check the pasted text and try again."
          : "Claude's answer could not be read. Try research again — this usually passes on a second attempt.",
    };
  }
  const card = data as LeadCard;
  const icpScore = computeIcpScore(card.icp);
  // P1/1d — which criteria the model could not judge, kept separately so an
  // incomplete score is visibly incomplete rather than looking like a verdict.
  const assessment = assessIcp(card.icp as never);

  await db.lead.update({
    where: { id: leadId },
    data: {
      icpScore,
      scoreBreakdown: { ...card.icp, _unknown: assessment.unknown },
      signals: card.signals,
      contactName: lead.contactName ?? card.person.name,
      title: lead.title ?? card.person.title ?? undefined,
    },
  });
  revalidatePath("/leads");
  return { ok: true, card, icpScore };
}

// ---- 4.5 Score override (audited) -----------------------------------------

export async function overrideScore(
  leadId: string,
  score: number,
  reason: string,
): Promise<{ icpScore: number }> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { icpScore: true },
  });
  if (!lead) throw new Error("Lead not found");

  const icpScore = Math.max(0, Math.min(MAX_ICP_SCORE, Math.round(score)));
  await db.lead.update({ where: { id: leadId }, data: { icpScore } });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "lead.score_override",
      entityType: "Lead",
      entityId: leadId,
      meta: { from: lead.icpScore, to: icpScore, reason },
    },
  });
  revalidatePath("/leads");
  return { icpScore };
}

// ---- 4.5 Stage move with server-side gate ---------------------------------

export async function moveLeadStage(
  leadId: string,
  toStage: Stage,
  opts?: { reason?: string; wakeUpAt?: string },
): Promise<{ ok: true; undo?: UndoToken | null } | { ok: false; error: string }> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: {
      icpScore: true,
      stage: true,
      qualification: true,
      companyId: true,
      // Captured for the undo's inverse, before the move overwrites them.
      stageEnteredAt: true,
      stageReason: true,
      wakeUpAt: true,
    },
  });
  if (!lead) throw new Error("Lead not found");

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { icpConfig: true },
  });
  const threshold = gateThresholdFromConfig(ws?.icpConfig);

  // Score gate — enforced in the API layer, not just the UI.
  try {
    assertCanEnterStage({ toStage, score: lead.icpScore, threshold, leadId });
  } catch (e) {
    if (e instanceof ScoreGateError) return { ok: false, error: e.message };
    throw e;
  }

  // Qualification gate — Qualified unlocks only at 3 of 4 answered (spec §4.7).
  if (toStage === "QUALIFIED" && !canQualify(lead.qualification as Partial<Qualification> | null)) {
    return {
      ok: false,
      error: "Answer at least 3 of 4 qualification questions before qualifying.",
    };
  }

  if (requiresReason(toStage) && !opts?.reason?.trim()) {
    return { ok: false, error: "A reason is required to disqualify a lead." };
  }

  const now = new Date();
  const wakeUpAt =
    toStage === "NOT_NOW"
      ? opts?.wakeUpAt
        ? new Date(opts.wakeUpAt)
        : wakeUpDate(now)
      : null;

  await db.lead.update({
    where: { id: leadId },
    data: {
      stage: toStage,
      stageEnteredAt: now,
      stageReason: opts?.reason ?? null,
      ...(toStage === "NOT_NOW" ? { wakeUpAt } : {}),
    },
  });

  // Stage transitions create Activity records (spec §4.5).
  await db.activity.create({
    data: {
      workspaceId,
      leadId,
      type: "stage_change",
      byUserId: userId,
      payload: { from: lead.stage, to: toStage, reason: opts?.reason ?? null },
    },
  });

  // Reaching a stage worth working turns on the audit watch (P2/5). Silent and
  // best-effort: a watch is never a reason a stage move fails.
  await autoWatchForStage(lead.companyId, toStage);

  // Task-level automations (never messaging). Best-effort — never block the move.
  try {
    if (schedulesFollowups(toStage)) await scheduleFollowups(leadId, workspaceId);
    if (cancelsFollowups(toStage)) await cancelFollowups(leadId);
    // The one permitted non-manual Claude trigger (spec §4.8): entering
    // Meeting-booked queues the brief, bounded to one call per booking.
    if (toStage === "MEETING_BOOKED") await enqueueBriefForLead(workspaceId, leadId);
    // Workflow rules last, and best-effort: an automation must never be the
    // reason a stage move fails (P7/5).
    await onLeadStageChanged(workspaceId, leadId);
    // Outbound webhooks (P5/5.2), inside the same best-effort block and for
    // the same reason: telling somebody else's CRM is our problem, not the
    // user's. It only queues rows — the worker does the sending.
    await emitWebhookEvent(workspaceId, "lead.stage_changed", {
      leadId,
      from: lead.stage,
      to: toStage,
      reason: opts?.reason ?? null,
      icpScore: lead.icpScore,
      companyId: lead.companyId,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[pipeline] stage automation failed", e);
  }

  // Undoable for the length of the toast (P7/2). The inverse restores the
  // stage AND the things the move overwrote — the entered-at timestamp and any
  // wake-up date — because putting the stage back and leaving the clock reset
  // is a different lead from the one that was there a second ago.
  const undoToken = await recordUndo(workspaceId, userId, {
    kind: toStage === "NOT_NOW" ? "lead_not_now" : "lead_stage",
    label: `Moved to ${STAGE_LABELS[toStage] ?? toStage}`,
    inverse: {
      entity: "lead",
      targets: [
        {
          id: leadId,
          set: {
            stage: lead.stage,
            stageEnteredAt: lead.stageEnteredAt.toISOString(),
            stageReason: lead.stageReason,
            wakeUpAt: lead.wakeUpAt ? lead.wakeUpAt.toISOString() : null,
          },
        },
      ],
    },
    expected: { [leadId]: { stage: toStage } },
  });

  revalidatePath("/leads");
  revalidatePath("/pipeline");
  return { ok: true, undo: undoToken };
}

// ---------------------------------------------------------------------------
// deletion
// ---------------------------------------------------------------------------

const deleteSchema = z.object({
  leadId: z.string().min(1),
  /**
   * Purge quotes/contracts/certificates and their PDFs too. Off by default:
   * issued legal documents are usually retained under a separate legal basis,
   * in which case eraseLeadData detaches them from the person instead.
   */
  eraseDocuments: z.boolean().default(false),
});

export type DeleteLeadResult =
  | { ok: true; deleted: Record<string, number>; filesRemoved: number }
  | { ok: false; error: string };

/**
 * Hard-delete a lead and everything derived from it (CLAUDE.md rule #9 —
 * erasure inside 72h, cascading to derived data, with backups expiring inside
 * the 14-day rotation).
 *
 * The erasure machinery already existed in modules/gdpr/erase.ts and was only
 * ever reachable from a background job, so there was no way to delete a lead
 * from the product at all. This is the operator-facing entry point.
 *
 * Owner-only: it removes rows across a dozen tables and unlinks files from
 * disk, and it cannot be undone from inside the app. Audited either way
 * (rule #8 — every delete is logged).
 */
export async function deleteLead(raw: unknown): Promise<DeleteLeadResult> {
  const parsed = deleteSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown lead." };

  try {
    await requireGrant("leads.delete");
  } catch {
    return { ok: false, error: "You need the leads.delete capability to delete a lead." };
  }

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  // Read the identifying details BEFORE erasure so the audit entry still says
  // who was removed once the rows are gone.
  const lead = await db.lead.findUnique({
    where: { id: parsed.data.leadId },
    select: {
      id: true,
      contactName: true,
      email: true,
      company: { select: { name: true } },
    },
  });
  if (!lead) return { ok: false, error: "Lead not found." };

  const result = await eraseLeadData(db, lead.id, {
    eraseDocuments: parsed.data.eraseDocuments,
  });

  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "lead.deleted",
      entityType: "Lead",
      entityId: lead.id,
      meta: {
        contactName: lead.contactName,
        company: lead.company?.name ?? null,
        // The address is the point of a GDPR erasure request, so record that
        // it was this one that went — the log is the proof the request ran.
        email: lead.email,
        erasedDocuments: parsed.data.eraseDocuments,
        deleted: result.deleted,
        filesRemoved: result.filesRemoved,
      },
    },
  });

  revalidatePath("/leads");
  revalidatePath("/pipeline");
  revalidatePath("/public-pages");
  return { ok: true, deleted: result.deleted, filesRemoved: result.filesRemoved };
}
