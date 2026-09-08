"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";
import { AUDIT_LOG_CATEGORIES } from "./categories";
import {
  MAX_AUDIT_RETENTION_DAYS,
  MIN_AUDIT_RETENTION_DAYS,
  auditRetentionDaysFrom,
} from "./retention";

/**
 * Reading the audit log (CLAUDE.md hard rule #8).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The rule says to log every grant change, export, delete, watermark removal
 * and invoice submission — and the codebase does, faithfully, in fifty-one
 * places. Nothing anywhere read a single row back. A log that cannot be
 * inspected is not a control; it is a table that grows.
 *
 * The audience is an Owner answering a question after the fact — "who removed
 * that watermark", "when was this lead erased", "who exported the list". So the
 * surface is a filterable list in reverse chronological order, and nothing
 * else: no editing, no deleting, no bulk anything. An audit log with a delete
 * button answers no question at all.
 */


export interface AuditLogRow {
  id: string;
  at: string;
  action: string;
  actorName: string;
  entityType: string | null;
  entityId: string | null;
  /** The extra context the writer recorded, rendered as one line. */
  detail: string | null;
}

export interface AuditLogPage {
  rows: AuditLogRow[];
  /** Cursor for the next page, or null at the end. */
  nextCursor: string | null;
  total: number;
}

const querySchema = z.object({
  category: z.string().optional(),
  search: z.string().trim().max(120).optional(),
  cursor: z.string().optional(),
});

const PAGE = 50;

