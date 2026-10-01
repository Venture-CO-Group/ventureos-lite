/**
 * The approval queue's rules (spec §4.43.8, playbook-v6 F4/2–4), session-free
 * so the tests and the actions share one implementation.
 *
 * HUMAN CONTROL ON THIS PATH (CLAUDE.md hard rule 6, second half): the act of
 * control is an explicit approval of the exact visible text. So:
 *   - approve takes the text the reviewer saw, edited or not, and stores it;
 *   - nothing becomes APPROVED without a user id and a timestamp on it;
 *   - bulk approve touches only cards that same reviewer opened;
 *   - there is no auto-approve anywhere, and no code path that sets APPROVED
 *     other than `approveDraft` below.
 *
 * And the hook gate holds at approval too: an edit that removes every
 * company-specific sentence is refused.
 */
import type { CandidateReason, Prisma } from "@prisma/client";
import { prismaUnsafe, type WorkspaceClient } from "@/lib/db";
import { computeIcpScore, gateThresholdFromConfig, type IcpBreakdown } from "@/modules/leads/scoring";
import { cachedDatasheet } from "@/modules/registry/registry-service";
import { cegadatTaxId } from "@/modules/registry/cegadat";
import { onLeadCreated } from "@/modules/workflow/triggers";
import { emitLeadCreated } from "@/modules/webhooks/emit";
import { hasHook, type CandidateFact } from "./facts";
import { stillGrounded, validateDraft, type PersonalisationPoint } from "./draft";
import { transition } from "./state";
import { domainOf } from "./pool";
import type { ResolvedContact } from "./contact";
import { parseOutboundConfig, workspaceDailyCap } from "./config";

export type ApprovalResult = { ok: true } | { ok: false; error: string };

export const REVIEW_REASONS = ["WRONG_TARGETING", "WEAK_COPY", "WRONG_CONTACT", "BAD_TIMING", "ALREADY_IN_CONTACT", "OTHER"] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

function points(raw: unknown): PersonalisationPoint[] {
  return Array.isArray(raw) ? (raw as PersonalisationPoint[]) : [];
}
function facts(raw: unknown): CandidateFact[] {
  return Array.isArray(raw) ? (raw as CandidateFact[]) : [];
}

// ---- opening, editing ------------------------------------------------------------

export async function markOpened(db: WorkspaceClient, draftId: string, userId: string, now = new Date()): Promise<void> {
  // Only the first open counts as "seen by"; a second reviewer opening it
  // later does not make it theirs to bulk-approve.
  await db.outreachDraft.updateMany({ where: { id: draftId, openedAt: null }, data: { openedAt: now, openedById: userId } });
}

export async function editDraft(
  db: WorkspaceClient,
  draftId: string,
  text: { subject: string; body: string },
): Promise<ApprovalResult> {
  const d = await db.outreachDraft.findUnique({ where: { id: draftId } });
  if (!d || d.status !== "PENDING") return { ok: false, error: "This draft is no longer waiting for review." };
  const subject = text.subject.trim();
  const body = text.body.trim();
  if (!subject || !body) return { ok: false, error: "Subject and body cannot be empty." };
  await db.outreachDraft.update({
    where: { id: draftId },
    data: { subject, body, edited: subject !== d.originalSubject || body !== d.originalBody },
  });
  return { ok: true };
}

// ---- the lead an approval creates ------------------------------------------------

/** The five criteria, from what the pipeline established — never from a model. */
export function outboundIcpBreakdown(input: {
  matchedSegment: string | null;
  facts: readonly CandidateFact[];
  contact: ResolvedContact | null;
  registryStatus: string | null;
}): IcpBreakdown {
  return {
    segment_fit: input.matchedSegment ? 1 : 0,
    trigger_signal: input.facts.some((f) => f.kind === "audit" || f.kind === "site") ? 1 : 0,
    decision_maker: input.contact?.kind === "named" || input.contact?.kind === "named_generic" ? 1 : 0,
    active_profile: (input.registryStatus ?? "").toLowerCase() === "aktív" ? 1 : 0,
    personal_hook: hasHook(input.facts) ? 1 : 0,
  };
}

