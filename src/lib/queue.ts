import { Queue } from "bullmq";
import IORedis from "ioredis";

/**
 * BullMQ queues (CLAUDE.md: jobs/cron via BullMQ + Redis). Connections and
 * queues are created lazily so importing this module (build, tests, page render)
 * never opens a Redis socket — only the first real enqueue/worker does.
 */
export const FOLLOWUPS_QUEUE = "followups";
export const WAKEUPS_QUEUE = "wakeups";
export const AUDIT_QUEUE = "audits";
export const PDF_QUEUE = "pdfs";
export const CALLBACKS_QUEUE = "callbacks";
export const BRIEFS_QUEUE = "briefs";
export const ERASURE_QUEUE = "erasures";
/** Access-log parsing (P2/8): long-running, streamed, one job per upload. */
export const LOGS_QUEUE = "logs";
export const VISITS_QUEUE = "visits";
export const VERIFY_QUEUE = "verify";
/** The outbound motor: sourcing runs, drafting, approved sends (playbook-v6). */
export const OUTBOUND_QUEUE = "outbound";

/**
 * How many finished jobs each queue keeps (applies to every add, repeatable
 * jobs included, unless the call sets its own).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * BullMQ keeps every completed and failed job until told otherwise. The
 * repeatable sweeps — mail sync every two minutes, webhooks every minute, the
 * outbound send sweep every five — each left a job hash behind on every run,
 * forever. Redis runs with `maxmemory 128mb` and `noeviction` (BullMQ needs
 * it), so after a few weeks every write was refused with "OOM command not
 * allowed" and the worker died on boot. A few hundred recent runs are plenty
 * to debug from; failures are kept longer because they are the ones read.
 */
export const JOB_RETENTION = {
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 1000, age: 14 * 86_400 },
} as const;

/** Every queue the app knows, for housekeeping that must cover all of them. */
export const ALL_QUEUE_NAMES = [
  FOLLOWUPS_QUEUE,
  WAKEUPS_QUEUE,
  AUDIT_QUEUE,
  PDF_QUEUE,
  CALLBACKS_QUEUE,
  BRIEFS_QUEUE,
  ERASURE_QUEUE,
  LOGS_QUEUE,
  VISITS_QUEUE,
  VERIFY_QUEUE,
  OUTBOUND_QUEUE,
] as const;

/**
 * Drop the finished jobs that piled up before `JOB_RETENTION` existed — and
 * keep it that way on every boot. Completed jobs older than an hour go;
 * failed ones are kept two weeks. Best-effort: housekeeping must never stop
 * the worker from starting.
 */
export async function trimFinishedJobs(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of ALL_QUEUE_NAMES) {
    const q = new Queue(name, { connection: getRedisConnection() });
    try {
      let removed = 0;
      // In batches, so one huge backlog cannot block Redis for seconds.
      for (let i = 0; i < 200; i++) {
        const batch = await q.clean(3_600_000, 5000, "completed");
        removed += batch.length;
        if (batch.length < 5000) break;
      }
      for (let i = 0; i < 50; i++) {
        const batch = await q.clean(14 * 86_400_000, 5000, "failed");
        removed += batch.length;
        if (batch.length < 5000) break;
      }
      out[name] = removed;
    } catch {
      out[name] = -1;
    } finally {
      await q.close().catch(() => {});
    }
  }
  return out;
}

let connection: IORedis | null = null;
export function getRedisConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null, // required by BullMQ workers
    });
  }
  return connection;
}

let followups: Queue | null = null;
export function followupsQueue(): Queue {
  if (!followups) {
    followups = new Queue(FOLLOWUPS_QUEUE, { connection: getRedisConnection(), defaultJobOptions: JOB_RETENTION });
  }
  return followups;
}

let wakeups: Queue | null = null;
export function wakeupsQueue(): Queue {
  if (!wakeups) {
    wakeups = new Queue(WAKEUPS_QUEUE, { connection: getRedisConnection(), defaultJobOptions: JOB_RETENTION });
  }
  return wakeups;
}

let audits: Queue | null = null;
export function auditsQueue(): Queue {
  if (!audits) {
    audits = new Queue(AUDIT_QUEUE, { connection: getRedisConnection(), defaultJobOptions: JOB_RETENTION });
  }
  return audits;
}

let logs: Queue | null = null;
export function logsQueue(): Queue {
  if (!logs) {
    logs = new Queue(LOGS_QUEUE, { connection: getRedisConnection(), defaultJobOptions: JOB_RETENTION });
  }
  return logs;
}

let pdfs: Queue | null = null;
export function pdfsQueue(): Queue {
  if (!pdfs) {
    pdfs = new Queue(PDF_QUEUE, { connection: getRedisConnection(), defaultJobOptions: JOB_RETENTION });
  }
  return pdfs;
}

let callbacks: Queue | null = null;
export function callbacksQueue(): Queue {
  if (!callbacks) {
    callbacks = new Queue(CALLBACKS_QUEUE, { connection: getRedisConnection(), defaultJobOptions: JOB_RETENTION });
  }
  return callbacks;
}

let briefs: Queue | null = null;
export function briefsQueue(): Queue {
  if (!briefs) {
    briefs = new Queue(BRIEFS_QUEUE, { connection: getRedisConnection(), defaultJobOptions: JOB_RETENTION });
  }
  return briefs;
}

let visits: Queue | null = null;
/** Visitor identification for public-page reads (playbook-v3 P8/b). */
export function visitsQueue(): Queue {
  if (!visits) {
    visits = new Queue(VISITS_QUEUE, { connection: getRedisConnection(), defaultJobOptions: JOB_RETENTION });
  }
  return visits;
}

let verify: Queue | null = null;
/** Batch email verification for a large cold audience (playbook-v3 P9/2). */
export function verifyQueue(): Queue {
  if (!verify) {
    verify = new Queue(VERIFY_QUEUE, { connection: getRedisConnection(), defaultJobOptions: JOB_RETENTION });
  }
  return verify;
}

let erasures: Queue | null = null;
export function erasuresQueue(): Queue {
  if (!erasures) {
    erasures = new Queue(ERASURE_QUEUE, { connection: getRedisConnection(), defaultJobOptions: JOB_RETENTION });
  }
  return erasures;
}

let outbound: Queue | null = null;
/** Sourcing-run passes, the nightly fill and approved sends (playbook-v6). */
export function outboundQueue(): Queue {
  if (!outbound) {
    outbound = new Queue(OUTBOUND_QUEUE, { connection: getRedisConnection(), defaultJobOptions: JOB_RETENTION });
  }
  return outbound;
}
