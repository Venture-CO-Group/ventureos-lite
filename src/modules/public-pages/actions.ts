"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";
import { auditShareLink, bookingLink, quoteAcceptLink } from "@/lib/public-links";
import { isShareExpired } from "@/modules/audit/share";
import { pageStatsBatch, type PageStats } from "@/modules/tracking/data";

/**
 * The Public Pages screen (spec §4.4 / §4.9 / §4.21) — one place to see every
 * prospect-facing URL this workspace has handed out, whether it still resolves,
 * and whether anyone opened it.
 *
 * The nav entry existed with no href and no screen behind it. The three public
 * ROUTES worked; what was missing was any way for an operator to find the links
 * or tell a live one from an expired one.
 *
 * Everything here is workspace-scoped through getWorkspaceClient (hard rule #1).
 */

/**
 * What the signal layer adds to a row (playbook-v3 P8/d).
 *
 * `openCount` on a share used to be the whole story: one integer, no idea who,
 * no idea for how long. These four fields are the answer to "did the RECIPIENT
 * read it", which is the question the page exists for.
 */
export interface PageActivity {
  views: number;
  lastViewAt: string | null;
  avgDurationMs: number;
  viewers: Array<{ name: string; confidence: string; views: number }>;
  unidentified: number;
  recipientViewed: { viewed: boolean; times: number; confidence: string } | null;
}

export interface AuditShareRow {
  id: string;
  slug: string;
  url: string;
  companyName: string;
  auditUrl: string;
  score: number | null;
  expiresAt: string;
  expired: boolean;
  firstOpenedAt: string | null;
  openCount: number;
  activity: PageActivity | null;
}

export interface QuoteLinkRow {
  id: string;
  number: string;
  url: string;
  clientName: string;
  status: string;
  acceptedByName: string | null;
  acceptedAt: string | null;
  slug: string;
  activity: PageActivity | null;
}

export interface BookingPageRow {
  id: string;
  slug: string;
  url: string;
  title: string;
  hostName: string;
  active: boolean;
  upcomingMeetings: number;
  activity: PageActivity | null;
}

export interface PublicPagesView {
  shares: AuditShareRow[];
  quotes: QuoteLinkRow[];
  bookings: BookingPageRow[];
}

/** Hostname of an audited URL, without the www. prefix. Null if unparseable. */
function hostOf(url: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export async function getPublicPages(): Promise<PublicPagesView> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const now = new Date();

  const [shares, quotes, bookings] = await Promise.all([
    db.auditShare.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        audit: {
          select: { url: true, score: true, companyId: true, company: { select: { name: true } } },
        },
      },
    }),
    db.document.findMany({
      where: { type: "QUOTE", acceptSlug: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        lead: { select: { contactName: true, companyId: true, company: { select: { name: true } } } },
        acceptances: { orderBy: { at: "desc" }, take: 1 },
      },
    }),
    db.bookingPage.findMany({ orderBy: { createdAt: "asc" } }),
  ]);

  // Host names and meeting counts are per booking page; fetch once, not per row.
  const hostIds = [...new Set(bookings.map((b) => b.hostUserId))];
  // `users` is a global table, not workspace-scoped — the guarded client does
  // not cover it. Safe here: the ids come from this workspace's booking pages.
  const hosts = hostIds.length
    ? await prismaUnsafe.user.findMany({
        where: { id: { in: hostIds } },
        select: { id: true, name: true },
      })
    : [];
  const hostName = new Map(hosts.map((h) => [h.id, h.name]));

  /**
   * One query for every page's readership (P8/d), not one per row.
   *
   * Slugs from all three kinds go in together: a visit row is keyed by slug and
   * slugs are unique across the three, so the buckets cannot collide.
   */
  const activity = await pageStatsBatch(workspaceId, [
    ...shares.map((s) => s.slug),
    ...quotes.map((d) => d.acceptSlug!).filter(Boolean),
    ...bookings.map((b) => b.slug),
  ]);

  /** Company the page was addressed to, so "did THEY read it" is answerable. */
  const shareTarget = new Map(shares.map((s) => [s.slug, s.audit.companyId ?? null]));
  const quoteTarget = new Map(
    quotes.map((d) => [d.acceptSlug!, d.lead?.companyId ?? null]),
  );

  const toActivity = (slug: string, targetCompanyId: string | null): PageActivity | null => {
    const stats: PageStats | undefined = activity.get(slug);
    if (!stats) return null;
    const recipient = targetCompanyId
      ? stats.viewers.find((v) => v.companyId === targetCompanyId)
      : undefined;
    return {
      views: stats.views,
      lastViewAt: stats.lastViewAt?.toISOString() ?? null,
      avgDurationMs: stats.avgDurationMs,
      viewers: stats.viewers.slice(0, 6).map((v) => ({
        name: v.name,
        confidence: v.confidence,
        views: v.views,
      })),
      unidentified: stats.unidentified,
      recipientViewed: targetCompanyId
        ? {
            viewed: !!recipient,
            times: recipient?.views ?? 0,
            confidence: recipient?.confidence ?? "none",
          }
        : null,
    };
  };

  const counts = await Promise.all(
    bookings.map((b) =>
      db.meeting.count({ where: { hostUserId: b.hostUserId, scheduledAt: { gte: now } } }),
    ),
  );

  return {
    shares: shares.map((s) => ({
      id: s.id,
      slug: s.slug,
      url: auditShareLink(s.slug),
      // Audits started before companyId was populated (and any run against a
      // URL we hold no company for) still have something meaningful to show:
      // the audited host beats a bare dash.
      companyName: s.audit.company?.name ?? hostOf(s.audit.url) ?? "—",
      auditUrl: s.audit.url,
      score: s.audit.score,
      expiresAt: s.expiresAt.toISOString(),
      expired: isShareExpired(s.expiresAt, now),
      firstOpenedAt: s.firstOpenedAt?.toISOString() ?? null,
      openCount: s.openCount,
      activity: toActivity(s.slug, shareTarget.get(s.slug) ?? null),
    })),
    quotes: quotes.map((d) => ({
      id: d.id,
      number: d.number ?? "—",
      url: quoteAcceptLink(d.acceptSlug!),
      clientName: d.lead?.company?.name ?? d.lead?.contactName ?? "—",
      status: d.status,
      acceptedByName: d.acceptances[0]?.acceptedByName ?? null,
      acceptedAt: d.acceptances[0]?.at.toISOString() ?? null,
      slug: d.acceptSlug!,
      activity: toActivity(d.acceptSlug!, quoteTarget.get(d.acceptSlug!) ?? null),
    })),
    bookings: bookings.map((b, i) => ({
      id: b.id,
      slug: b.slug,
      url: bookingLink(b.slug),
      title: b.title ?? "Book a call",
      hostName: hostName.get(b.hostUserId) ?? "—",
      active: b.active,
      upcomingMeetings: counts[i] ?? 0,
      // A booking page is not addressed to anyone, so there is no recipient
      // question to answer — only how many people opened it.
      activity: toActivity(b.slug, null),
    })),
  };
}

