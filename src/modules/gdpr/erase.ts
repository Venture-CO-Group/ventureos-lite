import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceClient } from "../../lib/db";

/**
 * Hard-delete a lead and cascade over ALL derived data (spec §10). Guarantees
 * no row anywhere references the erased lead afterwards. Person data is deleted;
 * legal documents follow the retention policy. Runs inside the guarded workspace
 * client, so it can only touch the lead's own workspace.
 *
 * Explicit deletes are needed for tables whose lead_id has no FK relation
 * (audit_shares, campaign_recipients) — Prisma's onDelete never touches those.
 */
const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

export interface EraseResult {
  leadId: string;
  deleted: Record<string, number>;
  filesRemoved: number;
}

async function bestEffortUnlink(paths: Array<string | null | undefined>): Promise<number> {
  let n = 0;
  for (const p of paths) {
    if (!p) continue;
    try {
      await unlink(join(FILES_DIR, p));
      n += 1;
    } catch {
      /* already gone / never written */
    }
  }
  return n;
}

export async function eraseLeadData(
  db: WorkspaceClient,
  leadId: string,
  opts: { eraseDocuments: boolean },
): Promise<EraseResult> {
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    // avatarPath joins the file sweep below: a captured photo is personal data
    // and erasure must take the bytes off disk, not just the row (P1/1f).
    select: { id: true, companyId: true, avatarPath: true, contactName: true },
  });
  if (!lead) return { leadId, deleted: {}, filesRemoved: 0 };

  const deleted: Record<string, number> = {};
  const files: Array<string | null> = [];
  const leadName = lead.contactName;

  // Files first (collect paths before rows vanish).
  files.push(lead.avatarPath);
  const meetings = await db.meeting.findMany({ where: { leadId }, select: { briefPdfPath: true } });
  files.push(...meetings.map((m) => m.briefPdfPath));

  // Tables WITHOUT a lead FK — must delete explicitly or they orphan.
  deleted.meetings = (await db.meeting.deleteMany({ where: { leadId } })).count;
  deleted.emailLogs = (await db.emailLog.deleteMany({ where: { leadId } })).count;

  // Tasks link polymorphically (P3/3), so there is no cascade to rely on — the
  // rows would survive their lead and keep its name in a title. Deleted here
  // explicitly, which the Task model comment warns is required.
  deleted.tasks = (
    await db.task.deleteMany({ where: { entityType: "lead", entityId: leadId } })
  ).count;

  // Synced correspondence (playbook-v2 P2). Messages cascade from the thread,
  // but the ATTACHMENT BYTES on the volume do not — a row deletion that leaves
  // the files behind is the easy half of an erasure and the wrong half. Paths
  // join the same sweep every other file uses, collected before the rows go.
  const mailThreads = await db.emailThread.findMany({
    where: { leadId },
    select: { messages: { select: { attachments: true } } },
  });
  for (const thread of mailThreads) {
    for (const message of thread.messages) {
      const stored = Array.isArray(message.attachments)
        ? (message.attachments as Array<{ storedPath?: string }>)
        : [];
      files.push(...stored.map((f) => f?.storedPath ?? null));
    }
  }
  deleted.emailThreads = (await db.emailThread.deleteMany({ where: { leadId } })).count;
  // The address→lead mapping is personal data in its own right: it says this
  // address belongs to this person.
  deleted.addressLinks = (await db.addressLink.deleteMany({ where: { leadId } })).count;
  deleted.auditShares = (await db.auditShare.deleteMany({ where: { leadId } })).count;
  /**
   * The signal layer (v3 P8/e).
   *
   * A page visit tied to this lead says a named person's employer read a
   * document we addressed to them, on a date, for a length of time. That is
   * personal data about the erased person even though no name is stored in the
   * row, so it goes with them — and so does the signal derived from it.
   */
  deleted.visitorSignals = (await db.visitorSignal.deleteMany({ where: { leadId } })).count;
  deleted.pageVisits = (await db.pageVisit.deleteMany({ where: { leadId } })).count;
  // Open/click events on mail we sent this person (v3 P9/1). "This address
  // opened this message at this time" is personal data about them.
  deleted.emailTrackEvents = (await db.emailTrackEvent.deleteMany({ where: { leadId } })).count;
  deleted.campaignRecipients = (await db.campaignRecipient.deleteMany({ where: { leadId } })).count;
  /**
   * The outbound motor's record of this person (playbook-v6): the candidate
   * row holds their name and address in its contact trail, and every draft
   * holds the address and the words written to them. Both go. The
   * suppression entries do NOT — "do not contact" must outlive the erasure,
   * or the next harvest would find the company and write to them again.
   */
  const candidates = await db.prospectCandidate.findMany({ where: { leadId }, select: { id: true } });
  if (candidates.length > 0) {
    const ids = candidates.map((c) => c.id);
    deleted.outreachDrafts = (await db.outreachDraft.deleteMany({ where: { candidateId: { in: ids } } })).count;
    deleted.prospectCandidates = (await db.prospectCandidate.deleteMany({ where: { id: { in: ids } } })).count;
  }

  // Documents: per retention policy — purge (with PDFs) or retain detached.
  if (opts.eraseDocuments) {
    const docs = await db.document.findMany({ where: { leadId }, select: { pdfUrl: true } });
    files.push(...docs.map((d) => d.pdfUrl));
    deleted.documents = (await db.document.deleteMany({ where: { leadId } })).count;
  } else {
    // Retained under legal basis; sever the person link so no orphan remains.
    deleted.documentsDetached = (
      await db.document.updateMany({ where: { leadId }, data: { leadId: null } })
    ).count;
  }

  // Deals (v2 P4). A deal is a commercial record about money, held under the
  // same kind of lawful basis as a retained document, so it is DETACHED rather
  // than deleted — the foreign key would do that on its own.
  //
  // What the foreign key would NOT do is the part that matters here: a deal
  // created for a lead with no company is titled after the PERSON, and a title
  // is personal data that would survive the erasure in plain sight. Any title
  // carrying the contact's name is rewritten before the link is cut.
  const leadDeals = await db.deal.findMany({
    where: { leadId },
    select: { id: true, title: true, company: { select: { name: true } } },
  });
  if (leadDeals.length) {
    const name = leadName?.trim();
    for (const deal of leadDeals) {
      const carriesName = !!name && name.length > 1 && deal.title.includes(name);
      await db.deal.update({
        where: { id: deal.id },
        data: {
          leadId: null,
          ...(carriesName
            ? { title: deal.company?.name ? `${deal.company.name} — deal` : "Erased contact — deal" }
            : {}),
        },
      });
    }
    deleted.dealsDetached = leadDeals.length;
  }

  // Delete the lead → cascades activities, messages, calls, deal_outcomes.
  await db.lead.delete({ where: { id: leadId } });
  deleted.lead = 1;

  // If this was the company's last lead, erase its audit results (+ shares cascade).
  if (lead.companyId) {
    const remaining = await db.lead.count({ where: { companyId: lead.companyId } });
    if (remaining === 0) {
      const audits = await db.auditResult.findMany({
        where: { companyId: lead.companyId },
        select: { pdfPath: true },
      });
      files.push(...audits.map((a) => a.pdfPath));
      deleted.auditResults = (await db.auditResult.deleteMany({ where: { companyId: lead.companyId } })).count;
    }
  }

  const filesRemoved = await bestEffortUnlink(files);
  return { leadId, deleted, filesRemoved };
}
