"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { emitWebhookEvent } from "../webhooks/emit";
import type { DocumentType, DocumentStatus } from "@prisma/client";
import { requireGrant, requireOwner } from "@/lib/authz";
import { callClaude } from "@/lib/ai/call-claude";
import { DOC_SCOPE_SYSTEM, buildScopeMessage } from "@/lib/ai/prompts/doc-scope";
import { renderTemplate, findEmptyVariables } from "@/modules/templates/render";
import { computeQuoteTotals, type QuoteItem } from "./quote-math";
import { buildDocumentData } from "./data";
import { enqueueDocumentPdf } from "./enqueue";
import { notifyQuoteDeclined } from "../notifications/notify";
import { brandFrom } from "@/modules/workspaces/brand";
import {
  canCreateContract,
  canCreateCertificate,
  allowedStatusTransition,
} from "./chain";
import {
  contractPayloadFromQuote,
  certificatePayloadFromContract,
  type ContractParty,
} from "./prefill";

export interface QuoteClient {
  leadId: string;
  name: string;
  company: string;
}

export interface QuoteView {
  id: string;
  quoteNumber: string;
  clientName: string;
  items: QuoteItem[];
  vatRatePct: number;
  validUntil: string;
  totals: { net: number; vat: number; gross: number };
  watermark: boolean;
  status: string;
  pdfUrl: string | null;
  finalizedAt: string | null;
}

export async function listQuoteClients(): Promise<QuoteClient[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const leads = await db.lead.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, contactName: true, company: { select: { name: true } } },
  });
  return leads.map((l) => ({
    leadId: l.id,
    name: l.contactName ?? l.company?.name ?? "Unnamed lead",
    company: l.company?.name ?? "—",
  }));
}

const itemSchema = z.object({
  description: z.string().min(1),
  baseNet: z.number().int().min(0),
  preset: z.enum(["none", "passthrough", "production"]),
});

const createSchema = z.object({
  leadId: z.string().min(1),
  /** Which deal this quote belongs to. Resolved from the lead when omitted. */
  dealId: z.string().min(1).optional(),
  items: z.array(itemSchema).min(1),
  vatRatePct: z.number().int().min(0).max(100),
  validUntil: z.string().min(1),
});

/**
 * The deal a document belongs to (P4/b).
 *
 * The chain hangs off the DEAL once one exists — a company that buys twice has
 * two quotes, and hanging both off the lead made them read as one chain with a
 * duplicate step. Prefers the newest OPEN deal: a quote written today is for
 * the sale still being worked, not for the one that closed last spring.
 */