/** Revoke a share immediately by expiring it (the link 410s from then on). */
export async function revokeAuditShare(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z.object({ shareId: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown share." };

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const share = await db.auditShare.findUnique({
    where: { id: parsed.data.shareId },
    select: { id: true, slug: true },
  });
  if (!share) return { ok: false, error: "Share not found." };

  await db.auditShare.update({
    where: { id: share.id },
    // Backdate rather than delete: the audit trail of who opened it survives.
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "public.share_revoked",
      entityType: "AuditShare",
      entityId: share.id,
      meta: { slug: share.slug },
    },
  });
  revalidatePath("/public-pages");
  return { ok: true };
}

/**
 * Delete a share link outright — Owner only.
 *
 * Revoke and delete are different acts and the operator asked for both. Revoke
 * backdates the expiry and keeps the row, so who opened it and when survives;
 * delete removes the link from the list entirely, which is what you want for one
 * created by mistake or for a prospect who asked to be forgotten.
 *
 * Because the row carries the only record of the opens, the audit entry copies
 * them: the count and the first open are written into `meta` BEFORE the delete,
 * so destroying the row does not destroy the fact that it was read. Owner-only
 * for the same reason (hard rule 8: every delete is audited).
 *
 * The slug is not reused — it is a cuid-scale random string, and a deleted one
 * simply 404s, which is the correct answer for a link that no longer exists.
 */
export async function deleteAuditShare(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireGrant("public_pages.manage");
  } catch {
    return { ok: false, error: "You need the public_pages.manage capability to delete a share link." };
  }
  const parsed = z.object({ shareId: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown share." };

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const share = await db.auditShare.findUnique({
    where: { id: parsed.data.shareId },
    select: {
      id: true,
      slug: true,
      openCount: true,
      firstOpenedAt: true,
      expiresAt: true,
      auditId: true,
    },
  });
  if (!share) return { ok: false, error: "Share not found." };

  // The log first, so the evidence exists even if the delete fails.
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "public.share_deleted",
      entityType: "AuditShare",
      entityId: share.id,
      meta: {
        slug: share.slug,
        auditId: share.auditId,
        openCount: share.openCount,
        firstOpenedAt: share.firstOpenedAt?.toISOString() ?? null,
        expiresAt: share.expiresAt.toISOString(),
      },
    },
  });
  await db.auditShare.delete({ where: { id: share.id } });

  revalidatePath("/public-pages");
  return { ok: true };
}

/** Take a booking page offline (or back online) — Owner only. */
export async function setBookingPageActive(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireGrant("public_pages.manage");
  } catch {
    return { ok: false, error: "You need the public_pages.manage capability to change the booking page." };
  }
  const parsed = z
    .object({ bookingPageId: z.string().min(1), active: z.boolean() })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the request." };

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const page = await db.bookingPage.findUnique({
    where: { id: parsed.data.bookingPageId },
    select: { id: true, slug: true },
  });
  if (!page) return { ok: false, error: "Booking page not found." };

  await db.bookingPage.update({
    where: { id: page.id },
    data: { active: parsed.data.active },
  });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: parsed.data.active ? "public.booking_enabled" : "public.booking_disabled",
      entityType: "BookingPage",
      entityId: page.id,
      meta: { slug: page.slug },
    },
  });
  revalidatePath("/public-pages");
  return { ok: true };
}
