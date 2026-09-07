"use server";

import { z } from "zod";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";
import { AUDIT_LOG_CATEGORIES } from "./categories";

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