async function dealIdForLead(
  db: ReturnType<typeof getWorkspaceClient>,
  leadId: string | null,
): Promise<string | null> {
  if (!leadId) return null;
  const open = await db.deal.findFirst({
    where: { leadId, status: "OPEN" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (open) return open.id;
  const any = await db.deal.findFirst({
    where: { leadId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return any?.id ?? null;
}

export async function createQuote(raw: unknown): Promise<{ documentId: string }> {
  const input = createSchema.parse(raw);
  await requireGrant("documents.quote.create");
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  // Pin the active HU quote template version (re-renders identically later).
  const template = await db.template.findFirst({
    where: { type: "QUOTE", lang: "HU", status: "ACTIVE" },
    orderBy: { version: "desc" },
    select: { id: true },
  });

  const items = input.items as QuoteItem[];
  const totals = computeQuoteTotals(items, input.vatRatePct);

  const year = new Date().getFullYear();
  const count = await db.document.count({ where: { type: "QUOTE" } });
  const quoteNumber = `Q-${year}-${String(count + 1).padStart(3, "0")}`;

  const doc = await db.document.create({
    data: {
      workspaceId,
      leadId: input.leadId,
      dealId: input.dealId ?? (await dealIdForLead(db, input.leadId)),
      templateVersionId: template?.id ?? null,
      type: "QUOTE",
      status: "DRAFT",
      watermark: true,
      number: quoteNumber,
      payload: { items, vatRatePct: input.vatRatePct, validUntil: input.validUntil, quoteNumber },
      totals,
    },
  });
  revalidatePath("/documents");
  return { documentId: doc.id };
}

export async function getQuote(documentId: string): Promise<QuoteView | null> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const doc = await db.document.findUnique({
    where: { id: documentId },
    include: { lead: { select: { contactName: true, company: { select: { name: true } } } } },
  });
  if (!doc) return null;
  const payload = (doc.payload ?? {}) as {
    items?: QuoteItem[];
    vatRatePct?: number;
    validUntil?: string;
    quoteNumber?: string;
  };
  const totals = (doc.totals ?? { net: 0, vat: 0, gross: 0 }) as {
    net: number;
    vat: number;
    gross: number;
  };
  return {
    id: doc.id,
    quoteNumber: payload.quoteNumber ?? "",
    clientName: doc.lead?.contactName ?? doc.lead?.company?.name ?? "—",
    items: payload.items ?? [],
    vatRatePct: payload.vatRatePct ?? 27,
    validUntil: payload.validUntil ?? "",
    totals,
    watermark: doc.watermark,
    status: doc.status,
    pdfUrl: doc.pdfUrl,
    finalizedAt: doc.finalizedAt ? doc.finalizedAt.toISOString() : null,
  };
}

export async function exportQuotePdf(documentId: string): Promise<{ ok: true }> {
  await requireGrant("documents.quote.create");
  const { workspaceId } = await getActiveContext();
  await enqueueDocumentPdf({ documentId, workspaceId });
  return { ok: true };
}

/** Owner-gated, audited finalization — removes the DRAFT watermark. Blocked if
 * any template variable would render empty (spec §4.9–4.10). */
export async function markFinal(
  documentId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireOwner();
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const doc = await db.document.findUnique({
    where: { id: documentId },
    include: {
      template: true,
      lead: { include: { company: true } },
    },
  });
  if (!doc) throw new Error("Document not found");
  if (!doc.template) {
    return { ok: false, error: "No template pinned to this document." };
  }

  const workspace = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { legalName: true, brand: true },
  });
  const templateData = buildDocumentData(doc, workspace);
  const empties = findEmptyVariables(doc.template.body, templateData);
  if (empties.length > 0) {
    return {
      ok: false,
      error: `Cannot finalize — these variables render empty: ${empties.join(", ")}.`,
    };
  }
  // touch render to ensure it doesn't throw
  renderTemplate(doc.template.body, templateData);

  await db.document.update({
    where: { id: documentId },
    data: { watermark: false, finalizedAt: new Date(), finalizedBy: userId },
  });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "document.finalize",
      entityType: "Document",
      entityId: documentId,
      meta: { removedWatermark: true },
    },
  });
  // Outbound (P5/5.2). Finalizing is the moment a draft becomes a document
  // somebody can act on, which is what an integration is waiting for.
  await emitWebhookEvent(workspaceId, "document.finalized", {
    documentId,
    type: doc.type,
    leadId: doc.leadId ?? null,
  });
  revalidatePath("/documents");
  return { ok: true };
}

// ---- Chain: contract + certificate generation, status, chain view ----------

const GRANT_FOR_TYPE: Record<DocumentType, string> = {
  QUOTE: "documents.quote.create",
  CONTRACT: "documents.contract.create",
  CERTIFICATE: "documents.certificate.create",
};

const overridesSchema = z
  .object({
    scope: z.string().optional(),
    milestones: z.string().optional(),
    payment_terms: z.string().optional(),
    deliverables: z.string().optional(),
  })
  .optional();

export interface ContractPrefill {
  scope: string;
  milestones: string;
  payment_terms: string;
  clientLegalName: string;
}

export interface ChainDocView {
  id: string;
  type: DocumentType;
  status: DocumentStatus;
  watermark: boolean;
  pdfUrl: string | null;
  number: string;
}

export interface ChainSummary {
  rootId: string;
  clientName: string;
  docs: ChainDocView[];
}

function docNumber(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  return String(p.quoteNumber ?? p.contractNumber ?? p.certNumber ?? "");
}

