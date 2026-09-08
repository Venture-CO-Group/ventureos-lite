import { lookup } from "node:dns/promises";
import { prismaUnsafe } from "@/lib/db";
import { isPrivateAddress, validateWebhookUrl } from "./url";
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signPayload,
} from "./signature";

/**
 * Delivering queued webhooks (P5/5.2).
 *
 * ── WHY A QUEUE AND A SWEEP RATHER THAN A FETCH AT THE CALL SITE ────────────
 *
 * The call site is a server action finishing a user's work. An HTTP request to
 * somebody else's server, from there, means our page waits as long as their
 * server feels like taking — and a receiver that hangs makes OUR app look
 * broken. So the action writes a row and returns, and this runs in the worker.
 *
 * ── RETRIES, AND WHEN TO STOP ───────────────────────────────────────────────
 *
 * Six attempts with exponential backoff: about a minute, five, twenty-five, two
 * hours, ten hours. That spans an overnight outage without hammering anybody.
 * After the sixth the delivery is `failed` and stays in the log — the payload
 * is kept, because the first question about an integration is "did it arrive"
 * and the second is "what exactly did you send".
 *
 * An ENDPOINT that fails twenty times in a row is switched off with a reason.
 * A retry queue that never drains is not resilience, it is a slow leak, and the
 * Owner needs to be told rather than left with a silent integration.
 */
const MAX_ATTEMPTS = 6;
const BACKOFF_MINUTES = [1, 5, 25, 120, 600];
export const CIRCUIT_BREAKER_FAILURES = 20;
const TIMEOUT_MS = 10_000;
const BATCH = 25;

