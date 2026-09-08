"use server";

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { enqueueAudit, enqueuePdfRender } from "./enqueue";
import { auditRowToView } from "./view";
import { generateSlug, shareExpiryFrom, shareUrl } from "./share";
import { normalizeDomain } from "../leads/dedupe";
import { findProspectDuplicate } from "../prospector/dedupe";
import { DEFAULT_CRAWL_CAP, MAX_CRAWL_CAP } from "./crawl";
import type { AuditView } from "./types";

const CACHE_TTL_MS = 30 * 86_400_000;

const startSchema = z.object({
  url: z.string().min(1),
  leadId: z.string().optional(),
  withPitch: z.boolean().optional(),
  /** Internal multi-page crawl (P2/1). */
  crawl: z.boolean().optional(),
  crawlCap: z.number().int().min(1).max(MAX_CRAWL_CAP).optional(),
});

function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export async function startAudit(
  raw: unknown,
): Promise<{ auditId: string; cached: boolean }> {
  const input = startSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const url = normalizeUrl(input.url);

  // 30-day cache per URL (spec §4.4). Skip the cache when a pitch is requested
  // and the cached run doesn't have one — and likewise when a crawl is asked
  // for and the cached run was single-page, which is most of them.
  if (!input.withPitch) {
    const cached = await db.auditResult.findFirst({
      where: {
        url,
        status: "done",
        expiresAt: { gt: new Date() },
        ...(input.crawl ? { crawl: { not: Prisma.DbNull } } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    if (cached) return { auditId: cached.id, cached: true };
  }

  // Link the audit to the company it is about. Nothing set companyId before,
  // so every audit row had a null company and Public Pages rendered "—" for a
  // company that plainly existed. Prefer the lead we were started from; fall
  // back to matching the audited domain against known companies.
  let companyId: string | undefined;
  if (input.leadId) {
    const lead = await db.lead.findUnique({
      where: { id: input.leadId },
      select: { companyId: true },
    });
    companyId = lead?.companyId ?? undefined;
  }
  if (!companyId) {
    const domain = normalizeDomain(url);
    if (domain) {
      const match = await db.company.findFirst({
        where: { OR: [{ domain }, { website: { contains: domain } }] },
        select: { id: true },
      });
      companyId = match?.id;
    }
  }

  const now = new Date();
  const rec = await db.auditResult.create({
    data: {
      workspaceId,
      companyId,
      url,
      status: "queued",
      score: 0,
      verdict: "SKIP",
      flags: [],
      screenshots: {},
      expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
    },
  });

  await enqueueAudit({
    auditId: rec.id,
    workspaceId,
    url,
    leadId: input.leadId,
    withPitch: !!input.withPitch,
    ...(input.crawl
      ? { crawl: { cap: input.crawlCap ?? DEFAULT_CRAWL_CAP } }
      : {}),
  });
  revalidatePath("/audit");
  return { auditId: rec.id, cached: false };
}

export async function getAudit(auditId: string): Promise<AuditView | null> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const a = await db.auditResult.findUnique({ where: { id: auditId } });
  return a ? auditRowToView(a) : null;
}

/** Enqueue the branded PDF render (headless-Chrome pipeline). UI polls pdfPath. */
export async function exportAuditPdf(auditId: string): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  await enqueuePdfRender({ auditId, workspaceId });
  return { ok: true };
}

/** Publish (or reuse) the unlisted, 60-day public share link for an audit. */
export async function publishShare(
  auditId: string,
  leadId?: string,
): Promise<{ slug: string; url: string; expiresAt: string }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const audit = await db.auditResult.findUnique({
    where: { id: auditId },
    select: { id: true, companyId: true },
  });
  if (!audit) throw new Error("Audit not found");

  // Idempotent: reuse a non-expired share for this audit.
  const existing = await db.auditShare.findFirst({
    where: { auditId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return {
      slug: existing.slug,
      url: shareUrl(existing.slug),
      expiresAt: existing.expiresAt.toISOString(),
    };
  }

  // Resolve a lead so opens can be tracked to its timeline (§4.4).
  let resolvedLeadId = leadId ?? null;
  if (!resolvedLeadId && audit.companyId) {
    const lead = await db.lead.findFirst({
      where: { companyId: audit.companyId },
      select: { id: true },
    });
    resolvedLeadId = lead?.id ?? null;
  }

  const expiresAt = shareExpiryFrom(new Date());
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const slug = generateSlug();
    try {
      await db.auditShare.create({
        data: {
          workspaceId,
          auditId,
          leadId: resolvedLeadId ?? undefined,
          slug,
          expiresAt,
        },
      });
      revalidatePath("/audit");
      return { slug, url: shareUrl(slug), expiresAt: expiresAt.toISOString() };
    } catch (e) {
      if (attempt === 3) throw e; // exhausted slug retries
    }
  }
  throw new Error("Could not allocate a share slug");
}

export async function createLeadFromAudit(
  auditId: string,
): Promise<{ ok: true; leadId: string } | { ok: false; duplicateOf: string }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const a = await db.auditResult.findUnique({ where: { id: auditId } });
  if (!a) throw new Error("Audit not found");

  const existing = await db.company.findMany({
    select: { id: true, domain: true, phone: true },
  });
  const dup = findProspectDuplicate({ domain: a.url }, existing);
  if (dup) return { ok: false, duplicateOf: dup.id };

  const domain = normalizeDomain(a.url);
  const flags = Array.isArray(a.flags) ? (a.flags as string[]) : [];
  const company = await db.company.create({
    data: {
      workspaceId,
      name: domain ?? a.url,
      domain: domain ?? undefined,
      website: a.url,
    },
  });
  const lead = await db.lead.create({
    data: {
      workspaceId,
      companyId: company.id,
      source: "PROSPECTOR",
      stage: "RESEARCHED",
      signals: flags,
    },
  });
  revalidatePath("/leads");
  return { ok: true, leadId: lead.id };
}


/**
 * The two screenshots either side of a re-audit (P1/1.2).
 *
 * ── WHY THIS IS WORTH A SCREEN ──────────────────────────────────────────────
 *
 * Every audit already stores a desktop and a mobile capture, and the delta
 * already knows which audit this one is compared against. The two pictures
 * side by side — "this was July, this is now" — is the most persuasive thing
 * the module can produce, and it needs no new data at all: only a view.
 *
 * Returns null when there is nothing honest to show: a first audit has no
 * previous run, and a previous run whose captures failed has no picture. An
 * empty box beside a real screenshot reads as "your site broke", which is a
 * claim we would be inventing.
 */
export interface ScreenshotComparison {
  previousAuditId: string;
  previousAt: string;
  currentAt: string;
  scoreFrom: number;
  scoreTo: number;
  before: { desktop?: string; mobile?: string };
  after: { desktop?: string; mobile?: string };
}

export async function getScreenshotComparison(
  auditId: string,
): Promise<ScreenshotComparison | null> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const current = await db.auditResult.findUnique({
    where: { id: auditId },
    select: { id: true, createdAt: true, score: true, screenshots: true, delta: true },
  });
  if (!current) return null;

  const delta =
    current.delta && typeof current.delta === "object" && !Array.isArray(current.delta)
      ? (current.delta as { previousAuditId?: string; scoreFrom?: number })
      : null;
  if (!delta?.previousAuditId) return null;

  const previous = await db.auditResult.findUnique({
    where: { id: delta.previousAuditId },
    select: { id: true, createdAt: true, score: true, screenshots: true },
  });
  if (!previous) return null;

  const shots = (v: unknown): { desktop?: string; mobile?: string } =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as { desktop?: string; mobile?: string })
      : {};

  const before = shots(previous.screenshots);
  const after = shots(current.screenshots);
  // At least one pairing has to exist, or there is nothing to compare.
  const comparable =
    (before.desktop && after.desktop) || (before.mobile && after.mobile);
  if (!comparable) return null;

  return {
    previousAuditId: previous.id,
    previousAt: previous.createdAt.toISOString(),
    currentAt: current.createdAt.toISOString(),
    scoreFrom: previous.score,
    scoreTo: current.score,
    before,
    after,
  };
}