async function partyFor(
  quoteId: string,
  workspaceId: string,
): Promise<{
  party: ContractParty;
  items: QuoteItem[];
  leadId: string;
  dealId: string | null;
  status: DocumentStatus;
}> {
  const db = getWorkspaceClient(workspaceId);
  const quote = await db.document.findUnique({
    where: { id: quoteId },
    include: { lead: { include: { company: { include: { registry: true } } } } },
  });
  if (!quote || quote.type !== "QUOTE") throw new Error("Quote not found");
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { legalName: true, brand: true },
  });
  const company = quote.lead?.company;
  const registry = company?.registry;
  const party: ContractParty = {
    clientLegalName: registry?.legalName ?? company?.name ?? "",
    clientTaxId: registry?.taxId ?? company?.taxId ?? "",
    contractorLegalName: ws?.legalName ?? brandFrom(ws?.brand).legalName,
  };
  const items = ((quote.payload ?? {}) as { items?: QuoteItem[] }).items ?? [];
  return {
    party,
    items,
    leadId: quote.leadId ?? "",
    dealId: quote.dealId ?? null,
    status: quote.status,
  };
}

export async function getContractPrefill(quoteId: string): Promise<ContractPrefill> {
  await requireGrant("documents.contract.create");
  const { workspaceId } = await getActiveContext();
  const { party, items } = await partyFor(quoteId, workspaceId);
  const p = contractPayloadFromQuote(items, party, "");
  return {
    scope: p.scope,
    milestones: p.milestones,
    payment_terms: p.payment_terms,
    clientLegalName: party.clientLegalName,
  };
}