async function ensureLead(
  db: WorkspaceClient,
  workspaceId: string,
  c: Prisma.ProspectCandidateGetPayload<{ include: { pool: true } }>,
  draft: { id: string; toAddress: string; toName: string | null; language: "HU" | "EN" },
  productName: string,
): Promise<{ ok: true; leadId: string; companyId: string } | { ok: false; error: string }> {
  if (c.leadId) {
    const existing = await db.lead.findUnique({ where: { id: c.leadId }, select: { id: true, companyId: true } });
    if (existing) return { ok: true, leadId: existing.id, companyId: existing.companyId ?? "" };
  }
  const sheet = c.taxNumber ? (await cachedDatasheet(workspaceId, c.taxNumber))?.sheet ?? null : null;
  const cfs = facts(c.facts);
  const contact = (c.contact ?? null) as ResolvedContact | null;
  const breakdown = outboundIcpBreakdown({ matchedSegment: c.matchedSegment, facts: cfs, contact, registryStatus: sheet?.status ?? null });
  const score = computeIcpScore(breakdown);

  // Score gate (hard rule 5): this lead goes to Contacted the moment it is
  // sent, so a lead that could not enter Contacted is refused here, before
  // anyone approves a message that could never leave.
  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { icpConfig: true } });
  const threshold = gateThresholdFromConfig(ws?.icpConfig);
  if (score < threshold) {
    return { ok: false, error: `This company scores ${score}/5 against the ICP, below the gate of ${threshold}; it cannot enter Contacted.` };
  }

  const tax = c.taxNumber ? cegadatTaxId(c.taxNumber) : null;
  const website = c.website ?? sheet?.website ?? null;
  const domain = domainOf(website) ?? domainOf(draft.toAddress.split("@")[1] ?? null);
  let company = tax ? await db.company.findFirst({ where: { taxId: tax } }) : null;
  if (!company && domain) company = await db.company.findFirst({ where: { domain } });
  if (!company) {
    company = await db.company.create({
      data: {
        workspaceId,
        name: sheet?.shortName ?? sheet?.legalName ?? c.name,
        taxId: tax,
        website,
        domain,
        phone: contact?.phone ?? sheet?.phone ?? null,
        city: sheet?.seat.city ?? c.pool.city ?? null,
        address: sheet?.seat.oneLine ?? null,
        sizeBand: c.sizeBand,
        source: "outbound_engine",
      },
    });
  }
  if (sheet && tax) {
    await db.registryData.upsert({
      where: { companyId: company.id },
      create: {
        workspaceId,
        companyId: company.id,
        taxId: tax,
        regNumber: sheet.registryNumber,
        legalName: sheet.legalName,
        headcountBand: sheet.employeeCount !== null ? `${sheet.employeeCount} employees` : null,
        revenueBand: sheet.netRevenue !== null ? `${sheet.netRevenue.toString()} Ft` : null,
        statusFlags: [],
      },
      update: {},
    });
  }

  const audit = c.auditId ? await db.auditResult.findUnique({ where: { id: c.auditId }, select: { flags: true } }) : null;
  const lead = await db.lead.create({
    data: {
      workspaceId,
      companyId: company.id,
      contactName: draft.toName,
      email: draft.toAddress,
      emailStatus: contact?.verify?.status ?? null,
      emailReason: contact?.verify?.reason ?? null,
      phone: contact?.phone ?? null,
      source: "OUTBOUND_ENGINE",
      language: draft.language,
      stage: "RESEARCHED",
      icpScore: score,
      scoreBreakdown: breakdown as unknown as Prisma.InputJsonValue,
      signals: (Array.isArray(audit?.flags) ? audit!.flags : []) as Prisma.InputJsonValue,
      notes: `Outbound motor · ${productName}`,
      lastActivityAt: new Date(),
    },
  });
  if (c.auditId) await db.auditResult.update({ where: { id: c.auditId }, data: { companyId: company.id } }).catch(() => {});
  await db.prospectCandidate.update({ where: { id: c.id }, data: { leadId: lead.id, companyId: company.id } });
  await onLeadCreated(workspaceId, lead.id);
  await emitLeadCreated(workspaceId, lead.id);
  return { ok: true, leadId: lead.id, companyId: company.id };
}

