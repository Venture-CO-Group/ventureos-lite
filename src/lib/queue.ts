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
    followups = new Queue(FOLLOWUPS_QUEUE, { connection: getRedisConnection() });
  }
  return followups;
}

let wakeups: Queue | null = null;
export function wakeupsQueue(): Queue {
  if (!wakeups) {
    wakeups = new Queue(WAKEUPS_QUEUE, { connection: getRedisConnection() });
  }
  return wakeups;
}

let audits: Queue | null = null;
export function auditsQueue(): Queue {
  if (!audits) {
    audits = new Queue(AUDIT_QUEUE, { connection: getRedisConnection() });
  }
  return audits;
}

let logs: Queue | null = null;
export function logsQueue(): Queue {
  if (!logs) {
    logs = new Queue(LOGS_QUEUE, { connection: getRedisConnection() });
  }
  return logs;
}

let pdfs: Queue | null = null;
export function pdfsQueue(): Queue {
  if (!pdfs) {
    pdfs = new Queue(PDF_QUEUE, { connection: getRedisConnection() });
  }
  return pdfs;
}

let callbacks: Queue | null = null;
export function callbacksQueue(): Queue {
  if (!callbacks) {
    callbacks = new Queue(CALLBACKS_QUEUE, { connection: getRedisConnection() });
  }
  return callbacks;
}

let briefs: Queue | null = null;
export function briefsQueue(): Queue {
  if (!briefs) {
    briefs = new Queue(BRIEFS_QUEUE, { connection: getRedisConnection() });
  }
  return briefs;
}

let visits: Queue | null = null;
/** Visitor identification for public-page reads (playbook-v3 P8/b). */
export function visitsQueue(): Queue {
  if (!visits) {
    visits = new Queue(VISITS_QUEUE, { connection: getRedisConnection() });
  }
  return visits;
}

let verify: Queue | null = null;
/** Batch email verification for a large cold audience (playbook-v3 P9/2). */
export function verifyQueue(): Queue {
  if (!verify) {
    verify = new Queue(VERIFY_QUEUE, { connection: getRedisConnection() });
  }
  return verify;
}

let erasures: Queue | null = null;
export function erasuresQueue(): Queue {
  if (!erasures) {
    erasures = new Queue(ERASURE_QUEUE, { connection: getRedisConnection() });
  }
  return erasures;
}

let outbound: Queue | null = null;
/** Sourcing-run passes, the nightly fill and approved sends (playbook-v6). */
export function outboundQueue(): Queue {
  if (!outbound) {
    outbound = new Queue(OUTBOUND_QUEUE, { connection: getRedisConnection() });
  }
  return outbound;
}
