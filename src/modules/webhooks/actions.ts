"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { isOwner } from "@/lib/authz";
import { WEBHOOK_EVENT_IDS, readEvents } from "./events";
import { generateWebhookSecret } from "./signature";
import { validateWebhookUrl } from "./url";
import { processWebhookDeliveries } from "./jobs";

/**
 * Managing outbound webhooks (P5/5.2).
 *
 * ── OWNER ONLY, AND WHY NOT A GRANT ─────────────────────────────────────────
 *
 * A webhook is a standing instruction to send this workspace's leads, quote
 * totals and client names to an address somebody typed. That is an export with
 * no end date, so it sits with the Owner rather than behind a grant a colleague
 * could be given for a week and keep for ever.
 *
 * The secret is returned exactly ONCE, when the endpoint is created or the
 * secret is rotated. Not because it cannot be read back — it is stored in the
 * clear, since HMAC needs it verbatim — but because a screen that re-displays
 * it forever is a screen somebody eventually screenshots.
 */
export interface WebhookRow {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  disabledReason: string | null;
  failureCount: number;
  lastStatus: number | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** Recent deliveries, newest first. */
  recent: WebhookDeliveryRow[];
}

export interface WebhookDeliveryRow {
  id: string;
  event: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  at: string;
}

export interface WebhookView {
  hooks: WebhookRow[];
  canManage: boolean;
}

export async function listWebhooks(): Promise<WebhookView> {
  const canManage = await isOwner();
  if (!canManage) return { hooks: [], canManage: false };

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.webhook.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      deliveries: {
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          event: true,
          status: true,
          attempts: true,
          responseStatus: true,
          error: true,
          createdAt: true,
        },
      },
    },
  });

  return {
    canManage: true,
    hooks: rows.map((h) => ({
      id: h.id,
      url: h.url,
      description: h.description,
      events: readEvents(h.events),
      enabled: h.enabled,
      disabledReason: h.disabledReason,
      failureCount: h.failureCount,
      lastStatus: h.lastStatus,
      lastAttemptAt: h.lastAttemptAt?.toISOString() ?? null,
      lastSuccessAt: h.lastSuccessAt?.toISOString() ?? null,
      recent: h.deliveries.map((d) => ({
        id: d.id,
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        responseStatus: d.responseStatus,
        error: d.error,
        at: d.createdAt.toISOString(),
      })),
    })),
  };
}

const saveSchema = z.object({
  id: z.string().optional(),
  url: z.string(),
  description: z.string().trim().max(200).optional(),
  events: z.array(z.string()).max(WEBHOOK_EVENT_IDS.length),
});

export async function saveWebhook(
  raw: unknown,
): Promise<{ ok: true; secret?: string } | { ok: false; error: string }> {
  if (!(await isOwner())) return { ok: false, error: "Csak Owner állíthat be webhookot." };
  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Hiányos adatok." };
  const { id, url, description, events } = parsed.data;

  // The SSRF gate. This is the whole reason the module has a url.ts.
  const verdict = validateWebhookUrl(url);
  if (!verdict.ok) return { ok: false, error: verdict.error };

  const wanted = events.filter((e) => WEBHOOK_EVENT_IDS.includes(e));
  if (wanted.length === 0) {
    // An endpoint subscribed to nothing is an endpoint that will never fire and
    // will be reported as broken six months from now.
    return { ok: false, error: "Válassz legalább egy eseményt." };
  }

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  if (id) {
    const existing = await db.webhook.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return { ok: false, error: "Ez a webhook nem létezik." };
    await db.webhook.update({
      where: { id },
      data: {
        url: verdict.url,
        description: description || null,
        events: wanted,
        // Editing a broken endpoint is how somebody fixes it, so the breaker
        // resets here rather than leaving them to hunt for a second switch.
        failureCount: 0,
        disabledReason: null,
      },
    });
    await db.auditLog.create({
      data: {
        workspaceId,
        actorUserId: userId,
        action: "webhook.updated",
        entityType: "Webhook",
        entityId: id,
        meta: { url: verdict.url, events: wanted },
      },
    });
    revalidatePath("/settings/admin");
    return { ok: true };
  }

  const secret = generateWebhookSecret();
  const created = await db.webhook.create({
    data: {
      workspaceId,
      url: verdict.url,
      secret,
      events: wanted,
      description: description || null,
      createdBy: userId,
    },
    select: { id: true },
  });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      // Audit-logged as an export, because that is what it is: a standing
      // instruction to send this workspace's data somewhere else.
      action: "webhook.created",
      entityType: "Webhook",
      entityId: created.id,
      meta: { url: verdict.url, events: wanted },
    },
  });
  revalidatePath("/settings/admin");
  return { ok: true, secret };
}

