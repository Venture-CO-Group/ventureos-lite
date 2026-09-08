"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { emitLeadCreated } from "@/modules/webhooks/emit";
import { normalizeDomain } from "@/modules/leads/dedupe";
import { isLocale, DEFAULT_LOCALE, type Locale } from "@/lib/locale";
import { enqueueReportEmail } from "./enqueue";
import { consentSnapshot } from "./consent-text";
import { LANDING_COPY } from "./copy";
import { createTaskFromSignal } from "@/modules/tasks/from-signal";

/**
 * "Send me the report" (P12/1b, 1c).
 *
 * This is the only place on the public surface that takes a person's details,
 * so the rules live here rather than in the form:
 *
 *   - the service checkbox is REQUIRED, because without it there is nothing to
 *     deliver and no basis to hold an address;
 *   - the marketing checkbox is independent and defaults false;
 *   - what they saw is stored with what they ticked.
 *
 * Unauthenticated by design — the caller is a stranger on the public landing.
 * The workspace comes from the audit row, never from the request.
 */
const unlockSchema = z.object({
  publicAuditId: z.string().min(1),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200),
  companyName: z.string().trim().max(200).optional(),
  serviceConsent: z.boolean(),
  marketingConsent: z.boolean(),
  locale: z.string().optional(),
});

export type UnlockResult =
  | { ok: true; alreadySent: boolean }
  | { ok: false; error: "validation" | "consent" | "not_found" | "not_ready"; message: string };

/** The locale off an unparsed payload, for error messages before validation. */
function rawLocale(raw: unknown): unknown {
  return raw && typeof raw === "object" ? (raw as { locale?: unknown }).locale : undefined;
}

export async function unlockFullReport(raw: unknown): Promise<UnlockResult> {
  const parsed = unlockSchema.safeParse(raw);
  // Resolved before validation, because a validation MESSAGE has to be in the
  // visitor's language too.
  const requested = parsed.success ? parsed.data.locale : rawLocale(raw);
  const locale: Locale = isLocale(requested) ? requested : DEFAULT_LOCALE;
  const copy = LANDING_COPY[locale];

  if (!parsed.success) {
    return { ok: false, error: "validation", message: copy.unlock.validationEmail };
  }
  const input = parsed.data;

  // Refused server-side, not merely disabled in the UI: a required consent
  // that only the button enforces is not a consent mechanism.
  if (!input.serviceConsent) {
    return { ok: false, error: "consent", message: copy.unlock.validationConsent };
  }

  const publicAudit = await prismaUnsafe.publicAudit.findUnique({
    where: { id: input.publicAuditId },
    select: { id: true, workspaceId: true, url: true, domain: true, auditId: true, status: true },
  });
  if (!publicAudit) {
    return { ok: false, error: "not_found", message: copy.result.error };
  }
  if (publicAudit.status !== "done" || !publicAudit.auditId) {
    return { ok: false, error: "not_ready", message: copy.result.error };
  }

  // Asking twice is a person clicking twice, not a second request. Deliver
  // once and report success both times.
  const existing = await prismaUnsafe.publicAuditConsent.findFirst({
    where: { publicAuditId: publicAudit.id, email: input.email.toLowerCase() },
    select: { id: true, reportSentAt: true },
  });
  if (existing) return { ok: true, alreadySent: existing.reportSentAt !== null };

  const h = await headers();
  // The FULL address here, unlike the /24 prefix on PublicAudit: this record is
  // evidence that someone asked us for something.
  const ip = (h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "").split(",")[0]?.trim() || null;
  const userAgent = h.get("user-agent")?.slice(0, 300) ?? null;
  const snapshot = consentSnapshot(locale);

  const consent = await prismaUnsafe.publicAuditConsent.create({
    data: {
      workspaceId: publicAudit.workspaceId,
      publicAuditId: publicAudit.id,
      name: input.name,
      email: input.email.toLowerCase(),
      companyName: input.companyName || null,
      serviceConsent: true,
      marketingConsent: input.marketingConsent,
      consentTextVersion: snapshot.version,
      locale,
      ip,
      userAgent,
    },
  });

  // The lead is created regardless of marketing consent — we owe them a report
  // either way, and the record of who asked is not itself outreach. What
  // marketing consent changes is whether they may ever be contacted, which is
  // enforced where audiences are built (campaigns/segment.ts).
  const leadId = await createLeadFromConsent({
    workspaceId: publicAudit.workspaceId,
    auditId: publicAudit.auditId,
    domain: publicAudit.domain,
    url: publicAudit.url,
    name: input.name,
    email: input.email.toLowerCase(),
    companyName: input.companyName || null,
    marketingConsent: input.marketingConsent,
  });

  await prismaUnsafe.publicAuditConsent.update({
    where: { id: consent.id },
    data: { leadId },
  });

  await enqueueReportEmail({
    consentId: consent.id,
    workspaceId: publicAudit.workspaceId,
    auditId: publicAudit.auditId,
    locale,
  });

  return { ok: true, alreadySent: false };
}

