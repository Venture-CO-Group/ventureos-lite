import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { getMailProvider } from "@/modules/mail/provider";
import { resolveSendingIdentity } from "@/modules/mail/identity";
import { brandEmail, brandEmailText } from "@/modules/mail/layout";
import { brandFrom } from "@/modules/workspaces/brand";
import { isRecipientSuppressed } from "@/modules/mail/suppression";
import { parseFilterSet, parseSort } from "./view-params";
import { listFieldDefs } from "@/modules/fields/store";
import { resolveSelection, loadLeadsForExport } from "./bulk-store";
import { leadsCsvBuffer } from "./bulk";
import {
  MAX_EXPORT_ROWS,
  MAX_PDF_ROWS,
  PDF_FOOTER_TEMPLATE,
  PDF_MARGIN,
  buildLeadsPdfHtml,
  buildLeadsXlsx,
} from "./export-formats";
import { renderHtmlToPdf } from "@/lib/pdf";
import { nextRunAt, type ExportCadence } from "./schedule-logic";
import { describeFilters, type FilterSet } from "./filters";

/**
 * The sweep that sends scheduled exports (P2/2.1).
 *
 * ── WHY A SWEEP AND NOT A TIMER PER SCHEDULE ────────────────────────────────
 *
 * A BullMQ repeat job per schedule would mean creating and destroying repeat
 * keys as people edit them, and a schedule whose key was orphaned by a failed
 * delete would keep firing for ever with nobody able to find it. One hourly
 * sweep over rows that are due is boring, inspectable, and cannot drift from
 * the table it reads.
 *
 * Runs in the worker because a PDF needs Chromium, which only the worker image
 * has.
 */

/** How many schedules one pass will send. Bounds a runaway. */
const MAX_PER_SWEEP = 50;

