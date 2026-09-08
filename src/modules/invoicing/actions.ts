"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { emitWebhookEvent } from "../webhooks/emit";
import { requireGrant, requireOwner } from "@/lib/authz";
import { composeFromCertificate } from "./data";
import { confirmationHash, ConfirmationError, type InvoicePayload } from "./logic";
import { runInvoiceSubmit } from "./submit";

function agentKeyOf(featureFlags: unknown): string {
  const flags = featureFlags && typeof featureFlags === "object" && !Array.isArray(featureFlags) ? (featureFlags as Record<string, unknown>) : {};
  const sz = flags.szamlazz && typeof flags.szamlazz === "object" ? (flags.szamlazz as Record<string, unknown>) : {};
  return typeof sz.agentKey === "string" ? sz.agentKey : "";
}

// ---- prepare (diff-style confirmation preview; no submit) ------------------

export interface InvoicePreview {
  payload: InvoicePayload;
  confirmationHash: string;
  quoteNumber: string;
  hasAgentKey: boolean;
}

export async function prepareInvoice(
  certificateId: string,
): Promise<{ ok: true; preview: InvoicePreview } | { ok: false; error: string }> {
  try {
    await requireGrant("documents.send");
  } catch {
    return { ok: false, error: "You need the documents.send grant to invoice." };
  }
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { featureFlags: true } });

  const composed = await composeFromCertificate(db, certificateId, new Date());
  if (!composed.ok) return { ok: false, error: composed.error };

  // Record the intent as a PREPARED invoice on the chain (idempotent).
  const existing = await db.invoice.findFirst({ where: { documentId: certificateId } });
  if (!existing) await db.invoice.create({ data: { workspaceId, documentId: certificateId, status: "PREPARED" } });

  return {
    ok: true,
    preview: {
      payload: composed.value.payload,
      confirmationHash: confirmationHash(composed.value.payload),
      quoteNumber: composed.value.quoteNumber,
      hasAgentKey: agentKeyOf(ws?.featureFlags) !== "",
    },
  };
}

// ---- submit (explicit confirm only, grant-gated, audit-logged) ------------

const submitSchema = z.object({ certificateId: z.string().min(1), confirmedHash: z.string().min(1) });

export async function submitInvoice(
  raw: unknown,
): Promise<{ ok: true; invoiceNumber?: string } | { ok: false; error: string }> {
  try {
    await requireGrant("documents.send");
  } catch {
    return { ok: false, error: "You need the documents.send grant to submit invoices." };
  }
  const parsed = submitSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Missing confirmation." };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { featureFlags: true } });

  // Audit the submission attempt (accounting is consequential — spec §4.23).
  await db.auditLog.create({
    data: { workspaceId, actorUserId: userId, action: "invoice.submit", entityType: "Document", entityId: parsed.data.certificateId },
  });

  try {
    const res = await runInvoiceSubmit(db, {
      workspaceId,
      certificateId: parsed.data.certificateId,
      confirmedHash: parsed.data.confirmedHash,
      agentKey: agentKeyOf(ws?.featureFlags),
      actorUserId: userId,
      now: new Date(),
    });
    revalidatePath("/documents");
    revalidatePath("/pipeline");
    if (!res.ok) return { ok: false, error: res.error ?? "Submission failed — see Today Queue." };
    await db.auditLog.create({
      data: { workspaceId, actorUserId: userId, action: "invoice.issued", entityType: "Document", entityId: parsed.data.certificateId, meta: { number: res.invoiceNumber } },
    });
    // Outbound (P5/5.2) — after Számlázz.hu confirmed the number, never
    // before. An accounting system told about an invoice that does not exist
    // is worse than one told nothing.
    await emitWebhookEvent(workspaceId, "invoice.issued", {
      certificateId: parsed.data.certificateId,
      invoiceNumber: res.invoiceNumber,
    });
    return { ok: true, invoiceNumber: res.invoiceNumber };
  } catch (e) {
    if (e instanceof ConfirmationError) {
      return { ok: false, error: "Please confirm the invoice exactly as shown before submitting." };
    }
    throw e;
  }
}

// ---- read (pipeline / documents) ------------------------------------------

export interface InvoiceState {
  status: string;
  number: string | null;
  pdfUrl: string | null;
}


// ---- config (Owner) -------------------------------------------------------

export async function hasSzamlazzKey(): Promise<boolean> {
  const { workspaceId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { featureFlags: true } });
  return agentKeyOf(ws?.featureFlags) !== "";
}

export async function setSzamlazzKey(agentKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can set the Számla Agent key." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { featureFlags: true } });
  const flags = ws?.featureFlags && typeof ws.featureFlags === "object" && !Array.isArray(ws.featureFlags) ? (ws.featureFlags as Record<string, unknown>) : {};
  await prismaUnsafe.workspace.update({
    where: { id: workspaceId },
    data: { featureFlags: { ...flags, szamlazz: { agentKey } } },
  });
  const db = getWorkspaceClient(workspaceId);
  await db.auditLog.create({ data: { workspaceId, actorUserId: userId, action: "szamlazz.key_set" } });
  revalidatePath("/settings");
  return { ok: true };
}
