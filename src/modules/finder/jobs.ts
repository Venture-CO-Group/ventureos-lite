/**
 * Company Finder work in the worker. On the OUTBOUND queue on purpose: that
 * worker runs with concurrency one, so a finder run and a motor run can never
 * race each other for the same day's registry allocation.
 */
import { outboundQueue } from "@/lib/queue";
import { getWorkspaceClient } from "@/lib/db";
import { advanceFinderRun, harvestList, type FinderDeps } from "./engine";

export type FinderJobData =
  | { kind: "harvest"; workspaceId: string; listId: string; attempt?: number }
  | { kind: "pass"; workspaceId: string; runId: string; attempt?: number; passes?: number };

/** Passes per run are bounded, so a misbehaving run cannot loop forever. */
const MAX_PASSES = 500;

export function finderJobId(d: FinderJobData): string {
  return d.kind === "pass" ? `finder-pass-${d.runId}-${d.attempt ?? 0}` : `finder-${d.kind}-${d.listId}-${d.attempt ?? 0}-${Date.now()}`;
}

export async function enqueueFinderJob(data: FinderJobData): Promise<void> {
  await outboundQueue().add(`finder-${data.kind}`, data, {
    // A pass id per attempt: a double-click or retried enqueue cannot run two
    // passes of one run at once.
    jobId: finderJobId(data),
    removeOnComplete: true,
    removeOnFail: 100,
  });
}

export function productionFinderDeps(): FinderDeps {
  return { now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
}

export async function processFinderJob(data: FinderJobData, deps: FinderDeps = productionFinderDeps()): Promise<string> {
  if (data.kind === "harvest") {
    try {
      const r = await harvestList(data.workspaceId, data.listId, deps);
      return r.message;
    } catch (e) {
      await getWorkspaceClient(data.workspaceId).finderList.update({
        where: { id: data.listId },
        data: { status: "FAILED", message: `Harvest failed: ${(e as Error).message.slice(0, 300)}` },
      });
      throw e;
    }
  }
  const outcome = await advanceFinderRun(data.workspaceId, data.runId, deps);
  const attempt = data.attempt ?? 0;
  const passes = data.passes ?? 0;
  if (outcome.again && passes < MAX_PASSES) await enqueueFinderJob({ ...data, attempt: attempt + 1, passes: passes + 1 });
  return outcome.status;
}