export async function processScheduledExports(now: Date = new Date()): Promise<number> {
  const due = await prismaUnsafe.scheduledExport.findMany({
    where: {
      enabled: true,
      // A row with no nextRunAt has never been computed — treat it as due and
      // let the first pass schedule it properly.
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
    include: { view: true },
    take: MAX_PER_SWEEP,
  });

  let sent = 0;
  for (const row of due) {
    /**
     * The next slot is written FIRST, and on every path.
     *
     * If a send throws and the row keeps its old due time, the next sweep
     * picks it up again — and a schedule whose export reliably fails would
     * then email the same failure every hour. Advancing first turns a broken
     * schedule into one failure per period, which is what a person can
     * actually act on.
     */
    const spec = {
      cadence: (row.cadence as ExportCadence) ?? "weekly",
      dayOfWeek: row.dayOfWeek,
      dayOfMonth: row.dayOfMonth,
      hour: row.hour,
    };
    // A minute past now, so a slot cannot fire twice in one pass.
    const next = nextRunAt(spec, new Date(now.getTime() + 60_000));

    try {
      await sendOne(row, now);
      await prismaUnsafe.scheduledExport.update({
        where: { id: row.id },
        data: { lastRunAt: now, nextRunAt: next, lastError: null },
      });
      sent += 1;
    } catch (e) {
      await prismaUnsafe.scheduledExport.update({
        where: { id: row.id },
        data: {
          lastRunAt: now,
          nextRunAt: next,
          lastError: (e instanceof Error ? e.message : String(e)).slice(0, 300),
        },
      });
    }
  }
  return sent;
}

type Row = Awaited<ReturnType<typeof prismaUnsafe.scheduledExport.findMany>>[number] & {
  view: { id: string; name: string; filters: unknown; columns: unknown; sort: unknown };
};

async function sendOne(row: Row, now: Date): Promise<void> {
  const workspaceId = row.workspaceId;

  // The view IS the specification — but only its FILTER now. Its column list no
  // longer decides what the file contains: an export carries the lead record,
  // and a saved view showing five columns used to mean a file with five.
  const customFields = await listFieldDefs(workspaceId, "lead");
  const filters = parseFilterSet(JSON.stringify(row.view.filters), customFields);
  // Sort is not used by the export itself (rows come back newest-first), but
  // parsing it keeps this honest about what a view carries.
  parseSort(row.view.sort ? JSON.stringify(row.view.sort) : undefined);

  const filterSummary = `${row.view.name} — ${describeFilters(filters, customFields)}`;

  const ids = await resolveSelection(workspaceId, filters as FilterSet);
  if (ids.length === 0) {
    // Nothing matched. Deliberately NOT an email: a weekly report that says
    // "nothing" every week is the fastest way to teach somebody to filter the
    // sender into a folder.
    return;
  }
  const capped = ids.slice(0, MAX_EXPORT_ROWS);

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, brand: true, mailgunConfig: true },
  });
  const brand = brandFrom(ws?.brand);
  const identity = resolveSendingIdentity(ws?.mailgunConfig, brand);

  const owner = await prismaUnsafe.user.findUnique({
    where: { id: row.userId },
    select: { email: true, name: true },
  });
  const explicit = Array.isArray(row.recipients) ? (row.recipients as string[]) : [];
  const to = (explicit.length > 0 ? explicit : [owner?.email].filter(Boolean)) as string[];
  if (to.length === 0) throw new Error("no recipient");

  // Suppression outranks a schedule: somebody who asked us to stop writing to
  // them does not get a weekly attachment because a colleague set one up.
  const db = getWorkspaceClient(workspaceId);
  const suppressions = (await db.suppression.findMany({ select: { address: true } })).map(
    (s) => s.address,
  );
  const allowed = to.filter((addr) => !isRecipientSuppressed(addr, suppressions));
  if (allowed.length === 0) throw new Error("every recipient is suppressed");

  const { leads, customFields: defs } = await loadLeadsForExport(workspaceId, capped);
  const date = now.toISOString().slice(0, 10);
  const slug = row.view.name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();

  let attachment: { filename: string; content: Buffer; contentType: string };
  if (row.format === "csv") {
    attachment = {
      filename: `${slug}-${date}.csv`,
      content: leadsCsvBuffer(leads, defs),
      contentType: "text/csv; charset=utf-8",
    };
  } else if (row.format === "pdf") {
    // A document holds far fewer rows than a spreadsheet, so a scheduled PDF
    // of a wide view carries the first page of it and the email says so below.
    const forPdf = leads.slice(0, MAX_PDF_ROWS);
    const html = buildLeadsPdfHtml(forPdf, defs, brand, {
      subtitle: `${forPdf.length} leads · ${row.view.name}`,
      filterSummary,
      exportedAt: now,
      exportedBy: owner?.name ?? "scheduled",
      totalRows: ids.length,
    });
    attachment = {
      filename: `${slug}-${date}.pdf`,
      content: await renderHtmlToPdf(html, {
        preferCssPageSize: true,
        footerTemplate: PDF_FOOTER_TEMPLATE,
        margin: PDF_MARGIN,
      }),
      contentType: "application/pdf",
    };
  } else {
    attachment = {
      filename: `${slug}-${date}.xlsx`,
      content: await buildLeadsXlsx(leads, defs, {
        workspaceName: ws?.name ?? "Leads",
        exportedAt: now,
        filterSummary,
      }),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  }

  const truncated = ids.length > capped.length;
  // A PDF is capped again, well below the spreadsheet, so say so separately
  // rather than letting a 500-row document pass as the whole view.
  const pdfTruncated = row.format === "pdf" && capped.length > MAX_PDF_ROWS;
  const paragraphs = [
    `The saved view “${row.view.name}” has ${ids.length} lead${ids.length === 1 ? "" : "s"} in it today.`,
    truncated
      ? `The attachment holds the first ${capped.length} of them — the export limit. Narrow the view if you need the rest.`
      : "The attachment holds all of them, with the full lead record on each row.",
    ...(pdfTruncated
      ? [
          `A document holds ${MAX_PDF_ROWS} leads, so this one carries the first ${MAX_PDF_ROWS}. Switch the schedule to Excel for the whole view.`,
        ]
      : []),
    "This arrived because somebody set up a scheduled export. You can change or stop it in the Lead Engine.",
  ];
  const subject = `${row.view.name} — ${ids.length} lead${ids.length === 1 ? "" : "s"} · ${date}`;

  const options = {
    preheader: subject,
    heading: row.view.name,
    paragraphs,
    stats: [{ label: "Leads", value: String(ids.length) }],
    brandName: brand.name,
    brandMarkBold: brand.markBold,
    brandMarkLight: brand.markLight,
    brandFooter: brand.footerIdentity,
  };

  // Transactional, not cold: this is a report to a colleague who asked for it.
  await getMailProvider().send({
    domain: identity.domain,
    to: allowed.join(", "),
    from: identity.from,
    replyTo: identity.replyTo,
    subject,
    html: brandEmail(options),
    text: brandEmailText(options),
    attachments: [attachment],
  });
}
