import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { prismaUnsafe, getWorkspaceClient } from "../../lib/db";
import { renderHtmlToPdf } from "../../lib/pdf";
import { getMailProvider } from "../mail/provider";
import { resolveSendingIdentity } from "../mail/identity";
import { callClaude } from "../../lib/ai/call-claude";
import {
  WEEKLY_REPORT_SYSTEM,
  weeklyReportSchema,
  buildWeeklyReportMessage,
  type WeeklyReportCommentary,
} from "../../lib/ai/prompts/weekly-report";
import { collectReportInput } from "./report-data";
import { buildWeeklyReport, type WeeklyReport } from "./reports";
import { buildReportPdfHtml } from "./report-pdf";
import { brandFrom } from "@/modules/workspaces/brand";
import { brandEmail, brandEmailText } from "../mail/layout";

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

function isoWeekLabel(nowMs: number): { label: string; sinceMs: number; untilMs: number } {
  const d = new Date(nowMs);
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((nowMs - jan1) / 86_400_000 + 1) / 7);
  return { label: `week ${week}`, sinceMs: nowMs - 7 * 24 * 60 * 60_000, untilMs: nowMs };
}

/**
 * Generate one workspace's weekly report (spec §4.14). Numbers are
 * deterministic (zero manual steps); a single Haiku call adds the "what worked"
 * commentary (best-effort). Persists a Report row + branded PDF and emails the
 * Owner(s). Returns the report id.
 */
export async function generateWeeklyReport(
  workspaceId: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const db = getWorkspaceClient(workspaceId);
  const { label, sinceMs, untilMs } = isoWeekLabel(nowMs);

  const input = await collectReportInput(db, { weekLabel: label, sinceMs, untilMs });
  const report: WeeklyReport = buildWeeklyReport(input);

  // One Haiku call for the narrative — the numbers stand alone if it fails.
  let commentary: string | null = null;
  try {
    const { data } = await callClaude<WeeklyReportCommentary>({
      useCase: "weekly_report",
      workspaceId,
      system: WEEKLY_REPORT_SYSTEM,
      schema: weeklyReportSchema,
      messages: [{ role: "user", content: buildWeeklyReportMessage(report) }],
    });
    commentary = (data as WeeklyReportCommentary).commentary;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[report] commentary failed for ${workspaceId}`, e);
  }

  const created = await db.report.create({
    data: { workspaceId, weekLabel: label, data: report as unknown as object, commentary },
  });

  // Branded PDF via the shared pipeline — per workspace (audit-v2 item 6).
  const brandRow = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { brand: true },
  });
  const html = buildReportPdfHtml(report, commentary, null, brandFrom(brandRow?.brand));
  const pdf = await renderHtmlToPdf(html);
  const rel = `reports/${created.id}.pdf`;
  await mkdir(join(FILES_DIR, "reports"), { recursive: true });
  await writeFile(join(FILES_DIR, rel), pdf);
  await db.report.update({ where: { id: created.id }, data: { pdfPath: rel } });

  // Deliver to Owner(s).
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { mailgunConfig: true },
  });
  const brand = brandFrom(brandRow?.brand);
  const identity = resolveSendingIdentity(ws?.mailgunConfig, brand);
  const owners = await prismaUnsafe.membership.findMany({
    where: { workspaceId, role: "OWNER" },
    include: { user: { select: { email: true } } },
  });
  // The workspace's own name, never the product's.
  const subject = `${brand.name} — Friday report · ${label}`;

  /**
   * The covering email carries the headline numbers.
   *
   * It used to say only "the full report is attached", under an `<h2>` and with
   * no plain-text part — so the weekly report was invisible until someone
   * downloaded a PDF on a phone. The KPIs and the funnel's ends are the two
   * things worth reading in the notification itself; the PDF still holds
   * everything.
   */
  const firstStep = report.funnel[0];
  const lastStep = report.funnel[report.funnel.length - 1];
  const content = {
    preheader: commentary ?? `${label} — funnel, sources and document chains.`,
    heading: `Friday report · ${label}`,
    paragraphs: commentary ? [commentary] : ["The week in numbers."],
    metrics: report.kpis.slice(0, 3).map((k) => ({
      label: k.metric,
      value: String(k.value),
      hint: k.target ? `target ${k.target}` : undefined,
    })),
    sections: [
      ...(firstStep && lastStep && firstStep !== lastStep
        ? [
            {
              heading: "Funnel",
              rows: report.funnel.map((f) => ({
                label: f.stage,
                value:
                  f.conversion === null
                    ? String(f.count)
                    : `${f.count} · ${Math.round(f.conversion * 100)}%`,
              })),
            },
          ]
        : []),
      ...(report.sources.length
        ? [
            {
              heading: "By source",
              rows: report.sources.slice(0, 6).map((r) => ({
                label: r.source,
                value: `${r.leads} leads · ${r.won} won · ${Math.round(r.winRate * 100)}%`,
              })),
            },
          ]
        : []),
    ],
    footNote:
      "The attached PDF has the full funnel, per-source performance, audit→meeting and document-chain metrics.",
    brand,
  };
  for (const owner of owners) {
    const { id } = await getMailProvider().send({
      domain: identity.domain,
      to: owner.user.email,
      from: identity.from,
      replyTo: identity.replyTo || undefined,
      subject,
      html: brandEmail(content),
      text: brandEmailText(content),
      attachments: [{ filename: `${label.replace(/\s/g, "-")}.pdf`, content: pdf, contentType: "application/pdf" }],
    });
    await db.emailLog.create({
      data: { workspaceId, to: owner.user.email, subject, mailgunId: id, status: "QUEUED" },
    });
  }
  return created.id;
}

/** Cross-workspace Friday cron. Returns workspaces reported. */
export async function processWeeklyReports(nowMs: number = Date.now()): Promise<number> {
  const workspaces = await prismaUnsafe.workspace.findMany({ where: { deletedAt: null }, select: { id: true } });
  for (const ws of workspaces) {
    try {
      await generateWeeklyReport(ws.id, nowMs);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[report] weekly report failed for ${ws.id}`, e);
    }
  }
  return workspaces.length;
}