/** One line of context from whatever the writer put in `meta`. */
function describe(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const entries = Object.entries(meta as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 80)}`);
  return entries.length > 0 ? entries.join(" · ") : null;
}

export async function readAuditLog(raw: unknown): Promise<AuditLogPage> {
  // Owner-only. The log records who did what, which is exactly the kind of
  // thing a BDR should not be able to browse about their colleagues.
  await requireGrant("audit_log.read");
  const parsed = querySchema.safeParse(raw ?? {});
  const q = parsed.success ? parsed.data : {};

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const category = AUDIT_LOG_CATEGORIES.find((c) => c.id === q.category);
  const prefixFilter =
    category && category.prefixes.length > 0
      ? { OR: category.prefixes.map((p) => ({ action: { startsWith: p } })) }
      : {};
  const searchFilter = q.search
    ? {
        OR: [
          { action: { contains: q.search, mode: "insensitive" as const } },
          { entityId: { contains: q.search } },
        ],
      }
    : {};

  const where = { AND: [prefixFilter, searchFilter].filter((f) => Object.keys(f).length > 0) };

  const [rows, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { at: "desc" },
      take: PAGE + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }),
    db.auditLog.count({ where }),
  ]);

  const page = rows.slice(0, PAGE);

  // Actor names come from the global users table — the guarded client does not
  // cover it, and the ids here are this workspace's own actors.
  const actorIds = [...new Set(page.map((r) => r.actorUserId).filter(Boolean))] as string[];
  const users = actorIds.length
    ? await prismaUnsafe.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name || u.email]));

  return {
    rows: page.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      action: r.action,
      // A system action has no actor, and saying "—" is more honest than
      // attributing it to whoever happened to be signed in.
      actorName: r.actorUserId ? (nameById.get(r.actorUserId) ?? "ismeretlen felhasználó") : "rendszer",
      entityType: r.entityType,
      entityId: r.entityId,
      detail: describe(r.meta),
    })),
    nextCursor: rows.length > PAGE ? page[page.length - 1]!.id : null,
    total,
  };
}


// ---------------------------------------------------------------------------
// export and retention (P5/5.3)
// ---------------------------------------------------------------------------

/**
 * The whole log, as CSV.
 *
 * ── WHY THIS MATTERS MORE THAN A CONVENIENCE ────────────────────────────────
 *
 * The log was readable on screen, twenty-five rows at a time, and could not
 * leave the product. The first request in a data-protection incident is an
 * extract of it — and "log in and scroll" is not an answer to a regulator, a
 * client's security questionnaire, or a lawyer.
 *
 * Exporting the audit log is itself audit-logged. A record of who read the
 * record of who did what is not paranoia; it is the same reason every other
 * export here is logged.
 */
export async function exportAuditLog(
  raw: unknown,
): Promise<{ ok: true; csv: string; rows: number } | { ok: false; error: string }> {
  try {
    await requireGrant("audit_log.read");
  } catch {
    return { ok: false, error: "You need the audit_log.read capability." };
  }
  const parsed = z
    .object({
      /** ISO dates. Both optional — the default is everything. */
      from: z.string().optional(),
      to: z.string().optional(),
    })
    .safeParse(raw ?? {});
  const q = parsed.success ? parsed.data : {};

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const where: Record<string, unknown> = {};
  if (q.from || q.to) {
    where.at = {
      ...(q.from ? { gte: new Date(q.from) } : {}),
      ...(q.to ? { lte: new Date(`${q.to}T23:59:59.999Z`) } : {}),
    };
  }

  const rows = await db.auditLog.findMany({
    where,
    orderBy: { at: "asc" },
    // Bounded: a year of a busy workspace is tens of thousands of rows, and a
    // CSV that cannot be built is worse than one that says it was trimmed.
    take: 50_000,
    select: {
      at: true,
      actorUserId: true,
      action: true,
      entityType: true,
      entityId: true,
      meta: true,
    },
  });

  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((v): v is string => !!v))];
  const actors = actorIds.length
    ? await prismaUnsafe.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  // Resolved to a NAME, not left as an id. An extract whose actor column holds
  // cuids answers "somebody" to every question worth asking.
  const actorLabel = new Map(actors.map((a) => [a.id, `${a.name} <${a.email}>`]));

  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = ["at", "actor", "action", "entity_type", "entity_id", "meta"].join(",");
  const lines = rows.map((r) =>
    [
      r.at.toISOString(),
      r.actorUserId ? (actorLabel.get(r.actorUserId) ?? r.actorUserId) : "system",
      r.action,
      r.entityType ?? "",
      r.entityId ?? "",
      r.meta ? JSON.stringify(r.meta) : "",
    ]
      .map((c) => esc(String(c)))
      .join(","),
  );

  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "audit_log.exported",
      meta: { rows: rows.length, from: q.from ?? null, to: q.to ?? null },
    },
  });

  return { ok: true, csv: [header, ...lines].join("\n"), rows: rows.length };
}

export interface AuditRetentionView {
  /** Days to keep. 0 means for ever. */
  days: number;
  total: number;
  /** How many rows the current setting would remove on the next sweep. */
  expiring: number;
  oldest: string | null;
  canEdit: boolean;
}

export async function getAuditRetention(): Promise<AuditRetentionView> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { featureFlags: true },
  });
  const days = auditRetentionDaysFrom(ws?.featureFlags);

  const [total, oldest] = await Promise.all([
    db.auditLog.count(),
    db.auditLog.findFirst({ orderBy: { at: "asc" }, select: { at: true } }),
  ]);
  const expiring =
    days > 0
      ? await db.auditLog.count({
          where: { at: { lt: new Date(Date.now() - days * 86_400_000) } },
        })
      : 0;

  let canEdit = false;
  try {
    await requireGrant("settings.manage");
    canEdit = true;
  } catch {
    canEdit = false;
  }
  return { days, total, expiring, oldest: oldest?.at.toISOString() ?? null, canEdit };
}

export async function setAuditRetention(
  days: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireGrant("settings.manage");
  } catch {
    return { ok: false, error: "You need the settings.manage capability." };
  }
  const value = Math.round(days);
  // Zero means keep for ever. Anything between 1 and 89 is refused: a log that
  // rotates faster than a quarter cannot answer a question about last quarter,
  // which is the main thing anybody asks it.
  if (value !== 0 && (value < MIN_AUDIT_RETENTION_DAYS || value > MAX_AUDIT_RETENTION_DAYS)) {
    return {
      ok: false,
      error: `Adj meg 0-t (örökre) vagy ${MIN_AUDIT_RETENTION_DAYS}–${MAX_AUDIT_RETENTION_DAYS} nap közötti értéket — egy negyedévnél rövidebb napló nem tud válaszolni a legutóbbi negyedévre.`,
    };
  }

  const { workspaceId, userId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { featureFlags: true },
  });
  const flags =
    ws?.featureFlags && typeof ws.featureFlags === "object" && !Array.isArray(ws.featureFlags)
      ? (ws.featureFlags as Record<string, unknown>)
      : {};

  await prismaUnsafe.workspace.update({
    where: { id: workspaceId },
    data: { featureFlags: { ...flags, auditLogRetentionDays: value } },
  });
  const db = getWorkspaceClient(workspaceId);
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "audit_log.retention_changed",
      entityType: "Workspace",
      entityId: workspaceId,
      meta: { days: value },
    },
  });
  revalidatePath("/settings/admin");
  return { ok: true };
}