export async function createContractFromQuote(
  quoteId: string,
  raw?: unknown,
): Promise<{ ok: true; documentId: string } | { ok: false; error: string }> {
  const overrides = overridesSchema.parse(raw);
  await requireGrant("documents.contract.create");
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const { party, items, leadId, status, dealId } = await partyFor(quoteId, workspaceId);
  if (!canCreateContract(status)) {
    return { ok: false, error: "The quote must be accepted before generating a contract." };
  }

  const year = new Date().getFullYear();
  const count = await db.document.count({ where: { type: "CONTRACT" } });
  const contractNumber = `SZ-${year}-${String(count + 1).padStart(3, "0")}`;
  const payload = contractPayloadFromQuote(items, party, contractNumber, overrides);

  const template = await db.template.findFirst({
    where: { type: "CONTRACT", lang: "HU", status: "ACTIVE" },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  const doc = await db.document.create({
    data: {
      workspaceId,
      leadId: leadId || null,
      // A chained document inherits its parent's deal, which is what keeps
      // quote -> contract -> certificate one chain rather than three orphans.
      dealId,
      chainParentId: quoteId,
      templateVersionId: template?.id ?? null,
      type: "CONTRACT",
      number: contractNumber,
      status: "DRAFT",
      watermark: true,
      payload,
    },
  });
  revalidatePath("/documents");
  revalidatePath("/pipeline");
  return { ok: true, documentId: doc.id };
}

export async function createCertificateFromContract(
  contractId: string,
  raw?: unknown,
): Promise<{ ok: true; documentId: string } | { ok: false; error: string }> {
  const overrides = overridesSchema.parse(raw);
  await requireGrant("documents.certificate.create");
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const contract = await db.document.findUnique({ where: { id: contractId } });
  if (!contract || contract.type !== "CONTRACT") throw new Error("Contract not found");
  if (!canCreateCertificate(contract.status)) {
    return { ok: false, error: "The contract must be signed before issuing a certificate." };
  }

  const scope = ((contract.payload ?? {}) as { scope?: string }).scope ?? "";
  const year = new Date().getFullYear();
  const count = await db.document.count({ where: { type: "CERTIFICATE" } });
  const certNumber = `TIG-${year}-${String(count + 1).padStart(3, "0")}`;
  const date = new Date().toISOString().slice(0, 10);
  const payload = certificatePayloadFromContract({ scope }, date, certNumber, overrides);

  const template = await db.template.findFirst({
    where: { type: "CERTIFICATE", lang: "HU", status: "ACTIVE" },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  const doc = await db.document.create({
    data: {
      workspaceId,
      leadId: contract.leadId,
      dealId: contract.dealId,
      chainParentId: contractId,
      templateVersionId: template?.id ?? null,
      type: "CERTIFICATE",
      number: certNumber,
      status: "DRAFT",
      watermark: true,
      payload,
    },
  });
  revalidatePath("/documents");
  revalidatePath("/pipeline");
  return { ok: true, documentId: doc.id };
}

export async function advanceStatus(
  documentId: string,
  to: DocumentStatus,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const doc = await db.document.findUnique({
    where: { id: documentId },
    select: { type: true, status: true, leadId: true, payload: true },
  });
  if (!doc) throw new Error("Document not found");
  if (!allowedStatusTransition(doc.type, doc.status, to)) {
    return { ok: false, error: `Cannot move ${doc.type} from ${doc.status} to ${to}.` };
  }
  await requireGrant(GRANT_FOR_TYPE[doc.type]);
  await db.document.update({
    where: { id: documentId },
    data: {
      status: to,
      // The referral sweep counts fourteen days from HERE (v4 P13/3), so the
      // moment is stamped rather than inferred from `updatedAt` — which moves
      // whenever anything touches the row.
      ...(doc.type === "CERTIFICATE" && to === "ACKNOWLEDGED"
        ? { acknowledgedAt: new Date() }
        : {}),
    },
  });

  // P6/1. Acceptance has its own public path (acceptance.ts); this is the only
  // route by which a quote is DECLINED, so the notification belongs here.
  if (doc.type === "QUOTE" && to === "DECLINED") {
    await notifyQuoteDeclined({
      workspaceId,
      documentId,
      leadId: doc.leadId,
      number: String((doc.payload as Record<string, unknown>)?.quoteNumber ?? documentId),
    });
  }
  revalidatePath("/documents");
  revalidatePath("/pipeline");
  return { ok: true };
}

async function walkChain(workspaceId: string, rootId: string): Promise<ChainDocView[]> {
  const db = getWorkspaceClient(workspaceId);
  const chain: ChainDocView[] = [];
  let node = await db.document.findUnique({
    where: { id: rootId },
    select: { id: true, type: true, status: true, watermark: true, pdfUrl: true, payload: true },
  });
  while (node) {
    chain.push({
      id: node.id,
      type: node.type,
      status: node.status,
      watermark: node.watermark,
      pdfUrl: node.pdfUrl,
      number: docNumber(node.payload),
    });
    node = await db.document.findFirst({
      where: { chainParentId: node.id },
      select: { id: true, type: true, status: true, watermark: true, pdfUrl: true, payload: true },
    });
  }
  return chain;
}

export async function getChain(documentId: string): Promise<ChainDocView[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  let cur = await db.document.findUnique({
    where: { id: documentId },
    select: { id: true, chainParentId: true },
  });
  while (cur?.chainParentId) {
    cur = await db.document.findUnique({
      where: { id: cur.chainParentId },
      select: { id: true, chainParentId: true },
    });
  }
  return walkChain(workspaceId, cur?.id ?? documentId);
}

export async function listChains(): Promise<ChainSummary[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const roots = await db.document.findMany({
    where: { type: "QUOTE", chainParentId: null },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { lead: { select: { contactName: true, company: { select: { name: true } } } } },
  });
  const out: ChainSummary[] = [];
  for (const r of roots) {
    out.push({
      rootId: r.id,
      clientName: r.lead?.contactName ?? r.lead?.company?.name ?? "—",
      docs: await walkChain(workspaceId, r.id),
    });
  }
  return out;
}

/** Optional, labeled Claude scope-paragraph assist — never in the render path. */
export async function draftScopeParagraph(quoteId: string): Promise<{ text: string }> {
  await requireGrant("documents.contract.create");
  const { workspaceId } = await getActiveContext();
  const { items } = await partyFor(quoteId, workspaceId);
  const { data } = await callClaude({
    useCase: "doc_scope",
    workspaceId,
    system: DOC_SCOPE_SYSTEM,
    messages: [{ role: "user", content: buildScopeMessage(items) }],
  });
  return { text: data as string };
}
