import { auditsQueue, pdfsQueue } from "../../lib/queue";

/**
 * Web-side enqueue only (no Playwright import), so the Next bundle stays light.
 * The heavy processor lives in ./jobs (worker service).
 */
export interface AuditJobData {
  auditId: string;
  workspaceId: string;
  url: string;
  leadId?: string;
  withPitch: boolean;
  /**
   * Multi-page crawl (P2/1). Absent means single page, which is what every
   * public and self-serve audit gets — the crawl is an internal, sales-PDF
   * tool, and leaving it off by default keeps that true by construction.
   */
  crawl?: { cap: number };
}

export async function enqueueAudit(data: AuditJobData): Promise<void> {
  await auditsQueue().add("audit", data, {
    jobId: `audit-${data.auditId}`,
    removeOnComplete: true,
    removeOnFail: 100,
  });
}

export interface PdfJobData {
  auditId: string;
  workspaceId: string;
}

export async function enqueuePdfRender(data: PdfJobData): Promise<void> {
  await pdfsQueue().add("audit-pdf", data, {
    jobId: `pdf-${data.auditId}`,
    removeOnComplete: true,
    removeOnFail: 50,
  });
}

/**
 * Ad-hoc analytics export. The report snapshot rides in the payload rather
 * than being recomputed worker-side, so the PDF is exactly the figures the
 * operator was looking at when they pressed the button — not a fresh
 * aggregate that may have moved.
 */
export interface AnalyticsPdfJobData {
  workspaceId: string;
  /** Relative path under FILES_DIR, e.g. exports/<workspaceId>-analytics-<ts>.pdf */
  rel: string;
  report: unknown;
  commentary: string | null;
}

export async function enqueueAnalyticsPdf(data: AnalyticsPdfJobData): Promise<void> {
  await pdfsQueue().add("analytics-pdf", data, {
    jobId: `analytics-${data.rel}`,
    removeOnComplete: true,
    removeOnFail: 50,
  });
}

/**
 * Branded lead-list PDF (rides the shared PDF queue).
 *
 * Only the lead IDS travel. A thousand rows of contact details in a Redis
 * payload is personal data sitting in a queue backlog with a retention story of
 * its own; the worker re-reads them from the database, which costs one query
 * and keeps erasure meaning what it says.
 */
export interface LeadsPdfEnqueueData {
  workspaceId: string;
  rel: string;
  ids: string[];
  columns: string[];
  meta: { subtitle: string; exportedAt: string; exportedBy: string };
}

export async function enqueueLeadsPdf(data: LeadsPdfEnqueueData): Promise<void> {
  await pdfsQueue().add("leads-pdf", data, {
    jobId: `leads-${data.rel}`,
    removeOnComplete: true,
    removeOnFail: 50,
  });
}
