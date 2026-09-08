import type { Prisma } from "@prisma/client";
import { prismaUnsafe } from "@/lib/db";
import { readEvents } from "./events";

/**
 * Raising an outbound event (P5/5.2).
 *
 * ── THE ONE RULE THIS FILE OBEYS ────────────────────────────────────────────
 *
 * **Emitting an event must never break the thing that emitted it.**
 *
 * A lead moving stage is the user's work; telling somebody else's CRM about it
 * is ours. If the webhook table is unreachable, or a row is malformed, or the
 * subscription list is nonsense, the stage change still has to succeed. So
 * every path here is wrapped, failures are logged and swallowed, and nothing is
 * awaited that touches the network.
 *
 * Delivery is deliberately NOT attempted here. This writes queue rows; the
 * worker sends them. An HTTP call inside a server action would hold the user's
 * request open for as long as somebody else's server felt like taking, and a
 * slow endpoint would make our own app look broken.
 */
export async function emitWebhookEvent(
  workspaceId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<number> {
  try {
    const hooks = await prismaUnsafe.webhook.findMany({
      where: { workspaceId, enabled: true },
      select: { id: true, events: true },
    });
    const wanted = hooks.filter((h) => readEvents(h.events).includes(event));
    if (wanted.length === 0) return 0;

    const now = new Date();
    await prismaUnsafe.webhookDelivery.createMany({
      data: wanted.map((h) => ({
        workspaceId,
        webhookId: h.id,
        event,
        // A stable envelope. A receiver written against one event should be
        // able to route every other one without a second parser.
        payload: {
          event,
          occurredAt: now.toISOString(),
          workspaceId,
          data: payload,
        } as unknown as Prisma.InputJsonValue,
        status: "pending",
        // Due immediately; the sweep picks it up on its next pass.
        nextAttemptAt: now,
      })),
    });
    return wanted.length;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[webhooks] could not queue ${event}`, e);
    return 0;
  }
}

/**
 * `lead.created`, from any of the places a lead can appear.
 *
 * A lead is created in eight different files — manual capture, the LinkedIn
 * paste, the prospector, the public audit unlock, a public booking, a sector
 * report download, the audit screen, and the CSV import. Building the payload
 * at each of them would have guaranteed eight slightly different payloads, so
 * the caller passes an id and this reads the row.
 *
 * NOT wired into the CSV import, deliberately: a five-hundred-row import is one
 * event, not five hundred, and an integration that receives five hundred POSTs
 * in a minute will rate-limit us and lose the lot.
 */
export async function emitLeadCreated(workspaceId: string, leadId: string): Promise<number> {
  try {
    // Both keys, not just the id: this runs on the unguarded client, and a
    // caller that ever passed a lead from elsewhere must read as "not found"
    // rather than as a payload built from another tenant's row.
    const lead = await prismaUnsafe.lead.findFirst({
      where: { id: leadId, workspaceId },
      select: {
        id: true,
        contactName: true,
        email: true,
        source: true,
        stage: true,
        icpScore: true,
        company: { select: { id: true, name: true, domain: true } },
      },
    });
    if (!lead) return 0;
    return emitWebhookEvent(workspaceId, "lead.created", {
      leadId: lead.id,
      contactName: lead.contactName,
      email: lead.email,
      source: lead.source,
      stage: lead.stage,
      icpScore: lead.icpScore,
      company: lead.company
        ? { id: lead.company.id, name: lead.company.name, domain: lead.company.domain }
        : null,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[webhooks] could not queue lead.created", e);
    return 0;
  }
}
