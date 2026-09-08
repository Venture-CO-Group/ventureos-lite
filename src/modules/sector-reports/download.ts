"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { emitLeadCreated } from "@/modules/webhooks/emit";
import { consentSnapshot } from "@/modules/public-audit/consent-text";
import { normalizeDomain } from "@/modules/leads/domain";
import { sectorReportLink } from "@/lib/public-links";
import { takeRateLimit } from "@/lib/rate-limit";
import { ipPrefix } from "@/modules/public-audit/guard";

/**
 * "Send me the report" (playbook-v4 P12/2c).
 *
 * The SAME dual-consent shape as the self-serve audit, deliberately: one
 * required box that exists so there is something to deliver and a basis to hold
 * an address, and one separate, unchecked box that is the only lawful basis for
 * writing to them afterwards. A download without the second box gets the report
 * and NOTHING else — the lead is created, and it is visibly restricted.
 */
const schema = z.object({
  slug: z.string().trim().min(1).max(64),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200),
  companyName: z.string().trim().max(160).optional(),
  serviceConsent: z.literal(true),
  marketingConsent: z.boolean(),
  /** Honeypot — a real person leaves it empty. */
  website: z.string().max(200).optional(),
});

export type DownloadResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export async function requestSectorReport(raw: unknown): Promise<DownloadResult> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Add meg a neved és egy működő e-mail-címet." };
  }
  const input = parsed.data;
  if (input.website) return { ok: false, error: "Valami nem stimmelt az űrlappal." };

  const report = await prismaUnsafe.sectorReport.findUnique({
    where: { slug: input.slug },
    select: { id: true, workspaceId: true, sector: true, status: true, pdfPath: true },
  });
  if (!report || report.status !== "published" || !report.pdfPath) {
    return { ok: false, error: "Ez a riport nem érhető el." };
  }

  const h = await headers();
  const ip = h.get("x-forwarded-for") ?? h.get("x-real-ip");
  const rate = await takeRateLimit(`sector-download:${ipPrefix(ip) ?? "unknown"}`, {
    windowMs: 24 * 60 * 60 * 1000,
    max: 10,
  });
  if (!rate.allowed) {
    return { ok: false, error: "Mára elfogyott a letöltési keret erről a hálózatról." };
  }

  const db = getWorkspaceClient(report.workspaceId);
  const consent = consentSnapshot("hu");
  const email = input.email.toLowerCase();

  /**
   * One lead per address, tagged with the sector it came from.
   *
   * A person who downloads three reports is one prospect with three interests,
   * not three prospects — so the signal is added rather than the lead
   * duplicated.
   */
  const existing = await db.lead.findFirst({ where: { email }, select: { id: true, signals: true } });
  const signal = `Szektor-riport: ${report.sector}`;
  let leadId = existing?.id ?? null;

  if (existing) {
    const signals = Array.isArray(existing.signals) ? (existing.signals as string[]) : [];
    if (!signals.includes(signal)) {
      await db.lead.update({
        where: { id: existing.id },
        data: { signals: [...signals, signal] },
      });
    }
  } else {
    const domain = normalizeDomain(email.split("@")[1] ?? "");
    const company = input.companyName?.trim()
      ? await db.company.create({
          data: { workspaceId: report.workspaceId, name: input.companyName.trim(), domain: domain ?? undefined },
        })
      : null;
    const lead = await db.lead.create({
      data: {
        workspaceId: report.workspaceId,
        contactName: input.name,
        email,
        companyId: company?.id,
        source: "MANUAL",
        stage: "RESEARCHED",
        signals: [signal],
      },
      select: { id: true },
    });
    leadId = lead.id;
    await emitLeadCreated(report.workspaceId, lead.id);
  }

  await db.sectorReportDownload.create({
    data: {
      workspaceId: report.workspaceId,
      reportId: report.id,
      name: input.name,
      email,
      companyName: input.companyName?.trim() || null,
      serviceConsent: true,
      marketingConsent: input.marketingConsent,
      consentTextVersion: consent.version,
      ip: ip?.split(",")[0]?.trim() ?? null,
      userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
      leadId,
    },
  });

  return { ok: true, url: `${sectorReportLink(input.slug)}/pdf` };
}
