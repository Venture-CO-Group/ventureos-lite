"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { hasGrant } from "@/lib/authz";
import {
  REVIEW_REASONS,
  approveDraft,
  bulkApprove,
  editDraft,
  markOpened,
  rejectDraft,
  routeToLinkedIn,
} from "./approval";
import { domainOf } from "./pool";
import { recordUndo, type UndoToken } from "@/modules/undo/store";
import type { ResolvedContact } from "./contact";

/**
 * The approval queue's actions (playbook-v6 F4/2). All behind
 * `outbound.approve`; every decision carries the reviewer's id.
 */
type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

async function context(): Promise<{ workspaceId: string; userId: string } | null> {
  if (!(await hasGrant("outbound.approve"))) return null;
  const { workspaceId, userId } = await getActiveContext();
  return { workspaceId, userId };
}
const DENIED = { ok: false as const, error: "You do not have permission to review outbound drafts." };

function done(): void {
  revalidatePath("/outbound");
}

export async function openDraft(draftId: string): Promise<Result> {
  const ctx = await context();
  if (!ctx) return DENIED;
  await markOpened(getWorkspaceClient(ctx.workspaceId), draftId, ctx.userId);
  return { ok: true };
}

const textSchema = z.object({ draftId: z.string().min(1), subject: z.string().max(300), body: z.string().max(20_000) });

export async function saveDraftEdit(raw: unknown): Promise<Result> {
  const ctx = await context();
  if (!ctx) return DENIED;
  const p = textSchema.safeParse(raw);
  if (!p.success) return { ok: false, error: "Invalid draft." };
  return editDraft(getWorkspaceClient(ctx.workspaceId), p.data.draftId, p.data);
}

export async function approve(raw: unknown): Promise<Result> {
  const ctx = await context();
  if (!ctx) return DENIED;
  const p = textSchema.partial({ subject: true, body: true }).safeParse(raw);
  if (!p.success) return { ok: false, error: "Invalid draft." };
  const r = await approveDraft(getWorkspaceClient(ctx.workspaceId), ctx.workspaceId, { ...p.data, userId: ctx.userId });
  if (r.ok) done();
  return r;
}

export async function reject(raw: unknown): Promise<Result<{ undo?: UndoToken | null }>> {
  const ctx = await context();
  if (!ctx) return DENIED;
  const p = z
    .object({ draftId: z.string().min(1), reason: z.enum(REVIEW_REASONS), note: z.string().max(1000).nullish() })
    .safeParse(raw);
  if (!p.success) return { ok: false, error: "Pick a reason — a rejection without one teaches the system nothing." };
  const db = getWorkspaceClient(ctx.workspaceId);
  const before = await db.outreachDraft.findUnique({ where: { id: p.data.draftId }, select: { candidateId: true, step: true } });
  const r = await rejectDraft(db, ctx.workspaceId, { ...p.data, userId: ctx.userId });
  if (!r.ok || !before) return r;
  // The common case is a mis-keyed X in fast review: offer the undo toast.
  // Server-side inverse with an expected-state check, like every other undo.
  const cand = await db.prospectCandidate.findUnique({ where: { id: before.candidateId }, select: { name: true } });
  const undo =
    before.step === 0
      ? await recordUndo(ctx.workspaceId, ctx.userId, {
          kind: "outbound_reject",
          label: `Rejected ${cand?.name ?? "draft"}`,
          inverse: { entity: "prospectCandidate", targets: [{ id: before.candidateId, set: { state: "PENDING_APPROVAL" } }] },
          expected: { [before.candidateId]: { state: "REJECTED" } },
        })
      : await recordUndo(ctx.workspaceId, ctx.userId, {
          kind: "outbound_reject",
          label: `Rejected follow-up to ${cand?.name ?? "company"}`,
          inverse: { entity: "outreachDraft", targets: [{ id: p.data.draftId, set: { status: "PENDING" } }] },
          expected: { [p.data.draftId]: { status: "REJECTED" } },
        });
  done();
  return { ok: true, undo };
}

export async function toLinkedIn(draftId: string): Promise<Result> {
  const ctx = await context();
  if (!ctx) return DENIED;
  const r = await routeToLinkedIn(getWorkspaceClient(ctx.workspaceId), ctx.workspaceId, { draftId, userId: ctx.userId });
  if (r.ok) done();
  return r;
}

export async function approveOpened(draftIds: string[]): Promise<Result<{ approved: number; skipped: Array<{ id: string; reason: string }> }>> {
  const ctx = await context();
  if (!ctx) return DENIED;
  const ids = z.array(z.string().min(1)).max(100).safeParse(draftIds);
  if (!ids.success) return { ok: false, error: "Invalid selection." };
  const r = await bulkApprove(getWorkspaceClient(ctx.workspaceId), ctx.workspaceId, { draftIds: ids.data, userId: ctx.userId });
  done();
  return { ok: true, approved: r.approved.length, skipped: r.skipped };
}

// ---- LinkedIn queue ------------------------------------------------------------

/**
 * Hand a LinkedIn-queue company to the Outreach Studio as an ordinary lead.
 * From there the Studio's own rules apply unchanged — including the
 * mandatory human edit (CLAUDE.md hard rule 6, first half). The approval
 * exception does not travel with it.
 */
export async function openInStudio(candidateId: string): Promise<Result<{ leadId: string }>> {
  const ctx = await context();
  if (!ctx) return DENIED;
  const db = getWorkspaceClient(ctx.workspaceId);
  const c = await db.prospectCandidate.findUnique({ where: { id: candidateId } });
  if (!c || c.state !== "LINKEDIN_QUEUE") return { ok: false, error: "That company is no longer in the LinkedIn queue." };
  if (c.leadId) return { ok: true, leadId: c.leadId };
  const contact = (c.contact ?? null) as ResolvedContact | null;
  const domain = domainOf(c.website);
  const company =
    (c.taxNumber ? await db.company.findFirst({ where: { taxId: c.taxNumber } }) : null) ??
    (domain ? await db.company.findFirst({ where: { domain } }) : null) ??
    (await db.company.create({
      data: { workspaceId: ctx.workspaceId, name: c.name, taxId: c.taxNumber, website: c.website, domain, source: "outbound_engine" },
    }));
  const lead = await db.lead.create({
    data: {
      workspaceId: ctx.workspaceId,
      companyId: company.id,
      contactName: contact?.managerName ?? null,
      phone: contact?.phone ?? null,
      source: "OUTBOUND_ENGINE",
      stage: "RESEARCHED",
      notes: "From the outbound LinkedIn queue — no usable email address.",
    },
  });
  await db.prospectCandidate.update({ where: { id: c.id }, data: { leadId: lead.id, companyId: company.id } });
  revalidatePath("/outbound/linkedin");
  return { ok: true, leadId: lead.id };
}
