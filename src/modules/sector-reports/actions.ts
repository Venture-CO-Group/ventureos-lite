"use server";

import { z } from "zod";
import { randomBytes } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { revalidatePath } from "next/cache";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";
import { callClaude } from "@/lib/ai/call-claude";
import { BudgetExceededError } from "@/lib/ai/budget";
import { renderHtmlToPdf } from "@/lib/pdf";
import { brandFrom } from "@/modules/workspaces/brand";
import { estimateProspectCostUsd } from "@/modules/prospector/cost";
import { sectorReportLink, appLink } from "@/lib/public-links";
import {
  SECTOR_REPORT_SYSTEM,
  sectorReportSchema,
  buildSectorReportMessage,
  type SectorNarrative,
} from "@/lib/ai/prompts/sector-report";
import { renderSectorReportHtml } from "./pdf";
import { findIdentifiers, MIN_PUBLISHABLE, type SectorStats } from "./stats";
import { enqueueSectorBatch } from "./enqueue";
import { draftTeaserPosts } from "./teasers";

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

export interface SectorReportRow {
  id: string;
  title: string;
  sector: string;
  location: string;
  status: string;
  slug: string | null;
  cap: number;
  foundCount: number;
  auditedCount: number;
  costUsd: number;
  hasPdf: boolean;
  publishedAt: string | null;
  createdAt: string;
  downloads: number;
  note: string | null;
}

export async function listSectorReports(): Promise<SectorReportRow[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.sectorReport.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { _count: { select: { downloads: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    sector: r.sector,
    location: r.location,
    status: r.status,
    slug: r.slug,
    cap: r.cap,
    foundCount: r.foundCount,
    auditedCount: r.auditedCount,
    costUsd: Number(r.costUsd),
    hasPdf: !!r.pdfPath,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    downloads: r._count.downloads,
    note: ((r.stats ?? {}) as { note?: string }).note ?? null,
  }));
}

/** What a batch would cost before anyone spends it (P12/2a). */
export async function previewSectorCost(cap: number): Promise<{ usd: number; audits: number }> {
  const n = Math.min(60, Math.max(1, Math.round(cap)));
  return { usd: estimateProspectCostUsd({ expectedResults: n }), audits: n };
}

const startSchema = z.object({
  sector: z.string().trim().min(2).max(80),
  location: z.string().trim().min(2).max(80),
  cap: z.coerce.number().int().min(MIN_PUBLISHABLE).max(60),
  title: z.string().trim().max(160).optional(),
});

/**
 * Start a batch. Owner-only, because it spends money on searches and audits and
 * ends in something published under the company's name.
 */
export async function startSectorReport(
  raw: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  await requireGrant("sector_reports.manage");
  const parsed = startSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `Adj meg szektort, területet és legalább ${MIN_PUBLISHABLE} oldalt.` };
  }
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const input = parsed.data;

  const year = new Date().getFullYear();
  const report = await db.sectorReport.create({
    data: {
      workspaceId,
      sector: input.sector,
      location: input.location,
      cap: input.cap,
      title:
        input.title?.trim() ||
        `A ${input.location.toLowerCase()} ${input.sector.toLowerCase()} szakma digitális állapota ${year}`,
      status: "running",
      createdBy: userId,
    },
    select: { id: true },
  });

  await enqueueSectorBatch(report.id);
  revalidatePath("/reports-admin");
  return { ok: true, id: report.id };
}

/**
 * Write the prose and render the PDF (P12/2b).
 *
 * One Sonnet call, on a report whose numbers are already fixed. The model never
 * sees a company, a domain or a URL — `stats` has nowhere to put one.
 */
