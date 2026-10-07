import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { prismaUnsafe, getWorkspaceClient, type WorkspaceClient } from "../../lib/db";
import { Prisma } from "@prisma/client";
import { pseudonymizeLead, shouldAnonymize } from "./anonymize";
import { parseRetention } from "./retention";

/**
 * Anonymize a single lead in place (spec §10). Pseudonymizes the lead's person
 * fields and scrubs conversation PII (message bodies, call notes), keeping the
 * rows so aggregate stats survive. Idempotent: re-running is a no-op on the
 * pseudonym + timestamp and leaves already-scrubbed bodies unchanged.
 */
export async function anonymizeLead(
  db: WorkspaceClient,
  leadId: string,
  nowMs: number,
): Promise<boolean> {
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      contactName: true,
      email: true,
      phone: true,
      linkedinUrl: true,
      notes: true,
      bio: true,
      personBrief: true,
      avatarPath: true,
      anonymizedAt: true,
    },
  });
  if (!lead) return false;

  const patch = pseudonymizeLead(lead, nowMs);
  await db.lead.update({
    where: { id: leadId },
    // `customFields` is a nullable Json column, and Prisma spells "write SQL
    // NULL here" as DbNull rather than as `null` — passing `null` is a type
    // error, and passing JsonNull would store the JSON literal `null`, which is
    // a value rather than an absence.
    data: { ...patch, customFields: Prisma.DbNull },
  });

  // Clearing avatarPath is not enough — the image is a photograph of a person
  // and has to leave the disk too (P1/1f). Best effort: a file already gone is
  // the desired end state anyway.
  if (lead.avatarPath) {
    try {
      await unlink(join(process.env.FILES_DIR ?? "/data/files", lead.avatarPath));
    } catch {
      /* already gone */
    }
  }
  // Conversation PII — scrub bodies/notes but keep the rows (counts/timing).
  await db.message.updateMany({ where: { leadId }, data: { body: "[anonymized]" } });
  await db.call.updateMany({ where: { leadId, note: { not: null } }, data: { note: null } });
  return true;
}

/**
 * Monthly inactivity sweep (spec §10). Per workspace, anonymizes leads inactive
 * beyond the retention window that aren't already anonymized. Returns the total
 * anonymized across all workspaces.
 */
export async function processAnonymizationSweep(nowMs: number = Date.now()): Promise<number> {
  const workspaces = await prismaUnsafe.workspace.findMany({
    where: { deletedAt: null },
    select: { id: true, retentionDays: true, featureFlags: true },
  });

  let total = 0;
  for (const ws of workspaces) {
    const policy = parseRetention(ws);
    const cutoffMs = nowMs - policy.anonymizeAfterDays * 24 * 60 * 60_000;
    const db = getWorkspaceClient(ws.id);
    const candidates = await db.lead.findMany({
      where: { anonymizedAt: null },
      select: { id: true, lastActivityAt: true, createdAt: true, anonymizedAt: true },
    });
    for (const lead of candidates) {
      if (!shouldAnonymize(lead, cutoffMs)) continue;
      await anonymizeLead(db, lead.id, nowMs);
      total += 1;
    }
  }
  return total;
}
