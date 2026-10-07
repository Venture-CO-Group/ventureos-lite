import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { createTaskFromSignal } from "@/modules/tasks/from-signal";
import { safeDeliver } from "@/modules/notifications/notify";
import { leadRecipients } from "@/modules/notifications/recipients";
import {
  buildReferralDraft,
  cooldownPassed,
  REFERRAL_COOLDOWN_DAYS,
  REFERRAL_DELAY_DAYS,
} from "./request";

/**
 * The daily sweep that notices the moment (playbook-v4 P13/3).
 *
 * Certificates acknowledged fourteen days ago, once per client per six months,
 * only where the workspace has left it on. Everything it produces is a draft
 * and a task.
 */
export interface ReferralSettings {
  enabled: boolean;
}

export function referralSettingsFrom(raw: unknown): ReferralSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  // On by default: the feature is a reminder to do something the business
  // already wants to do, and the drafts go nowhere without a person.
  return { enabled: typeof r.enabled === "boolean" ? r.enabled : true };
}

export async function processReferralSweep(now: Date = new Date()): Promise<number> {
  const workspaces = await prismaUnsafe.workspace.findMany({
    where: { deletedAt: null },
    select: { id: true, featureFlags: true },
  });
  let drafted = 0;

  for (const ws of workspaces) {
    const flags = (ws.featureFlags ?? {}) as Record<string, unknown>;
    if (!referralSettingsFrom(flags.referralRequests).enabled) continue;

    const db = getWorkspaceClient(ws.id);
    const cutoff = new Date(now.getTime() - REFERRAL_DELAY_DAYS * 86_400_000);

    const certificates = await db.document.findMany({
      where: {
        type: "CERTIFICATE",
        status: "ACKNOWLEDGED",
        acknowledgedAt: { not: null, lte: cutoff },
      },
      select: {
        id: true,
        leadId: true,
        payload: true,
        lead: {
          select: {
            contactName: true,
            companyId: true,
            company: { select: { name: true, industry: true } },
          },
        },
      },
      take: 100,
    });

    for (const cert of certificates) {
      const existing = await db.referralRequest.findUnique({
        where: { documentId: cert.id },
        select: { id: true },
      });
      if (existing) continue;

      const companyId = cert.lead?.companyId ?? null;

      // One ask per client per six months, whatever they bought in between.
      if (companyId) {
        const last = await db.referralRequest.findFirst({
          where: { companyId },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });
        if (!cooldownPassed(last?.createdAt ?? null, now)) continue;
      }

      const draft = buildReferralDraft({
        contactName: cert.lead?.contactName ?? null,
        companyName: cert.lead?.company?.name ?? null,
        scope: ((cert.payload ?? {}) as { scope?: string }).scope ?? null,
        industry: cert.lead?.company?.industry ?? null,
      });

      let messageId: string | null = null;
      if (cert.leadId) {
        const message = await db.message.create({
          data: {
            workspaceId: ws.id,
            leadId: cert.leadId,
            direction: "OUTBOUND",
            channel: "EMAIL",
            kind: "referral_request",
            body: `${draft.subject}\n\n${draft.body}`,
            status: "DRAFT",
            // Template text with the client's own project in it — not Claude,
            // so the human-edit guardrail that governs AI drafts does not
            // apply. It still cannot be sent from here.
            aiDrafted: false,
          },
          select: { id: true },
        });
        messageId = message.id;
      }

      const taskId = cert.leadId
        ? await createTaskFromSignal(db, {
            workspaceId: ws.id,
            title: `Ajánlatkérés — ${cert.lead?.company?.name ?? cert.lead?.contactName ?? "ügyfél"}`,
            note: `Két hete igazolták vissza a teljesítést. A piszkozat elkészült; olvasd át és küldd el, ha jónak látod. Következő kérés leghamarabb ${REFERRAL_COOLDOWN_DAYS} nap múlva.`,
            type: "email",
            entityType: "lead",
            entityId: cert.leadId,
            source: "referral_request",
            dueInDays: 1,
          })
        : null;

      await db.referralRequest.create({
        data: {
          workspaceId: ws.id,
          documentId: cert.id,
          leadId: cert.leadId,
          companyId,
          messageId,
          taskId,
        },
      });

      if (cert.leadId) {
        await safeDeliver({
          workspaceId: ws.id,
          userIds: await leadRecipients(ws.id, cert.leadId),
          type: "visitor_signal",
          title: `Ajánlatkérés kész: ${cert.lead?.company?.name ?? "ügyfél"}`,
          body: "Két hete igazolták vissza a teljesítést — most a legjobb pillanat megkérdezni.",
          href: `/leads?lead=${cert.leadId}`,
          entityType: "lead",
          entityId: cert.leadId,
          discriminator: `referral:${cert.id}`,
        });
      }
      drafted += 1;
    }
  }
  return drafted;
}