export async function generateSectorReport(
  reportId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireGrant("sector_reports.manage");
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const report = await db.sectorReport.findUnique({ where: { id: reportId } });
  if (!report) return { ok: false, error: "Report not found." };
  if (report.status !== "ready" && report.status !== "published") {
    return { ok: false, error: "A riport még nem áll készen — a mérések futnak." };
  }
  const stats = (report.stats ?? null) as (SectorStats & { auditIds?: string[] }) | null;
  if (!stats || stats.audited < MIN_PUBLISHABLE) {
    return { ok: false, error: `Túl kicsi a minta (${MIN_PUBLISHABLE} oldal az alsó határ).` };
  }

  let narrative: SectorNarrative;
  try {
    const { data } = await callClaude({
      useCase: "sector_report",
      workspaceId,
      system: SECTOR_REPORT_SYSTEM,
      schema: sectorReportSchema,
      messages: [
        {
          role: "user",
          content: buildSectorReportMessage({
            sector: report.sector,
            location: report.location,
            found: stats.found,
            audited: stats.audited,
            scoreMedian: stats.scoreMedian,
            scoreBands: stats.scoreBands,
            loadMsMedian: stats.loadMsMedian,
            failing: stats.failing,
            categories: stats.categories.map((c) => ({ category: c.category, median: c.median })),
          }),
        },
      ],
    });
    narrative = data as SectorNarrative;
  } catch (e) {
    if (e instanceof BudgetExceededError) return { ok: false, error: e.message };
    return { ok: false, error: "A szöveg nem készült el. Próbáld újra." };
  }

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { brand: true },
  });
  const html = renderSectorReportHtml({
    title: report.title,
    sector: report.sector,
    location: report.location,
    brand: brandFrom(ws?.brand),
    stats,
    narrative,
    ctaUrl: appLink("/").replace(/^https?:\/\//, "").replace(/\/$/, ""),
    generatedOn: new Date().toISOString().slice(0, 10),
  });

  /**
   * THE ANONYMITY CHECK, on the rendered artifact rather than on the inputs.
   *
   * The playbook asks for a test; this is the same check running in production,
   * because a test proves the code was right on the day it ran and this proves
   * the document is right before anybody can download it. A hit is a refusal,
   * not a warning.
   */
  const identifiers = findIdentifiers(html);
  if (identifiers.length > 0) {
    return {
      ok: false,
      error: `A riport azonosítható adatot tartalmaz (${identifiers.slice(0, 3).join(", ")}) — nem publikálható.`,
    };
  }

  const pdf = await renderHtmlToPdf(html);
  const rel = `sector-reports/${report.id}.pdf`;
  const abs = join(FILES_DIR, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, pdf);

  await db.sectorReport.update({
    where: { id: reportId },
    data: { narrative: narrative as unknown as object, pdfPath: rel },
  });
  revalidatePath("/reports-admin");
  return { ok: true };
}

export async function publishSectorReport(
  reportId: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  await requireGrant("sector_reports.manage");
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const report = await db.sectorReport.findUnique({ where: { id: reportId } });
  if (!report) return { ok: false, error: "Report not found." };
  if (!report.pdfPath) return { ok: false, error: "Előbb készítsd el a riportot." };

  const slug = report.slug ?? randomBytes(9).toString("base64url");
  await db.sectorReport.update({
    where: { id: reportId },
    data: { slug, status: "published", publishedAt: report.publishedAt ?? new Date() },
  });

  /**
   * Three teaser drafts in the Content Hub (playbook-v4 P12/2d).
   *
   * Written from the report's own numbers — no Claude call, because the
   * headline of a teaser IS a statistic and the statistic is already computed.
   * They land as DRAFTS and go through the same review as anything else.
   */
  if (!report.publishedAt) {
    await draftTeaserPosts(db, workspaceId, {
      title: report.title,
      sector: report.sector,
      location: report.location,
      stats: (report.stats ?? null) as SectorStats | null,
      url: sectorReportLink(slug),
    }).catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[sector] teaser drafts failed", e);
    });
  }

  revalidatePath("/reports-admin");
  revalidatePath("/content");
  return { ok: true, url: sectorReportLink(slug) };
}

export async function unpublishSectorReport(reportId: string): Promise<{ ok: true }> {
  await requireGrant("sector_reports.manage");
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.sectorReport.update({ where: { id: reportId }, data: { status: "ready" } });
  revalidatePath("/reports-admin");
  return { ok: true };
}