export async function setWebhookEnabled(
  id: string,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await isOwner())) return { ok: false, error: "Csak Owner állíthat be webhookot." };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const hook = await db.webhook.findUnique({ where: { id }, select: { id: true } });
  if (!hook) return { ok: false, error: "Ez a webhook nem létezik." };

  await db.webhook.update({
    where: { id },
    // Switching it back on clears the breaker; otherwise it would trip again on
    // the next single failure.
    data: enabled
      ? { enabled: true, failureCount: 0, disabledReason: null }
      : { enabled: false, disabledReason: null },
  });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: enabled ? "webhook.enabled" : "webhook.disabled",
      entityType: "Webhook",
      entityId: id,
    },
  });
  revalidatePath("/settings/admin");
  return { ok: true };
}

export async function rotateWebhookSecret(
  id: string,
): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  if (!(await isOwner())) return { ok: false, error: "Csak Owner állíthat be webhookot." };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const hook = await db.webhook.findUnique({ where: { id }, select: { id: true } });
  if (!hook) return { ok: false, error: "Ez a webhook nem létezik." };

  const secret = generateWebhookSecret();
  await db.webhook.update({ where: { id }, data: { secret } });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "webhook.secret_rotated",
      entityType: "Webhook",
      entityId: id,
    },
  });
  return { ok: true, secret };
}

export async function deleteWebhook(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await isOwner())) return { ok: false, error: "Csak Owner állíthat be webhookot." };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const hook = await db.webhook.findUnique({ where: { id }, select: { url: true } });
  if (!hook) return { ok: false, error: "Ez a webhook nem létezik." };

  // The deliveries go with it (cascade). They are a log OF this endpoint, and
  // keeping payload copies for an endpoint nobody can see is not an audit
  // trail, it is a pile of client data with no owner.
  await db.webhook.delete({ where: { id } });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "webhook.deleted",
      entityType: "Webhook",
      entityId: id,
      meta: { url: hook.url },
    },
  });
  revalidatePath("/settings/admin");
  return { ok: true };
}

/**
 * Send a test event, right now, and say what came back.
 *
 * Without this, the only way to find out whether an endpoint works is to wait
 * for a real lead to move — and then to guess whether the silence means "no
 * events yet" or "wrong URL".
 */
export async function sendTestWebhook(
  id: string,
): Promise<{ ok: true; status: string; detail: string } | { ok: false; error: string }> {
  if (!(await isOwner())) return { ok: false, error: "Csak Owner állíthat be webhookot." };
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const hook = await db.webhook.findUnique({
    where: { id },
    select: { id: true, enabled: true },
  });
  if (!hook) return { ok: false, error: "Ez a webhook nem létezik." };
  if (!hook.enabled) return { ok: false, error: "Kapcsold be, mielőtt tesztelnél." };

  const delivery = await db.webhookDelivery.create({
    data: {
      workspaceId,
      webhookId: id,
      event: "webhook.test",
      payload: {
        event: "webhook.test",
        occurredAt: new Date().toISOString(),
        workspaceId,
        data: { message: "Ez egy teszt a Venture OS beállításokból." },
      },
      status: "pending",
      nextAttemptAt: new Date(),
    },
    select: { id: true },
  });

  /**
   * Delivered inline, unlike every real event.
   *
   * A test whose result arrives in the worker's log ten minutes later is not a
   * test. This is the one place where waiting for somebody else's server is
   * what the user asked for — and the ten-second timeout in the worker bounds
   * it.
   *
   * Only THIS row, hence the second argument: the unfiltered sweep would also
   * flush every other endpoint's backlog, and twenty-five slow endpoints at ten
   * seconds each is a settings page that hangs for four minutes.
   */
  await processWebhookDeliveries(new Date(), delivery.id);

  const after = await prismaUnsafe.webhookDelivery.findUnique({
    where: { id: delivery.id },
    select: { status: true, responseStatus: true, error: true },
  });
  revalidatePath("/settings/admin");
  if (!after) return { ok: false, error: "A teszt eltűnt a küldés közben." };
  return {
    ok: true,
    status: after.status,
    detail:
      after.status === "delivered"
        ? `Megérkezett — HTTP ${after.responseStatus}.`
        : (after.error ?? "Ismeretlen hiba."),
  };
}