// ---- decisions -------------------------------------------------------------------

export async function approveDraft(
  db: WorkspaceClient,
  workspaceId: string,
  input: { draftId: string; userId: string; subject?: string; body?: string; now?: Date },
): Promise<ApprovalResult> {
  const now = input.now ?? new Date();
  const d = await db.outreachDraft.findUnique({ where: { id: input.draftId } });
  if (!d || d.status !== "PENDING") return { ok: false, error: "This draft is no longer waiting for review." };
  const c = await db.prospectCandidate.findUnique({ where: { id: d.candidateId }, include: { pool: true } });
  if (!c) return { ok: false, error: "The candidate behind this draft is gone." };
  if (d.step === 0 && c.state !== "PENDING_APPROVAL") return { ok: false, error: "This candidate is no longer waiting for approval." };
  if (d.step > 0 && c.state !== "SENT") return { ok: false, error: "The sequence for this company has ended." };

  // The text approved is the text on screen.
  const subject = (input.subject ?? d.subject).trim();
  const body = (input.body ?? d.body).trim();
  if (!subject || !body) return { ok: false, error: "Subject and body cannot be empty." };
  const pts = points(d.personalisationPoints);
  if (!stillGrounded({ subject, body }, pts)) {
    return { ok: false, error: "The message no longer contains a company-specific fact. Keep at least one, or reject the draft." };
  }
  const product = d.productId ? await db.product.findUnique({ where: { id: d.productId }, include: { references: true } }) : null;
  // Re-run the name check on the edited text: a person can type a pattern
  // reference's name just as easily as a model can.
  const check = validateDraft(
    { subject, body, personalisationPoints: pts.filter((p) => `${subject}\n${body}`.toLowerCase().includes(p.quote.toLowerCase())) },
    facts(c.facts),
    product?.references ?? [],
  );
  if (!check.ok && /targeting pattern|placeholder/.test(check.error)) return { ok: false, error: `Cannot approve: the message ${check.error}.` };

  if (d.step === 0) {
    const lead = await ensureLead(db, workspaceId, c, d, product?.name ?? "outbound");
    if (!lead.ok) return lead;
    await db.activity.create({
      data: {
        workspaceId,
        leadId: lead.leadId,
        type: "outbound_approved",
        byUserId: input.userId,
        payload: { draftId: d.id, subject, edited: subject !== d.originalSubject || body !== d.originalBody },
      },
    });
  }

  await db.outreachDraft.update({
    where: { id: d.id },
    data: {
      subject,
      body,
      edited: subject !== d.originalSubject || body !== d.originalBody,
      status: "APPROVED",
      decidedById: input.userId,
      decidedAt: now,
      scheduledFor: d.scheduledFor && d.scheduledFor > now ? d.scheduledFor : now,
    },
  });
  if (d.step === 0) await transition(db, workspaceId, c, "APPROVED", { userId: input.userId, detail: d.id, at: now });
  return { ok: true };
}

export async function rejectDraft(
  db: WorkspaceClient,
  workspaceId: string,
  input: { draftId: string; userId: string; reason: ReviewReason; note?: string | null; now?: Date },
): Promise<ApprovalResult> {
  // No reason, no rejection: the reasons are the learning signal (§4.43.8).
  if (!REVIEW_REASONS.includes(input.reason)) return { ok: false, error: "Pick a reason." };
  if (input.reason === "OTHER" && !input.note?.trim()) return { ok: false, error: "Say why, in a few words." };
  const now = input.now ?? new Date();
  const d = await db.outreachDraft.findUnique({ where: { id: input.draftId } });
  if (!d || d.status !== "PENDING") return { ok: false, error: "This draft is no longer waiting for review." };
  await db.outreachDraft.update({
    where: { id: d.id },
    data: {
      status: "REJECTED",
      decidedById: input.userId,
      decidedAt: now,
      rejectReason: input.reason as CandidateReason,
      rejectNote: input.note?.trim() || null,
    },
  });
  // A rejected follow-up ends the sequence; the company stays SENT.
  if (d.step === 0) {
    const c = await db.prospectCandidate.findUnique({ where: { id: d.candidateId } });
    if (c && c.state === "PENDING_APPROVAL") {
      await transition(db, workspaceId, c, "REJECTED", {
        reason: input.reason as CandidateReason,
        detail: input.note?.trim() || null,
        userId: input.userId,
        at: now,
      });
    }
  }
  return { ok: true };
}

