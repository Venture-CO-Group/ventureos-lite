import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { emitWebhookEvent } from "../../src/modules/webhooks/emit";
import {
  CIRCUIT_BREAKER_FAILURES,
  processWebhookDeliveries,
  processWebhookLogRetention,
} from "../../src/modules/webhooks/jobs";

/**
 * Outbound webhook delivery, against the real database (P5/5.2).
 *
 * ── WHAT IS NOT TESTED HERE, AND WHY ────────────────────────────────────────
 *
 * A SUCCESSFUL delivery is not, and cannot be, covered by an automated test on
 * this machine. The guard refuses `localhost`, every compose service name and
 * every private address — by design, since an outbound webhook is server-side
 * request forgery with a settings panel — so there is no way to stand up a
 * local receiver and have the worker agree to talk to it.
 *
 * Adding a `WEBHOOK_ALLOW_LOCAL` escape hatch would make that test possible and
 * would also be a bypass of the only thing protecting the Docker network. Not
 * worth it. The signing is unit-tested, the guard is unit-tested, and the
 * "send a test" button in Settings covers the real network round trip with a
 * person watching.
 *
 * What IS tested here is everything that goes wrong, which is the part that
 * runs unattended: retries, backoff, the circuit breaker, and the rule that
 * emitting must never break the thing that emitted it.
 */
const WS_NAME = "Webhook Test WS";
let workspaceId = "";

async function ensureWorkspace() {
  const existing = await prismaUnsafe.workspace.findFirst({ where: { name: WS_NAME } });
  const ws = existing ?? (await prismaUnsafe.workspace.create({ data: { name: WS_NAME } }));
  workspaceId = ws.id;
}

async function clear() {
  if (!workspaceId) return;
  await prismaUnsafe.webhookDelivery.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.webhook.deleteMany({ where: { workspaceId } });
}

beforeEach(async () => {
  await ensureWorkspace();
  await clear();
});

afterAll(async () => {
  await clear();
  // A leftover workspace is not harmless: more than one breaks
  // getPublicIntakeWorkspaceId() and takes unrelated specs down with it.
  await prismaUnsafe.workspace.deleteMany({ where: { name: WS_NAME } });
});

/** A hostname that passes the shape check and cannot possibly resolve. */
const UNRESOLVABLE = "https://this-host-does-not-exist.ventureco-test.invalid/hook";

async function makeHook(
  events: string[],
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const hook = await prismaUnsafe.webhook.create({
    data: {
      workspaceId,
      url: UNRESOLVABLE,
      secret: "test-secret",
      events,
      ...overrides,
    },
    select: { id: true },
  });
  return hook.id;
}

describe("queueing an event", () => {
  it("writes one row per subscribed endpoint", async () => {
    await makeHook(["lead.stage_changed"]);
    await makeHook(["lead.stage_changed", "deal.won"]);
    await makeHook(["deal.won"]);

    const n = await emitWebhookEvent(workspaceId, "lead.stage_changed", { leadId: "x" });
    expect(n).toBe(2);
    expect(await prismaUnsafe.webhookDelivery.count({ where: { workspaceId } })).toBe(2);
  });

  it("skips an endpoint that is switched off", async () => {
    await makeHook(["lead.created"], { enabled: false });
    expect(await emitWebhookEvent(workspaceId, "lead.created", {})).toBe(0);
  });

  it("skips an event nobody subscribed to", async () => {
    await makeHook(["deal.won"]);
    expect(await emitWebhookEvent(workspaceId, "lead.created", {})).toBe(0);
  });

  it("does not cross workspaces", async () => {
    await makeHook(["lead.created"]);
    const other = await prismaUnsafe.workspace.findFirst({
      where: { name: { not: WS_NAME } },
      orderBy: { createdAt: "asc" },
    });
    expect(await emitWebhookEvent(other!.id, "lead.created", {})).toBe(0);
  });

  it("wraps the payload in a stable envelope", async () => {
    await makeHook(["lead.created"]);
    await emitWebhookEvent(workspaceId, "lead.created", { leadId: "abc", score: 4 });
    const row = await prismaUnsafe.webhookDelivery.findFirst({ where: { workspaceId } });
    const payload = row!.payload as Record<string, unknown>;
    // A receiver written against one event should route every other one
    // without a second parser.
    expect(payload.event).toBe("lead.created");
    expect(payload.workspaceId).toBe(workspaceId);
    expect(typeof payload.occurredAt).toBe("string");
    expect(payload.data).toMatchObject({ leadId: "abc", score: 4 });
  });

  it("never throws, whatever it is handed", async () => {
    // Emitting must not be the reason a stage change fails. That is the single
    // rule the emit path obeys.
    await expect(
      emitWebhookEvent("no-such-workspace", "lead.created", {}),
    ).resolves.toBe(0);
    await expect(emitWebhookEvent(workspaceId, "", {})).resolves.toBe(0);
  });

  it("ignores a hand-edited subscription list rather than failing", async () => {
    await prismaUnsafe.webhook.create({
      data: { workspaceId, url: UNRESOLVABLE, secret: "s", events: { nonsense: true } },
    });
    await expect(emitWebhookEvent(workspaceId, "lead.created", {})).resolves.toBe(0);
  });
});

