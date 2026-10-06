/**
 * Restoring a rejected or filtered-out candidate (history & recovery).
 *
 * A restore is a person overruling an earlier decision — theirs, a
 * colleague's, or the ICP filter's — so it puts the candidate back in the
 * approval queue for a second look. It does NOT overrule the facts that keep
 * a company out for good. Every restore first re-runs the checks that are
 * true today, not when the candidate was refused:
 *
 *   - suppression (the address, the domain, the tax number);
 *   - already a client;
 *   - already in the CRM (a company or a lead that is not this candidate's);
 *   - being worked in another run;
 *   - data freshness: a datasheet past its 90-day life is refreshed (one
 *     interactive lookup) and the registry status re-read.
 *
 * Anything that blocks is REPORTED, never silently overridden.
 *
 * Three ways back in:
 *   - requeue     — the draft is recent (≤ 30 days): it returns as it was;
 *   - regenerate  — the draft is older: the stale copy is superseded and a new
 *                   draft is written against today's data (one budgeted call);
 *   - redraft     — there never was a draft (filtered before drafting): the
 *                   contact is resolved if needed and a draft is written.
 *
 * Every restore is audit-logged with who, why and how, and the candidate
 * re-enters the queue flagged as restored.
 */
import type { CandidateState, Prisma } from "@prisma/client";
import type { WorkspaceClient } from "@/lib/db";
import { cachedDatasheet, getDatasheet } from "@/modules/registry/registry-service";
import type { CompanyDatasheet } from "@/modules/registry/datasheet";
import { cegadatTaxId } from "@/modules/registry/cegadat";
import { isCompanySuppressed } from "@/modules/mail/suppression";
import { normalizeEmail } from "@/modules/leads/dedupe";
import type { VerifyResult } from "@/modules/verification/types";
import { buildFacts, type AuditForFacts, type CandidateFact } from "./facts";
import { resolveContact, type ResolvedContact } from "./contact";
import { domainOf } from "./pool";
import { IN_FLIGHT_STATES, transition } from "./state";

export const STALE_DRAFT_DAYS = 30;
const SHEET_FRESH_DAYS = 90;
export const BULK_RESTORE_MAX = 25;
const RESTORABLE: CandidateState[] = ["REJECTED", "FILTERED_OUT"];

export type RestoreMode = "requeue" | "regenerate" | "redraft";

export interface RestorePreview {
  candidateId: string;
  restorable: boolean;
  blockers: string[];
  notes: string[];
  mode: RestoreMode | null;
  draftAgeDays: number | null;
}

export interface RestoreDeps {
  now: () => Date;
  /** Writes a draft for a CONTACT_RESOLVED candidate (the budgeted Claude call). */
  draft: (workspaceId: string, candidateId: string) => Promise<"drafted" | "no_hook" | "budget" | "skipped" | "error">;
  readSite: (url: string) => Promise<{ emails: string[]; phones: string[]; names: string[] } | null>;
  verify: (email: string) => Promise<VerifyResult>;
}

export type RestoreResult =
  | { ok: true; mode: RestoreMode; state: CandidateState }
  | { ok: false; blockers: string[] };

function ageDays(d: Date, now: Date): number {
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000);
}

async function latestDraft(db: WorkspaceClient, candidateId: string) {
  return db.outreachDraft.findFirst({
    where: { candidateId, step: 0, supersededAt: null },
    orderBy: { createdAt: "desc" },
  });
}