export async function routeToLinkedIn(
  db: WorkspaceClient,
  workspaceId: string,
  input: { draftId: string; userId: string; now?: Date },
): Promise<ApprovalResult> {
  const d = await db.outreachDraft.findUnique({ where: { id: input.draftId } });
  if (!d || d.status !== "PENDING" || d.step !== 0) return { ok: false, error: "Only a first message waiting for review can be routed to LinkedIn." };
  const c = await db.prospectCandidate.findUnique({ where: { id: d.candidateId } });
  if (!c || c.state !== "PENDING_APPROVAL") return { ok: false, error: "This candidate is no longer waiting for approval." };
  await db.outreachDraft.update({ where: { id: d.id }, data: { status: "CANCELLED", decidedById: input.userId, decidedAt: input.now ?? new Date() } });
  await transition(db, workspaceId, c, "LINKEDIN_QUEUE", { userId: input.userId, detail: "routed by the reviewer", at: input.now });
  return { ok: true };
}

/**
 * Approve several at once — only cards THIS reviewer has opened, with the
 * text they saw. Everything else is reported, never silently approved.
 */
export async function bulkApprove(
  db: WorkspaceClient,
  workspaceId: string,
  input: { draftIds: string[]; userId: string; now?: Date },
): Promise<{ approved: string[]; skipped: Array<{ id: string; reason: string }> }> {
  const approved: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const id of input.draftIds) {
    const d = await db.outreachDraft.findUnique({ where: { id }, select: { openedById: true, openedAt: true } });
    if (!d?.openedAt || d.openedById !== input.userId) {
      skipped.push({ id, reason: "not opened by you" });
      continue;
    }
    const r = await approveDraft(db, workspaceId, { draftId: id, userId: input.userId, now: input.now });
    if (r.ok) approved.push(id);
    else skipped.push({ id, reason: r.error });
  }
  return { approved, skipped };
}

// ---- the header's numbers ----------------------------------------------------------

export interface QueueStats {
  approvedToday: number;
  cap: number;
  pending: number;
  byProduct: Array<{ productId: string | null; name: string; pending: number; approvedToday: number }>;
}

export async function queueStats(db: WorkspaceClient, workspaceId: string, now = new Date()): Promise<QueueStats> {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { outboundConfig: true } });
  const cfg = parseOutboundConfig(ws?.outboundConfig);
  const [pending, approved, products] = await Promise.all([
    db.outreachDraft.groupBy({ by: ["productId"], where: { status: "PENDING" }, _count: { _all: true } }),
    db.outreachDraft.groupBy({ by: ["productId"], where: { decidedAt: { gte: start }, status: { in: ["APPROVED", "SENT"] } }, _count: { _all: true } }),
    db.product.findMany({ select: { id: true, name: true } }),
  ]);
  const ids = new Set([...pending.map((p) => p.productId), ...approved.map((p) => p.productId)]);
  return {
    approvedToday: approved.reduce((n, a) => n + a._count._all, 0),
    cap: workspaceDailyCap(cfg.cap, now),
    pending: pending.reduce((n, a) => n + a._count._all, 0),
    byProduct: [...ids].map((id) => ({
      productId: id,
      name: products.find((p) => p.id === id)?.name ?? "—",
      pending: pending.find((p) => p.productId === id)?._count._all ?? 0,
      approvedToday: approved.find((p) => p.productId === id)?._count._all ?? 0,
    })),
  };
}