/**
 * A same-day task for warm inbound (P3/3).
 *
 * This is the warmest lead the system produces — they came to us, ran their own
 * audit and asked for the report — and a same-day follow-up is the whole point
 * of knowing. Without marketing consent the task says so, because the operator
 * has to know what they may and may not do before they pick up the phone.
 */
async function warmInboundTask(
  db: ReturnType<typeof getWorkspaceClient>,
  input: { url: string; marketingConsent: boolean; name: string },
  leadId: string,
): Promise<void> {
  await createTaskFromSignal(db, {
    workspaceId: (await db.lead.findUnique({ where: { id: leadId }, select: { workspaceId: true } }))!
      .workspaceId,
    title: input.marketingConsent
      ? `Meleg inbound: ${input.name} — keresd meg még ma`
      : `Meleg inbound: ${input.name} — NINCS marketing hozzájárulás`,
    note: input.marketingConsent
      ? `Lefuttatta: ${input.url}. Kezdd a legfontosabb megállapítással.`
      : `Lefuttatta: ${input.url}. Csak a riportot kérte — megkeresésre nincs hozzájárulás.`,
    type: "call",
    entityType: "lead",
    entityId: leadId,
    source: "self_serve_inbound",
    dueInDays: 0,
  });
}

/**
 * Company + Lead for someone who audited their own site.
 *
 * Deduped against what is already there: an inbound request from a company we
 * are already working is a strong signal on an existing lead, not a second
 * copy of it.
 */
async function createLeadFromConsent(input: {
  workspaceId: string;
  auditId: string;
  domain: string;
  url: string;
  name: string;
  email: string;
  companyName: string | null;
  marketingConsent: boolean;
}): Promise<string> {
  const db = getWorkspaceClient(input.workspaceId);
  const domain = normalizeDomain(input.url) ?? input.domain;

  const company =
    (await db.company.findFirst({
      where: { OR: [{ domain }, { website: { contains: domain } }] },
      select: { id: true },
    })) ??
    (await db.company.create({
      data: {
        workspaceId: input.workspaceId,
        name: input.companyName ?? domain,
        domain,
        website: input.url,
      },
      select: { id: true },
    }));

  const existingLead = await db.lead.findFirst({
    where: { companyId: company.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, signals: true },
  });

  const signals = [
    "self-serve audit",
    ...(input.marketingConsent ? ["marketing consent"] : ["no marketing consent"]),
  ];

  if (existingLead) {
    const current = Array.isArray(existingLead.signals) ? (existingLead.signals as string[]) : [];
    await db.lead.update({
      where: { id: existingLead.id },
      data: {
        signals: [...new Set([...current, ...signals])],
        // They came to us. That is worth knowing even on a lead we already had.
        contactName: input.name,
        email: input.email,
      },
    });
    await db.activity.create({
      data: {
        workspaceId: input.workspaceId,
        leadId: existingLead.id,
        type: "self_serve_audit_requested",
        payload: {
          url: input.url,
          marketingConsent: input.marketingConsent,
          headline: "Lefuttatta a saját átvilágítását, és kérte a riportot",
          suggestedTask: "Meleg inbound — keresd meg még ma a legfontosabb megállapítással",
        },
      },
    });
    await warmInboundTask(db, input, existingLead.id);
    return existingLead.id;
  }

  const lead = await db.lead.create({
    data: {
      workspaceId: input.workspaceId,
      companyId: company.id,
      source: "SELF_SERVE_AUDIT",
      stage: "RESEARCHED",
      contactName: input.name,
      email: input.email,
      signals,
    },
    select: { id: true },
  });
  // Outbound (P5/5.2). A warm inbound lead is the event most worth telling
  // another system about, and it is best-effort: emit never throws.
  await emitLeadCreated(input.workspaceId, lead.id);
  await db.activity.create({
    data: {
      workspaceId: input.workspaceId,
      leadId: lead.id,
      type: "self_serve_audit_requested",
      payload: {
        url: input.url,
        marketingConsent: input.marketingConsent,
        headline: "Lefuttatta a saját átvilágítását, és kérte a riportot",
        suggestedTask: "Meleg inbound — keresd meg még ma a legfontosabb megállapítással",
      },
    },
  });
  await warmInboundTask(db, input, lead.id);
  return lead.id;
}