/** The checks that hold today. Read-only — the preview and the restore share them. */
export async function previewRestore(db: WorkspaceClient, workspaceId: string, candidateId: string, now: Date = new Date()): Promise<RestorePreview> {
  const out: RestorePreview = { candidateId, restorable: false, blockers: [], notes: [], mode: null, draftAgeDays: null };
  const c = await db.prospectCandidate.findUnique({ where: { id: candidateId }, include: { pool: true } });
  if (!c) return { ...out, blockers: ["That candidate no longer exists."] };
  if (!RESTORABLE.includes(c.state)) return { ...out, blockers: [`Only rejected or filtered-out candidates can be restored; this one is ${c.state.toLowerCase().replace(/_/g, " ")}.`] };

  const contact = (c.contact ?? null) as ResolvedContact | null;
  const draft = await latestDraft(db, c.id);
  const tax = c.taxNumber ? cegadatTaxId(c.taxNumber) : null;
  const domain = domainOf(c.website) ?? domainOf(c.pool.website) ?? c.pool.domain;
  const email = draft?.toAddress ?? contact?.email ?? null;

  // Suppression.
  const suppressed = (await db.suppression.findMany({ select: { address: true } })).map((s) => s.address);
  if (isCompanySuppressed({ domain, taxNumber: tax, emails: email ? [email] : [] }, suppressed)) {
    out.blockers.push("The company or its address is on the suppression list — it asked not to be contacted.");
  }

  // Already a client, or already in the CRM.
  const companies = await db.company.findMany({
    where: {
      mergedIntoId: null,
      OR: [...(tax ? [{ taxId: tax }] : []), ...(domain ? [{ domain }] : [])],
      ...(c.companyId ? { NOT: { id: c.companyId } } : {}),
    },
    select: { id: true, name: true, clientStatus: true },
  });
  const client = companies.find((x) => x.clientStatus === "CLIENT");
  if (client) out.blockers.push(`${client.name} is already a client.`);
  else if (companies[0]) out.blockers.push(`${companies[0].name} is already in the CRM — work it from there.`);
  const normalized = normalizeEmail(email);
  if (normalized) {
    const lead = await db.lead.findFirst({
      where: { email: normalized, mergedIntoId: null, ...(c.leadId ? { NOT: { id: c.leadId } } : {}) },
      select: { contactName: true },
    });
    if (lead) out.blockers.push(`${lead.contactName ?? normalized} is already a lead in the CRM.`);
  }

  // Being worked in another run.
  const elsewhere = await db.prospectCandidate.findFirst({
    where: { poolId: c.poolId, NOT: { id: c.id }, state: { in: [...IN_FLIGHT_STATES] } },
    select: { state: true },
  });
  if (elsewhere) out.blockers.push(`This company is already in another run (${elsewhere.state.toLowerCase().replace(/_/g, " ")}).`);

  // Freshness.
  if (tax) {
    const sheet = await db.registrySheet.findUnique({ where: { workspaceId_taxNumber: { workspaceId, taxNumber: tax } } });
    if (!sheet || ageDays(sheet.fetchedAt, now) > SHEET_FRESH_DAYS) {
      out.notes.push("The company datasheet is older than 90 days and will be refreshed (one registry lookup).");
    }
  }

  // How it comes back.
  if (draft) {
    out.draftAgeDays = ageDays(draft.createdAt, now);
    if (out.draftAgeDays > STALE_DRAFT_DAYS) {
      out.mode = "regenerate";
      out.notes.push(`The draft is ${out.draftAgeDays} days old; a new one is written against today's data instead of resending it.`);
    } else {
      out.mode = "requeue";
    }
  } else {
    out.mode = "redraft";
    out.notes.push(contact?.email ? "There was no draft yet; one is written now." : "No contact was resolved yet; the address is looked up and a draft written now.");
  }

  out.restorable = out.blockers.length === 0;
  return out;
}

async function freshSheet(
  db: WorkspaceClient,
  workspaceId: string,
  taxNumber: string,
  userId: string,
  now: Date,
): Promise<{ sheet: CompanyDatasheet | null; blocker?: string }> {
  const cached = await cachedDatasheet(workspaceId, taxNumber);
  if (cached && ageDays(cached.fetchedAt, now) <= SHEET_FRESH_DAYS) return { sheet: cached.sheet };
  const res = await getDatasheet(workspaceId, taxNumber, { purpose: "INTERACTIVE", userId, forceRefresh: true, now });
  if (res.status === "ok") return { sheet: res.sheet };
  if (res.status === "quota_exhausted") return { sheet: null, blocker: "The datasheet is stale and this month's registry lookups are used up." };
  if (res.status === "not_found") return { sheet: null, blocker: "The registry no longer knows this company." };
  return { sheet: cached?.sheet ?? null };
}