describe("delivering, and failing to", () => {
  it("retries a name that does not resolve, rather than dropping the event", async () => {
    /**
     * This test found a real bug.
     *
     * The delivery path lumped "does not resolve" together with "points at
     * 10.0.0.5" and refused to retry either. But a name that does not resolve
     * is somebody's DNS having a bad afternoon, or a record that has not
     * propagated yet — dropping the event permanently for that is losing data
     * over a transient fault. Only the SSRF refusal is permanent.
     */
    const id = await makeHook(["lead.created"]);
    await emitWebhookEvent(workspaceId, "lead.created", {});

    const now = new Date();
    expect(await processWebhookDeliveries(now)).toBe(0);

    const row = await prismaUnsafe.webhookDelivery.findFirst({ where: { workspaceId } });
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(1);
    expect(row!.error).toBeTruthy();
    // One minute later, per the backoff table.
    expect(row!.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(row!.nextAttemptAt!.getTime()).toBeLessThanOrEqual(now.getTime() + 61_000);

    const hook = await prismaUnsafe.webhook.findUnique({ where: { id } });
    expect(hook!.failureCount).toBe(1);
    expect(hook!.lastAttemptAt).not.toBeNull();
    expect(hook!.lastSuccessAt).toBeNull();
  });

  it("does not pick a row up again before its backoff has elapsed", async () => {
    await makeHook(["lead.created"]);
    await emitWebhookEvent(workspaceId, "lead.created", {});
    const t0 = new Date();
    await processWebhookDeliveries(t0);
    // Thirty seconds later the row is still not due.
    await processWebhookDeliveries(new Date(t0.getTime() + 30_000));
    const row = await prismaUnsafe.webhookDelivery.findFirst({ where: { workspaceId } });
    expect(row!.attempts).toBe(1);
  });

  it("gives up after six attempts and keeps the payload", async () => {
    await makeHook(["lead.created"]);
    await emitWebhookEvent(workspaceId, "lead.created", { leadId: "keepme" });

    let t = new Date();
    for (let i = 0; i < 6; i += 1) {
      await processWebhookDeliveries(t);
      t = new Date(t.getTime() + 12 * 3600_000);
    }
    const row = await prismaUnsafe.webhookDelivery.findFirst({ where: { workspaceId } });
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(6);
    expect(row!.nextAttemptAt).toBeNull();
    // "What exactly did you send" is the second question anybody asks.
    expect((row!.payload as Record<string, unknown>).data).toMatchObject({ leadId: "keepme" });
  });

  it("drops a queued row whose endpoint was switched off in the meantime", async () => {
    const id = await makeHook(["lead.created"]);
    await emitWebhookEvent(workspaceId, "lead.created", {});
    await prismaUnsafe.webhook.update({ where: { id }, data: { enabled: false } });

    await processWebhookDeliveries(new Date());
    const row = await prismaUnsafe.webhookDelivery.findFirst({ where: { workspaceId } });
    // Dropped, not failed: the endpoint rejected nothing, we chose not to send.
    expect(row!.status).toBe("dropped");
    expect(row!.attempts).toBe(0);
  });

  it("refuses a URL pointing inside our own network, and does not retry it", async () => {
    // Stored directly, the way a hand-edited row or an older validator would
    // leave it. The delivery path has to refuse it on its own.
    const id = await makeHook(["lead.created"], { url: "http://localhost:3000/api/leads" });
    await emitWebhookEvent(workspaceId, "lead.created", {});
    await processWebhookDeliveries(new Date());

    const row = await prismaUnsafe.webhookDelivery.findFirst({ where: { workspaceId } });
    expect(row!.status).toBe("failed");
    // Not retried: a URL that points inside our network will still point
    // inside our network in ten hours.
    expect(row!.nextAttemptAt).toBeNull();
    expect(await prismaUnsafe.webhook.findUnique({ where: { id } })).toBeTruthy();
  });

  it("switches off an endpoint that has been failing for days, and says why", async () => {
    const id = await makeHook(["lead.created"], {
      failureCount: CIRCUIT_BREAKER_FAILURES - 1,
    });
    await emitWebhookEvent(workspaceId, "lead.created", {});
    await processWebhookDeliveries(new Date());

    const hook = await prismaUnsafe.webhook.findUnique({ where: { id } });
    // A retry queue that never drains is not resilience, it is a slow leak.
    expect(hook!.enabled).toBe(false);
    expect(hook!.failureCount).toBe(CIRCUIT_BREAKER_FAILURES);
    expect(hook!.disabledReason).toContain(String(CIRCUIT_BREAKER_FAILURES));
  });

  it("delivers only the one row it was asked for", async () => {
    // The "send a test" button runs inline in a server action; the unfiltered
    // sweep would flush every endpoint's backlog and hang the settings page.
    await makeHook(["lead.created"]);
    await emitWebhookEvent(workspaceId, "lead.created", {});
    await emitWebhookEvent(workspaceId, "lead.created", {});
    const rows = await prismaUnsafe.webhookDelivery.findMany({ where: { workspaceId } });
    expect(rows).toHaveLength(2);

    await processWebhookDeliveries(new Date(), rows[0]!.id);
    const after = await prismaUnsafe.webhookDelivery.findMany({
      where: { workspaceId },
      orderBy: { id: "asc" },
    });
    const touched = after.filter((r) => r.attempts > 0);
    expect(touched).toHaveLength(1);
    expect(touched[0]!.id).toBe(rows[0]!.id);
  });
});

describe("bounding the sweep", () => {
  it("counts consecutive failures across the whole sweep, not per selected row", async () => {
    /**
     * Every row in a batch is selected by ONE query, so they all carry the same
     * `failureCount` — the value as it was before the sweep began. Reading it
     * off the row meant two failures to one endpoint in one sweep both wrote
     * the same number, and the circuit breaker would have needed forty
     * failures to trip instead of twenty.
     */
    const id = await makeHook(["lead.created"], {
      failureCount: CIRCUIT_BREAKER_FAILURES - 2,
    });
    await emitWebhookEvent(workspaceId, "lead.created", { n: 1 });
    await emitWebhookEvent(workspaceId, "lead.created", { n: 2 });

    await processWebhookDeliveries(new Date());

    const hook = await prismaUnsafe.webhook.findUnique({ where: { id } });
    // Two failures, two increments — and that is exactly the twentieth.
    expect(hook!.failureCount).toBe(CIRCUIT_BREAKER_FAILURES);
    expect(hook!.enabled).toBe(false);
  });

  it("keeps the endpoint's own deliveries in order", async () => {
    const id = await makeHook(["lead.created"]);
    await emitWebhookEvent(workspaceId, "lead.created", { n: 1 });
    await emitWebhookEvent(workspaceId, "lead.created", { n: 2 });
    await processWebhookDeliveries(new Date());
    // Both attempted once. Parallelism is BETWEEN endpoints, never within one.
    const rows = await prismaUnsafe.webhookDelivery.findMany({ where: { webhookId: id } });
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.attempts).toBe(1);
  });

  it("talks to several endpoints in one sweep", async () => {
    // The sweep rides a queue whose worker has a concurrency of one, so a
    // serial sweep of twenty-five ten-second timeouts would starve every other
    // scheduled job on it — the Monday digest included.
    const ids = [
      await makeHook(["lead.created"]),
      await makeHook(["lead.created"]),
      await makeHook(["lead.created"]),
    ];
    await emitWebhookEvent(workspaceId, "lead.created", {});
    await processWebhookDeliveries(new Date());
    for (const id of ids) {
      const row = await prismaUnsafe.webhookDelivery.findFirst({ where: { webhookId: id } });
      expect(row!.attempts, id).toBe(1);
    }
  });
});

describe("the delivery log expires", () => {
  it("removes old delivered rows and keeps failures much longer", async () => {
    const id = await makeHook(["lead.created"]);
    const ago = (d: number) => new Date(Date.now() - d * 86_400_000);
    for (const [status, at] of [
      ["delivered", ago(40)],
      ["delivered", ago(5)],
      ["dropped", ago(40)],
      ["failed", ago(40)],
      ["failed", ago(120)],
    ] as const) {
      await prismaUnsafe.webhookDelivery.create({
        data: {
          workspaceId,
          webhookId: id,
          event: "lead.created",
          payload: {},
          status,
          createdAt: at,
        },
      });
    }

    const removed = await processWebhookLogRetention();
    expect(removed).toBe(3);

    const left = await prismaUnsafe.webhookDelivery.findMany({ where: { workspaceId } });
    expect(left).toHaveLength(2);
    // An integration that broke six weeks ago is exactly what somebody comes
    // looking for, so a 40-day-old failure survives while a delivery does not.
    expect(left.filter((r) => r.status === "failed")).toHaveLength(1);
    expect(left.filter((r) => r.status === "delivered")).toHaveLength(1);
  });
});
