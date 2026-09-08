"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { takeRateLimit } from "@/lib/rate-limit";
import { clientIp, RATE_LIMITS } from "@/lib/rate-limit-policy";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";
import { generateSlug } from "@/modules/audit/share";
import { quoteAcceptLink } from "@/lib/public-links";
import { getMailProvider } from "@/modules/mail/provider";
import { brandEmail, brandEmailText } from "@/modules/mail/layout";
import { resolveSendingIdentity } from "@/modules/mail/identity";
import { computeLineTotal, formatHuf, type QuoteItem } from "./quote-math";
import { getAcceptanceProvider } from "./acceptance-provider";
import { notifyQuoteAccepted } from "../notifications/notify";
import { onQuoteAccepted } from "../workflow/triggers";
import { emitWebhookEvent } from "../webhooks/emit";
import { brandFrom, type WorkspaceBrand } from "@/modules/workspaces/brand";

export interface PublicQuote {
  quoteNumber: string;
  workspaceLegalName: string;
  clientCompany: string;
  validUntil: string;
  items: Array<{ description: string; line: string }>;
  net: string;
  vat: string;
  gross: string;
  vatRatePct: number;
  accepted: boolean;
  acceptedByName: string | null;
  /** The OWNING workspace's brand — this page is public and cross-tenant. */
  brand: WorkspaceBrand;
}

/** Publish (or reuse) the unlisted public accept URL for a sent quote. */
export async function publishQuoteAcceptance(
  documentId: string,
): Promise<{ slug: string; url: string }> {
  await requireGrant("documents.send");
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const doc = await db.document.findUnique({
    where: { id: documentId },
    select: { id: true, type: true, acceptSlug: true },
  });
  if (!doc || doc.type !== "QUOTE") throw new Error("Quote not found");

  if (doc.acceptSlug) {
    return { slug: doc.acceptSlug, url: quoteAcceptLink(doc.acceptSlug) };
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const slug = generateSlug();
    try {
      await db.document.update({ where: { id: documentId }, data: { acceptSlug: slug } });
      revalidatePath("/documents");
      return { slug, url: quoteAcceptLink(slug) };
    } catch (e) {
      if (attempt === 3) throw e;
    }
  }
  throw new Error("Could not allocate an accept slug");
}

/** Public render data for the acceptance page (cross-tenant by unlisted slug). */
export async function getPublicQuote(slug: string): Promise<PublicQuote | null> {
  const doc = await prismaUnsafe.document.findFirst({
    where: { acceptSlug: slug },
    include: { lead: { include: { company: true } } },
  });
  if (!doc || doc.type !== "QUOTE") return null;

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: doc.workspaceId },
    // The brand comes from the OWNING workspace, never from a session: this
    // page is public and cross-tenant by design (audit-v2 item 6).
    select: { legalName: true, brand: true },
  });
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
  const accepted = await prismaUnsafe.quoteAcceptance.findFirst({
    where: { documentId: doc.id },
    select: { acceptedByName: true },
  });

  return {
    quoteNumber: payload.quoteNumber ?? "",
    workspaceLegalName: ws?.legalName ?? brandFrom(ws?.brand).legalName,
    clientCompany: doc.lead?.company?.name ?? "",
    validUntil: payload.validUntil ?? "",
    items: (payload.items ?? []).map((i) => ({
      description: i.description,
      line: formatHuf(computeLineTotal(i.baseNet, i.preset)),
    })),
    net: formatHuf(totals.net),
    vat: formatHuf(totals.vat),
    gross: formatHuf(totals.gross),
    vatRatePct: payload.vatRatePct ?? 27,
    accepted: !!accepted,
    acceptedByName: accepted?.acceptedByName ?? null,
    brand: brandFrom(ws?.brand),
  };
}

const acceptSchema = z.object({
  name: z.string(),
  company: z.string(),
  agreed: z.boolean(),
});