export async function restoreCandidate(
  db: WorkspaceClient,
  workspaceId: string,
  input: { candidateId: string; userId: string; note?: string | null },
  deps: RestoreDeps,
): Promise<RestoreResult> {
  const now = deps.now();
  const preview = await previewRestore(db, workspaceId, input.candidateId, now);
  if (!preview.restorable || !preview.mode) return { ok: false, blockers: preview.blockers };
  const c = await db.prospectCandidate.findUniqueOrThrow({ where: { id: input.candidateId } });
  const from = c.state;
  const fromReason = c.reason;

  // Freshness, now for real: a stale datasheet is refreshed, and a company
  // that is no longer active does not come back.
  let sheet: CompanyDatasheet | null = null;
  const tax = c.taxNumber ? cegadatTaxId(c.taxNumber) : null;
  if (tax) {
    const f = await freshSheet(db, workspaceId, tax, input.userId, now);
    if (f.blocker) return { ok: false, blockers: [f.blocker] };
    sheet = f.sheet;
    if (sheet?.status && sheet.status.toLowerCase() !== "aktív") {
      return { ok: false, blockers: [`The registry now lists the company as "${sheet.status}".`] };
    }
  }

  const stamp: Prisma.ProspectCandidateUpdateInput = {
    restoredAt: now,
    restoredById: input.userId,
    restoreNote: input.note?.trim() || null,
    restoreCount: { increment: 1 },
    reasonDetail: null,
    parkedUntil: null,
    lastError: null,
  };
  const detail = `restored (${preview.mode})${input.note?.trim() ? `: ${input.note.trim()}` : ""}`;

  if (preview.mode === "requeue") {
    const draft = await latestDraft(db, c.id);
    await db.outreachDraft.update({
      where: { id: draft!.id },
      data: { status: "PENDING", rejectReason: null, rejectNote: null, decidedAt: null, decidedById: null, openedAt: null, openedById: null },
    });
    await transition(db, workspaceId, c, "PENDING_APPROVAL", { restore: true, reason: null, detail, userId: input.userId, data: stamp, at: now });
  } else {
    if (preview.mode === "regenerate") {
      const draft = await latestDraft(db, c.id);
      if (draft) await db.outreachDraft.update({ where: { id: draft.id }, data: { supersededAt: now, status: draft.status === "PENDING" ? "CANCELLED" : draft.status } });
    }
    // Make sure there is someone to write to and something to say, from
    // today's data — then hand it to the drafting engine.
    let contact = (c.contact ?? null) as ResolvedContact | null;
    let facts = Array.isArray(c.facts) ? (c.facts as unknown as CandidateFact[]) : [];
    if (sheet || facts.length === 0) {
      const audit = c.auditId ? await db.auditResult.findUnique({ where: { id: c.auditId } }) : null;
      const usable =
        audit?.status === "done"
          ? ({
              score: audit.score,
              flags: Array.isArray(audit.flags) ? (audit.flags as string[]) : [],
              checks: Array.isArray(audit.checks) ? (audit.checks as unknown as AuditForFacts["checks"]) : [],
              url: audit.url,
            } satisfies AuditForFacts)
          : null;
      const website = c.website ?? sheet?.website ?? null;
      const fresh = buildFacts({ sheet, audit: usable, noWebsite: !website, now });
      // Today's registry figures replace yesterday's; audit and site findings
      // are kept unless there is a newer audit to take them from — a missing
      // re-audit must not erase what the message was built on.
      facts = usable
        ? fresh
        : [...fresh.filter((f) => f.kind === "registry"), ...facts.filter((f) => f.kind !== "registry"), ...fresh.filter((f) => f.kind === "site" && !facts.some((x) => x.id === f.id))];
      if (!sheet) facts = [...facts, ...(Array.isArray(c.facts) ? (c.facts as unknown as CandidateFact[]) : []).filter((f) => f.kind === "registry" && !facts.some((x) => x.id === f.id))];
    }
    if (!contact?.email) {
      const site = c.website ? await deps.readSite(c.website).catch(() => null) : null;
      contact = await resolveContact(
        {
          registry: sheet ? { email: sheet.email, phone: sheet.phone, managers: sheet.managers.map((m) => m.name) } : null,
          site: site ? { emails: site.emails, phones: site.phones, representedBy: site.names } : null,
          crm: [],
        },
        deps.verify,
      );
      if (!contact.email) return { ok: false, blockers: ["No usable email address could be found — the LinkedIn queue is the way to reach this company."] };
    }
    await transition(db, workspaceId, c, "CONTACT_RESOLVED", {
      restore: true,
      reason: null,
      detail,
      userId: input.userId,
      data: {
        ...stamp,
        facts: facts as unknown as Prisma.InputJsonValue,
        contact: contact as unknown as Prisma.InputJsonValue,
        contactName: contact.name ?? contact.managerName,
        contactEmail: contact.email,
      },
      at: now,
    });
    const outcome = await deps.draft(workspaceId, c.id);
    if (outcome !== "drafted") {
      const after = await db.prospectCandidate.findUniqueOrThrow({ where: { id: c.id } });
      const why =
        outcome === "no_hook"
          ? "Regenerating found no company-specific fact to build a message on, so the motor cannot draft it (it stays filtered out as no hook). A person can still write to the company from the Outreach Studio."
          : outcome === "budget"
            ? "Today's Claude budget is used up; the candidate waits as contact-resolved and is drafted on the next run."
            : "The draft could not be written; the candidate waits as contact-resolved and is retried on the next run.";
      await audit(db, workspaceId, input.userId, c.id, { from, fromReason, mode: preview.mode, note: input.note ?? null, outcome, state: after.state });
      return outcome === "no_hook" ? { ok: false, blockers: [why] } : { ok: true, mode: preview.mode, state: after.state };
    }
  }

  const after = await db.prospectCandidate.findUniqueOrThrow({ where: { id: c.id } });
  await audit(db, workspaceId, input.userId, c.id, { from, fromReason, mode: preview.mode, note: input.note ?? null, outcome: "queued", state: after.state });
  return { ok: true, mode: preview.mode, state: after.state };
}

