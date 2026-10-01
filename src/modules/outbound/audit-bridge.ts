/**
 * Starting audits from a run (playbook-v6 F3/6). The same audit engine and
 * the same 30-day cache as a person clicking "Audit site" (spec §4.4), minus
 * the session: a nightly run has a workspace, not a user.
 *
 * The audit queue's own concurrency governs how hard we hit other people's
 * sites, so batching here is only "enqueue them all and wait".
 */
import { getWorkspaceClient } from "@/lib/db";
import { enqueueAudit } from "@/modules/audit/enqueue";

const CACHE_TTL_MS = 30 * 86_400_000;

function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export interface AuditStart {
  auditId: string;
  cached: boolean;
}

export async function startOrReuseAudit(workspaceId: string, rawUrl: string, now: Date = new Date()): Promise<AuditStart> {
  const db = getWorkspaceClient(workspaceId);
  const url = normalizeUrl(rawUrl);
  const reusable = await db.auditResult.findFirst({
    where: {
      url,
      expiresAt: { gt: now },
      // A queued or running audit of the same URL is reused too: two runs
      // must not audit the same site twice in parallel.
      status: { in: ["done", "queued", "running"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });
  if (reusable) return { auditId: reusable.id, cached: reusable.status === "done" };

  const rec = await db.auditResult.create({
    data: {
      workspaceId,
      url,
      status: "queued",
      score: 0,
      verdict: "SKIP",
      flags: [],
      screenshots: {},
      expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
    },
  });
  await enqueueAudit({ auditId: rec.id, workspaceId, url, withPitch: false });
  return { auditId: rec.id, cached: false };
}