export function backoffFor(attempts: number): number {
  const idx = Math.min(attempts - 1, BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[Math.max(0, idx)]!;
}

/**
 * Would connecting to this URL reach our own infrastructure?
 *
 * `validateWebhookUrl` reads the string and cannot see DNS: a perfectly public
 * hostname may have an A record pointing at 127.0.0.1 or 10.0.0.5, and this
 * server sits on a Docker network beside Postgres and Redis. So the name is
 * resolved before we connect, and every address it resolved to is checked. An
 * attacker who controls a DNS record does not get a request to `db:5432`.
 *
 * ── WHY THE VERDICT HAS TWO KINDS ───────────────────────────────────────────
 *
 * "Points at 10.0.0.5" and "does not resolve" are not the same failure, and an
 * integration test caught me treating them as one. A URL aimed inside our
 * network will still be aimed inside our network in ten hours, so retrying it
 * on a timer is worse than failing it once. A name that does not resolve, on
 * the other hand, is somebody's DNS having a bad afternoon or a record that has
 * not propagated yet — and dropping the event permanently for that is losing
 * data over a transient fault.
 */
type Refusal = { kind: "blocked" | "unresolved"; reason: string };

async function refuseReason(url: string): Promise<Refusal | null> {
  const shape = validateWebhookUrl(url);
  if (!shape.ok) return { kind: "blocked", reason: shape.error };
  try {
    const host = new URL(url).hostname;
    const addrs = await lookup(host, { all: true });
    if (addrs.length === 0) {
      return { kind: "unresolved", reason: "A tartománynév nem oldható fel." };
    }
    for (const a of addrs) {
      if (isPrivateAddress(a.address)) {
        return {
          kind: "blocked",
          reason: `A tartománynév belső címre mutat (${a.address}).`,
        };
      }
    }
    return null;
  } catch {
    return { kind: "unresolved", reason: "A tartománynév nem oldható fel." };
  }
}

/**
 * @param only  Deliver just this one row.
 *
 * Used by the "send a test" button, which runs inline in a server action. The
 * unfiltered sweep can take twenty-five endpoints times ten seconds, and a
 * settings page must not hold a request open for four minutes because somebody
 * else's server is slow.
 */
export async function processWebhookDeliveries(
  now: Date = new Date(),
  only?: string,
): Promise<number> {
  const due = await prismaUnsafe.webhookDelivery.findMany({
    where: only
      ? { id: only, status: "pending" }
      : { status: "pending", nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: only ? 1 : BATCH,
    include: {
      webhook: {
        select: { id: true, url: true, secret: true, enabled: true, failureCount: true },
      },
    },
  });

  let delivered = 0;
  for (const row of due) {
    const hook = row.webhook;
    if (!hook.enabled) {
      // Switched off after the row was queued. Dropped rather than failed: the
      // endpoint did not reject anything, we chose not to send.
      await prismaUnsafe.webhookDelivery.update({
        where: { id: row.id },
        data: { status: "dropped", error: "A webhook ki van kapcsolva.", nextAttemptAt: null },
      });
      continue;
    }

    const attempts = row.attempts + 1;
    const body = JSON.stringify(row.payload);
    const timestamp = Math.floor(now.getTime() / 1000);

    const refusal = await refuseReason(hook.url);
    if (refusal) {
      const giveUp = refusal.kind === "blocked" || attempts >= MAX_ATTEMPTS;
      await prismaUnsafe.webhookDelivery.update({
        where: { id: row.id },
        data: giveUp
          ? { status: "failed", attempts, error: refusal.reason, nextAttemptAt: null }
          : {
              attempts,
              error: refusal.reason,
              nextAttemptAt: new Date(now.getTime() + backoffFor(attempts) * 60_000),
            },
      });
      await noteFailure(hook.id, hook.failureCount + 1, null, now, refusal.reason);
      continue;
    }

    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(hook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [SIGNATURE_HEADER]: signPayload(hook.secret, timestamp, body),
          [TIMESTAMP_HEADER]: String(timestamp),
          [EVENT_HEADER]: row.event,
          [DELIVERY_HEADER]: row.id,
          "User-Agent": "VentureOS-Webhook/1",
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // No redirect following: a 302 to an internal address would walk
        // straight past the DNS check above.
        redirect: "manual",
      });
      status = res.status;
      if (res.status >= 300) error = `HTTP ${res.status}`;
      // The body is never read. It could be gigabytes, and we do not care what
      // it says — only whether it was accepted.
    } catch (e) {
      error = (e as Error).name === "TimeoutError" ? "Időtúllépés (10s)" : (e as Error).message;
    }

    if (!error) {
      delivered += 1;
      await prismaUnsafe.webhookDelivery.update({
        where: { id: row.id },
        data: {
          status: "delivered",
          attempts,
          responseStatus: status,
          deliveredAt: now,
          nextAttemptAt: null,
          error: null,
        },
      });
      await prismaUnsafe.webhook.update({
        where: { id: hook.id },
        data: {
          // Reset on success: the breaker counts CONSECUTIVE failures, so an
          // endpoint that recovers is not punished for last week.
          failureCount: 0,
          lastStatus: status,
          lastAttemptAt: now,
          lastSuccessAt: now,
        },
      });
      continue;
    }

    /**
     * A 4xx other than 408 or 429 is not retried.
     *
     * 404 and 401 mean the endpoint is wrong or the secret is wrong, and
     * neither gets better by asking again five times. 408 and 429 are the
     * receiver asking us to slow down, which is exactly what a retry is for.
     */
    const permanent =
      status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
    const exhausted = attempts >= MAX_ATTEMPTS;

    await prismaUnsafe.webhookDelivery.update({
      where: { id: row.id },
      data:
        permanent || exhausted
          ? { status: "failed", attempts, responseStatus: status, error, nextAttemptAt: null }
          : {
              attempts,
              responseStatus: status,
              error,
              nextAttemptAt: new Date(now.getTime() + backoffFor(attempts) * 60_000),
            },
    });
    await noteFailure(hook.id, hook.failureCount + 1, status, now, error);
  }
  return delivered;
}

async function noteFailure(
  webhookId: string,
  failureCount: number,
  status: number | null,
  now: Date,
  error: string,
): Promise<void> {
  const trip = failureCount >= CIRCUIT_BREAKER_FAILURES;
  await prismaUnsafe.webhook.update({
    where: { id: webhookId },
    data: {
      failureCount,
      lastStatus: status,
      lastAttemptAt: now,
      ...(trip
        ? {
            enabled: false,
            disabledReason: `${failureCount} egymást követő hiba után kikapcsolva: ${error}`,
          }
        : {}),
    },
  });
}

/**
 * Housekeeping: the delivery log is not kept for ever.
 *
 * It holds full copies of payloads — lead names, contract totals — so it is
 * tenant data with the same reasons to expire as everything else. Thirty days
 * is long enough to answer "did last month's invoice event arrive".
 */
export async function processWebhookLogRetention(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 86_400_000);
  const res = await prismaUnsafe.webhookDelivery.deleteMany({
    where: { createdAt: { lt: cutoff }, status: { in: ["delivered", "dropped"] } },
  });
  // Failed rows are kept longer on purpose: an integration that broke six weeks
  // ago is exactly the thing somebody comes looking for.
  const failed = await prismaUnsafe.webhookDelivery.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - 90 * 86_400_000) }, status: "failed" },
  });
  return res.count + failed.count;
}