async function audit(db: WorkspaceClient, workspaceId: string, userId: string, candidateId: string, meta: Record<string, unknown>): Promise<void> {
  await db.auditLog.create({
    data: { workspaceId, actorUserId: userId, action: "outbound.candidate.restored", entityType: "ProspectCandidate", entityId: candidateId, meta: meta as Prisma.InputJsonValue },
  });
}

/** Cancel the remaining follow-ups of a sent sequence. The lead is not touched. */
export async function cancelFollowups(db: WorkspaceClient, workspaceId: string, candidateId: string, userId: string, now: Date = new Date()): Promise<{ ok: true; cancelled: number } | { ok: false; error: string }> {
  const c = await db.prospectCandidate.findUnique({ where: { id: candidateId } });
  if (!c || c.state !== "SENT") return { ok: false, error: "Only a sequence that is still running can have its follow-ups cancelled." };
  const r = await db.outreachDraft.updateMany({
    where: { candidateId, step: { gt: 0 }, status: { in: ["PENDING", "APPROVED"] } },
    data: { status: "CANCELLED", sendError: "follow-ups cancelled by hand" },
  });
  await db.prospectCandidate.update({ where: { id: candidateId }, data: { followupsCancelledAt: now } });
  await db.candidateEvent.create({
    data: { workspaceId, candidateId, fromState: "SENT", toState: "SENT", detail: "remaining follow-ups cancelled", userId, at: now },
  });
  await db.auditLog.create({
    data: { workspaceId, actorUserId: userId, action: "outbound.followups.cancelled", entityType: "ProspectCandidate", entityId: candidateId, meta: { cancelledDrafts: r.count } },
  });
  return { ok: true, cancelled: r.count };
}
