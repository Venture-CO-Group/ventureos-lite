/**
 * Company Finder lists — reads and writes, session-free so the actions, the
 * worker and the tests share them. Every query goes through the tenant-guarded
 * client the caller passes in (CLAUDE.md hard rule 1).
 */
import type { FinderList, FinderListStatus, Prisma } from "@prisma/client";
import type { WorkspaceClient } from "@/lib/db";
import { criteriaHash, finderCriteriaSchema, parseCriteria, type FinderCriteria } from "./criteria";

export interface ListStats {
  candidates: number;
  excluded: Record<string, number>;
  /** Pending candidates whose datasheet is in the cache — free to filter. */
  cached: number;
  /** Pending candidates that need a metered lookup. */
  metered: number;
  harvestedAt: string | null;
  fragments: number;
  errors: string[];
}

export const EMPTY_STATS: ListStats = {
  candidates: 0,
  excluded: {},
  cached: 0,
  metered: 0,
  harvestedAt: null,
  fragments: 0,
  errors: [],
};

export function parseStats(raw: unknown): ListStats {
  const o = raw && typeof raw === "object" ? (raw as Partial<ListStats>) : {};
  return {
    candidates: o.candidates ?? 0,
    excluded: o.excluded ?? {},
    cached: o.cached ?? 0,
    metered: o.metered ?? 0,
    harvestedAt: o.harvestedAt ?? null,
    fragments: o.fragments ?? 0,
    errors: Array.isArray(o.errors) ? o.errors : [],
  };
}

export interface ListView {
  id: string;
  name: string;
  criteria: FinderCriteria;
  criteriaHash: string;
  cachedOnly: boolean;
  status: FinderListStatus;
  stats: ListStats;
  message: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  matches: number;
}

export function toListView(l: FinderList, matches = 0): ListView {
  return {
    id: l.id,
    name: l.name,
    criteria: parseCriteria(l.criteria),
    criteriaHash: l.criteriaHash,
    cachedOnly: l.cachedOnly,
    status: l.status,
    stats: parseStats(l.stats),
    message: l.message,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
    lastRunAt: l.lastRunAt?.toISOString() ?? null,
    matches,
  };
}

export interface SaveListInput {
  id?: string;
  name: string;
  criteria?: unknown;
  cachedOnly?: boolean;
}

export type SaveResult = { ok: true; list: FinderList } | { ok: false; error: string };

/** Busy lists cannot change their criteria under a running phase. */
const BUSY: FinderListStatus[] = ["HARVESTING", "ENRICHING", "CONTACTS"];

export async function saveList(
  db: WorkspaceClient,
  workspaceId: string,
  input: SaveListInput,
  userId: string | null,
): Promise<SaveResult> {
  const name = input.name.trim().slice(0, 120);
  if (!name) return { ok: false, error: "Give the list a name." };
  const parsed = finderCriteriaSchema.safeParse(input.criteria ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Those criteria are not valid." };
  const criteria = parsed.data;
  const hash = criteriaHash(criteria);
  const data = {
    name,
    criteria: criteria as unknown as Prisma.InputJsonValue,
    criteriaHash: hash,
    cachedOnly: input.cachedOnly ?? false,
  };
  if (input.id) {
    const existing = await db.finderList.findUnique({ where: { id: input.id } });
    if (!existing) return { ok: false, error: "That list no longer exists." };
    if (BUSY.includes(existing.status) && existing.criteriaHash !== hash) {
      return { ok: false, error: "The list is running; change its criteria once the run pauses or finishes." };
    }
    // New criteria make the phase-1 numbers stale: the list goes back to
    // "not run" for the new definition. Results stay — re-filtering a cached
    // sheet is free, and the next run does exactly that.
    const changed = existing.criteriaHash !== hash || existing.cachedOnly !== data.cachedOnly;
    const list = await db.finderList.update({
      where: { id: input.id },
      data: changed ? { ...data, status: "DRAFT", stats: {}, message: null } : data,
    });
    return { ok: true, list };
  }
  const list = await db.finderList.create({
    data: { workspaceId, ...data, createdById: userId, status: "DRAFT" },
  });
  return { ok: true, list };
}

export async function listLists(db: WorkspaceClient): Promise<ListView[]> {
  const [lists, counts] = await Promise.all([
    db.finderList.findMany({ orderBy: { updatedAt: "desc" }, take: 200 }),
    db.finderResult.groupBy({ by: ["listId"], where: { state: "MATCH" }, _count: { _all: true } }),
  ]);
  const byList = new Map(counts.map((c) => [c.listId, c._count._all]));
  return lists.map((l) => toListView(l, byList.get(l.id) ?? 0));
}

export async function getListView(db: WorkspaceClient, id: string): Promise<ListView | null> {
  const l = await db.finderList.findUnique({ where: { id } });
  if (!l) return null;
  const matches = await db.finderResult.count({ where: { listId: id, state: "MATCH" } });
  return toListView(l, matches);
}
