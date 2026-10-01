/**
 * Running a sourcing run in the worker (playbook-v6 F3). One job = a few
 * passes; while audits are outstanding the job re-enqueues itself a minute
 * later rather than holding a worker slot, and a quota pause simply stops —
 * the nightly sweep resumes paused runs (F6).
 */
import { outboundQueue } from "@/lib/queue";
import { advanceRun, type RunDeps } from "./run-engine";
import { productionRunDeps } from "./run-deps";

export interface RunJobData {
  workspaceId: string;
  runId: string;
  attempt?: number;
}

/** Audits are polled for at most this many re-enqueues (≈ an hour). */
const MAX_ATTEMPTS = 60;

export async function enqueueRunPass(data: RunJobData, delayMs = 0): Promise<void> {
  const attempt = data.attempt ?? 0;
  await outboundQueue().add("run-pass", { ...data, attempt }, {
    // One id per attempt: BullMQ refuses a duplicate id, which is what keeps
    // a double-click or a retried enqueue from running two passes at once.
    jobId: `run-${data.runId}-${attempt}`,
    delay: delayMs,
    removeOnComplete: true,
    removeOnFail: 100,
  });
}

export async function processRunPass(data: RunJobData, depsOverride?: RunDeps): Promise<string> {
  const deps = depsOverride ?? (await productionRunDeps(data.workspaceId, await draftDeps()));
  let outcome = await advanceRun(data.workspaceId, data.runId, deps);
  // Several quick passes while there is work and nothing to wait for.
  for (let i = 0; i < 4 && outcome.again && outcome.status === "RUNNING"; i++) {
    outcome = await advanceRun(data.workspaceId, data.runId, deps);
  }
  const attempt = data.attempt ?? 0;
  if (outcome.again && attempt < MAX_ATTEMPTS) {
    await enqueueRunPass({ ...data, attempt: attempt + 1 }, outcome.status === "AWAITING_AUDITS" ? 60_000 : 0);
  }
  return outcome.status;
}

/** The drafting hook — absent until drafting is wired (F4). */
async function draftDeps(): Promise<Partial<RunDeps>> {
  return {};
}
