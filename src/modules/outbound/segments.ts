/**
 * Segment storage helpers shared by the actions and the jobs. Not a server
 * action module: a worker seeds a workspace's taxonomy the same way a page
 * does, without a session.
 */
import type { WorkspaceClient } from "@/lib/db";
import { DEFAULT_SEGMENTS } from "./segments-seed";
import { toSegmentView, type SegmentView } from "./catalog";

/**
 * Seed the 19 defaults for a workspace that has none, and add any default
 * key that is missing. Never overwrites an edited segment: once a workspace
 * has tuned its fragments, a deploy must not quietly put the old ones back.
 */
export async function ensureSegments(db: WorkspaceClient, workspaceId: string): Promise<void> {
  const existing = await db.segment.findMany({ select: { key: true } });
  const have = new Set(existing.map((s) => s.key));
  const missing = DEFAULT_SEGMENTS.filter((s) => !have.has(s.key));
  if (missing.length === 0) return;
  await db.segment.createMany({
    data: missing.map((s) => ({
      workspaceId,
      key: s.key,
      name: s.name,
      teaorInclude: s.teaorInclude,
      teaorExclude: s.teaorExclude,
      fragments: s.fragments,
      seedList: s.seedList as object[],
      sourcingHint: s.sourcingHint,
    })),
    skipDuplicates: true,
  });
}

export async function loadSegments(db: WorkspaceClient, workspaceId: string): Promise<SegmentView[]> {
  await ensureSegments(db, workspaceId);
  const rows = await db.segment.findMany({ orderBy: { name: "asc" } });
  return rows.map(toSegmentView);
}