async function notifyOwners(
  workspaceId: string,
  payload: unknown,
  name: string,
  documentId: string,
  leadId: string | null,
): Promise<void> {
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { mailgunConfig: true, brand: true },
  });
  const brand = brandFrom(ws?.brand);
  const identity = resolveSendingIdentity(ws?.mailgunConfig, brand);
  const owners = await prismaUnsafe.membership.findMany({
    where: { workspaceId, role: "OWNER" },
    include: { user: { select: { email: true } } },
  });
  const number = String((payload as Record<string, unknown>)?.quoteNumber ?? "");
  const content = {
    brand,
    preheader: `${name} accepted quote ${number}`,
    heading: `Quote ${number} accepted`,
    paragraphs: [
      `${name} accepted quote ${number}.`,
      "Contract generation is now unlocked for this deal.",
    ],
  };
  for (const owner of owners) {
    await getMailProvider().send({
      domain: identity.domain,
      to: owner.user.email,
      from: identity.from,
      replyTo: identity.replyTo || undefined,
      subject: `Quote ${number} accepted`,
      html: brandEmail(content),
      // The same object renders both parts, so they cannot drift apart.
      text: brandEmailText(content),
    });
  }

  // P6/1 — the same news in the bell, for whoever is in the app rather than in
  // their mailbox.
  await notifyQuoteAccepted({
    workspaceId,
    documentId,
    leadId,
    number,
    acceptedBy: name,
  });
}

/** Public accept. Records immutable assent evidence, flips the quote to accepted,
 * notifies the Owner, and unlocks contract generation (spec §4.9). */
export async function acceptQuote(
  slug: string,
  raw: unknown,
): Promise<{ ok: true; already: boolean } | { ok: false; error: string }> {
  // Unauthenticated, and it writes contractual evidence — so it gets an abuse
  // control like every other public route (P6/2). Rate-limited BEFORE parsing,
  // because a limiter that only guards well-formed requests is not a limiter.
  const requestHeaders = await headers();
  const rate = await takeRateLimit(
    `${RATE_LIMITS.quoteAcceptance.bucket}:${clientIp(requestHeaders)}`,
    RATE_LIMITS.quoteAcceptance,
  );
  if (!rate.allowed) {
    return { ok: false, error: "Too many attempts. Please try again shortly." };
  }

  const input = acceptSchema.parse(raw);
  const outcome = getAcceptanceProvider().accept(input);
  if (!outcome.ok) return { ok: false, error: outcome.error ?? "Invalid acceptance." };

  const doc = await prismaUnsafe.document.findFirst({
    where: { acceptSlug: slug },
    select: { id: true, workspaceId: true, leadId: true, type: true, payload: true },
  });
  if (!doc || doc.type !== "QUOTE") return { ok: false, error: "Quote not found." };

  const existing = await prismaUnsafe.quoteAcceptance.findFirst({
    where: { documentId: doc.id },
    select: { id: true },
  });
  if (existing) return { ok: true, already: true };

  const ip = clientIp(requestHeaders) === "unknown" ? "" : clientIp(requestHeaders);
  const userAgent = requestHeaders.get("user-agent") ?? "";

  // Immutable acceptance record (create-only; contractual assent evidence).
  await prismaUnsafe.quoteAcceptance.create({
    data: {
      workspaceId: doc.workspaceId,
      documentId: doc.id,
      acceptedByName: input.name,
      company: input.company,
      ip: ip || null,
      userAgent: userAgent || null,
    },
  });
  await prismaUnsafe.document.update({ where: { id: doc.id }, data: { status: "ACCEPTED" } });
  if (doc.leadId) {
    await prismaUnsafe.activity.create({
      data: {
        workspaceId: doc.workspaceId,
        leadId: doc.leadId,
        type: "quote_accepted",
        payload: { name: input.name, company: input.company, method: outcome.method },
      },
    });
  }
  try {
    await notifyOwners(doc.workspaceId, doc.payload, input.name, doc.id, doc.leadId);
  } catch {
    /* notification best-effort */
  }
  // Workflow rules (P7/5). Best-effort, and after the acceptance is recorded:
  // an automation must never be the reason a client's assent fails to save.
  await onQuoteAccepted(doc.workspaceId, doc.leadId);
  // Outbound (P5/5.2). Same reasoning as the line above, and the same order:
  // the assent is saved before anybody else is told about it.
  await emitWebhookEvent(doc.workspaceId, "document.accepted", {
    documentId: doc.id,
    leadId: doc.leadId,
    acceptedByName: input.name,
    company: input.company,
    method: outcome.method,
  });

  revalidatePath("/documents");
  revalidatePath("/pipeline");
  return { ok: true, already: false };
}
