import { Worker } from "bullmq";
import { checkEnvAtBoot } from "../lib/env";
import {
  getRedisConnection,
  wakeupsQueue,
  FOLLOWUPS_QUEUE,
  WAKEUPS_QUEUE,
  AUDIT_QUEUE,
  PDF_QUEUE,
  CALLBACKS_QUEUE,
  BRIEFS_QUEUE,
  ERASURE_QUEUE,
  LOGS_QUEUE,
  VISITS_QUEUE,
  VERIFY_QUEUE,
} from "../lib/queue";
import { processFollowup, processWakeupSweep } from "../modules/pipeline/jobs";
import {
  processAudit,
  processPdfRender,
  processAuditWatchSweep,
  AUDIT_DEADLINE_MS,
} from "../modules/audit/jobs";
import { processCallbackDue } from "../modules/calls/jobs";
import { processDocumentPdf } from "../modules/documents/jobs";
import { processAnalyticsPdf } from "../modules/analytics/export-job";
import { processCommissionPdf } from "../modules/revenue/pdf-job";
import { processPublicAuditReport } from "../modules/public-audit/report-job";
import { processLeadsPdf } from "../modules/leads/export-job";
import { processScheduledExports } from "../modules/leads/schedule-job";
import { processAuditLogRetention } from "../modules/auditlog/jobs";
import {
  processWebhookDeliveries,
  processWebhookLogRetention,
} from "../modules/webhooks/jobs";
import { processMeetingBrief } from "../modules/meetings/jobs";
import { processQuarterlyWinLoss } from "../modules/analytics/digest";
import { processWeeklyReports } from "../modules/analytics/report-job";
import { processMondayDigests } from "../modules/analytics/monday-digest";
import { processLeadErasure } from "../modules/gdpr/jobs";
import { processAnonymizationSweep } from "../modules/gdpr/sweep";
import { processColdSends } from "../modules/campaigns/jobs";
import { processInvoicePolls } from "../modules/invoicing/jobs";
import { processSignalEngine, processDailyInsight } from "../modules/signal/jobs";
import { processStageProbabilityCalibration } from "../modules/deals/jobs";
import { processWorkflowOverdueSweep } from "../modules/workflow/triggers";
import { processKeywordTracking } from "../modules/serp/jobs";
import { processLogUpload, processLogRetention } from "../modules/logs/jobs";
import { processMailSyncSweep } from "../modules/email/jobs";
import {
  processNotificationRetention,
  processTaskDueSweep,
} from "../modules/notifications/jobs";
import {
  processVisitEnrichment,
  processRawIpPurge,
  processVisitRetention,
} from "../modules/tracking/jobs";
import { processAudienceVerification } from "../modules/verification/jobs";
import { processQuoteRuleSweep } from "../modules/quote-rules/jobs";
import { processEmailTrackRetention } from "../modules/email/track-jobs";
import {
  processSectorBatch,
  processSectorAggregation,
} from "../modules/sector-reports/jobs";
import { processReferralSweep } from "../modules/referrals/jobs";

/**
 * Background worker (BullMQ + Redis). Runs in its own Docker service.
 * Processes follow-up automations and the daily Not-now wake-up sweep.
 */
async function main(): Promise<void> {
  // Same boot gate as the app (src/instrumentation.ts): a misconfigured worker
  // would happily render PDFs with localhost links and send cold mail on the
  // wrong domain, so it must refuse to start instead.
  if (process.env.SKIP_ENV_VALIDATION !== "1") {
    checkEnvAtBoot("worker");
  }

  const connection = getRedisConnection();

  // eslint-disable-next-line no-console
  console.log("[worker] starting — followups, audits, pdfs, callbacks, briefs, wakeups");

  const followupWorker = new Worker(
    FOLLOWUPS_QUEUE,
    async (job) => {
      await processFollowup(job.data);
    },
    { connection },
  );
  followupWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] followup ${job?.id} failed`, err);
  });

  const auditWorker = new Worker(
    AUDIT_QUEUE,
    async (job) => {
      // Sector batches ride the audit queue on purpose: they ARE audits, and
      // sharing the queue means one concurrency limit governs how hard we ever
      // hit other people's websites (v4 P12/2a).
      if (job.name === "sector-batch") {
        const n = await processSectorBatch(job.data.reportId as string);
        // eslint-disable-next-line no-console
        console.log(`[worker] sector batch queued ${n} audit(s)`);
        return;
      }
      /**
       * A hard ceiling on the job, not only on its steps.
       *
       * BullMQ has no per-job timeout: a processor that never settles holds
       * its concurrency slot for the life of the worker. At a concurrency of
       * two that means two hung audits wedge every audit in every workspace,
       * indefinitely, and the only symptom is rows sitting at "queued". The
       * processor already bounds each step and marks the row on failure; this
       * is the backstop for the step nobody thought to bound.
       */
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          processAudit(job.data),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `audit ${job.data.auditId} exceeded ${AUDIT_DEADLINE_MS / 1000}s`,
                  ),
                ),
              AUDIT_DEADLINE_MS + 30_000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    { connection, concurrency: 2 },
  );
  auditWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] audit ${job?.id} failed`, err);
  });

  const pdfWorker = new Worker(
    PDF_QUEUE,
    async (job) => {
      if (job.name === "document-pdf") await processDocumentPdf(job.data);
      else if (job.name === "analytics-pdf") await processAnalyticsPdf(job.data);
      else if (job.name === "commission-pdf") await processCommissionPdf(job.data);
      else if (job.name === "public-audit-report") await processPublicAuditReport(job.data);
      else if (job.name === "leads-pdf") await processLeadsPdf(job.data);
      else await processPdfRender(job.data);
    },
    { connection, concurrency: 2 },
  );
  pdfWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] pdf ${job?.id} failed`, err);
  });

  const callbackWorker = new Worker(
    CALLBACKS_QUEUE,
    async (job) => {
      await processCallbackDue(job.data);
    },
    { connection },
  );
  callbackWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] callback ${job?.id} failed`, err);
  });

  const briefWorker = new Worker(
    BRIEFS_QUEUE,
    async (job) => {
      await processMeetingBrief(job.data);
    },
    { connection, concurrency: 2 },
  );
  briefWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] brief ${job?.id} failed`, err);
  });

  const erasureWorker = new Worker(
    ERASURE_QUEUE,
    async (job) => {
      await processLeadErasure(job.data);
    },
    { connection },
  );
  erasureWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] erasure ${job?.id} failed`, err);
  });

  // Log parsing is streamed and can run for minutes on a month of traffic, so
  // it gets its own queue rather than blocking audits (P2/8).
  const logWorker = new Worker(
    LOGS_QUEUE,
    async (job) => {
      await processLogUpload(job.data);
    },
    { connection, concurrency: 1 },
  );
  logWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] log upload ${job?.id} failed`, err);
  });

  // Visitor identification (v3 P8/b). One job per visit, a minute after it
  // opened, so the reading time it reports is real.
  const visitWorker = new Worker(
    VISITS_QUEUE,
    async (job) => {
      const identified = await processVisitEnrichment(job.data.visitId as string);
      if (identified) {
        // eslint-disable-next-line no-console
        console.log(`[worker] visitor signal raised for visit ${job.data.visitId}`);
      }
    },
    { connection },
  );
  visitWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] visit enrichment failed for ${job?.data?.visitId}`, err);
  });

  // The tail of a large cold audience (v3 P9/2). The action verifies the first
  // hundred so the operator sees an answer; the rest has no request timeout to
  // run into here.
  const verifyWorker = new Worker(
    VERIFY_QUEUE,
    async (job) => {
      const n = await processAudienceVerification(job.data.campaignId as string);
      // eslint-disable-next-line no-console
      console.log(`[worker] verified ${n} address(es) for campaign ${job.data.campaignId}`);
    },
    { connection },
  );
  verifyWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] audience verification failed for ${job?.data?.campaignId}`, err);
  });

  const wakeupWorker = new Worker(
    WAKEUPS_QUEUE,
    async (job) => {
      if (job.name === "friday-report") {
        const n = await processWeeklyReports();
        // eslint-disable-next-line no-console
        console.log(`[worker] friday report generated for ${n} workspace(s)`);
      } else if (job.name === "monday-digest") {
        const n = await processMondayDigests();
        // eslint-disable-next-line no-console
        console.log(`[worker] monday digest sent to ${n} user(s)`);
      } else if (job.name === "monthly-anonymize") {
        const n = await processAnonymizationSweep();
        // eslint-disable-next-line no-console
        console.log(`[worker] anonymized ${n} inactive lead(s)`);
      } else if (job.name === "cold-send") {
        const n = await processColdSends();
        // eslint-disable-next-line no-console
        console.log(`[worker] cold email sent ${n} message(s)`);
      } else if (job.name === "invoice-poll") {
        const n = await processInvoicePolls();
        // eslint-disable-next-line no-console
        console.log(`[worker] invoice poll marked ${n} paid`);
      } else if (job.name === "quarterly-winloss") {
        const n = await processQuarterlyWinLoss();
        // eslint-disable-next-line no-console
        console.log(`[worker] win/loss digest sent for ${n} workspace(s)`);
      } else if (job.name === "workflow-overdue") {
        const n = await processWorkflowOverdueSweep();
        // eslint-disable-next-line no-console
        console.log(`[worker] workflow overdue sweep fired ${n} rule(s)`);
      } else if (job.name === "quarterly-stage-probability") {
        const n = await processStageProbabilityCalibration();
        // eslint-disable-next-line no-console
        console.log(`[worker] raised ${n} stage-probability proposal(s)`);
      } else if (job.name === "signal-weekly") {
        const n = await processSignalEngine();
        // eslint-disable-next-line no-console
        console.log(`[worker] signal engine ran for ${n} workspace(s)`);
      } else if (job.name === "mail-sync") {
        const n = await processMailSyncSweep();
        // eslint-disable-next-line no-console
        console.log(`[worker] mail sync stored ${n} message(s)`);
      } else if (job.name === "log-retention") {
        const n = await processLogRetention();
        // eslint-disable-next-line no-console
        console.log(`[worker] purged ${n} raw log upload(s)`);
      } else if (job.name === "keyword-tracking") {
        const n = await processKeywordTracking();
        // eslint-disable-next-line no-console
        console.log(`[worker] keyword tracking checked ${n} position(s)`);
      } else if (job.name === "audit-watch") {
        const n = await processAuditWatchSweep();
        // eslint-disable-next-line no-console
        console.log(`[worker] audit watch queued ${n} re-audit(s)`);
      } else if (job.name === "webhook-deliveries") {
        const n = await processWebhookDeliveries();
        // eslint-disable-next-line no-console
        console.log(`[worker] delivered ${n} webhook(s)`);
      } else if (job.name === "webhook-log-retention") {
        const n = await processWebhookLogRetention();
        // eslint-disable-next-line no-console
        console.log(`[worker] purged ${n} webhook delivery record(s)`);
      } else if (job.name === "audit-log-retention") {
        const n = await processAuditLogRetention();
        // eslint-disable-next-line no-console
        console.log(`[worker] pruned ${n} audit-log row(s)`);
      } else if (job.name === "scheduled-exports") {
        const n = await processScheduledExports();
        // eslint-disable-next-line no-console
        console.log(`[worker] scheduled exports sent ${n} report(s)`);
      } else if (job.name === "task-due") {
        const n = await processTaskDueSweep();
        // eslint-disable-next-line no-console
        console.log(`[worker] task-due sweep notified ${n} task(s)`);
      } else if (job.name === "notification-retention") {
        const n = await processNotificationRetention();
        // eslint-disable-next-line no-console
        console.log(`[worker] purged ${n} expired notification(s)`);
      } else if (job.name === "referral-sweep") {
        const n = await processReferralSweep();
        // eslint-disable-next-line no-console
        console.log(`[worker] drafted ${n} referral request(s)`);
      } else if (job.name === "sector-aggregate") {
        const n = await processSectorAggregation();
        // eslint-disable-next-line no-console
        console.log(`[worker] ${n} sector report(s) became ready`);
      } else if (job.name === "quote-rules") {
        const n = await processQuoteRuleSweep();
        // eslint-disable-next-line no-console
        console.log(`[worker] quote rules fired ${n} time(s)`);
      } else if (job.name === "visitor-ip-purge") {
        const n = await processRawIpPurge();
        // eslint-disable-next-line no-console
        console.log(`[worker] purged raw IP from ${n} visit(s)`);
      } else if (job.name === "mail-track-retention") {
        const n = await processEmailTrackRetention();
        // eslint-disable-next-line no-console
        console.log(`[worker] purged ${n} email tracking event(s)`);
      } else if (job.name === "visitor-retention") {
        const n = await processVisitRetention();
        // eslint-disable-next-line no-console
        console.log(`[worker] anonymised ${n} expired visit(s)`);
      } else if (job.name === "daily-insight") {
        const n = await processDailyInsight();
        // eslint-disable-next-line no-console
        console.log(`[worker] daily insight refreshed for ${n} workspace(s)`);
      } else {
        const n = await processWakeupSweep();
        // eslint-disable-next-line no-console
        console.log(`[worker] wake-up sweep surfaced ${n} lead(s)`);
      }
    },
    { connection },
  );
  wakeupWorker.on("failed", (_job, err) => {
    // eslint-disable-next-line no-console
    console.error("[worker] wakeup sweep failed", err);
  });

  /**
   * Scheduled exports, hourly on the hour (P2/2.1).
   *
   * Hourly because the finest granularity a schedule offers is an hour, and a
   * sweep over rows that are due is boring and inspectable — a BullMQ repeat
   * key per schedule would need creating and destroying as people edit them,
   * and an orphaned key would fire for ever with nobody able to find it.
   */
  await wakeupsQueue().add(
    "scheduled-exports",
    {},
    { repeat: { pattern: "5 * * * *" }, jobId: "scheduled-exports" },
  );
  /**
   * Audit-log retention, nightly (P5/5.3).
   *
   * Nightly rather than hourly: the finest period on offer is ninety days, so
   * checking twenty-four times a day would only mean twenty-three no-op passes
   * over every workspace. Each sweep that removes anything leaves an
   * `audit_log.pruned` row behind — otherwise a gap in the log is
   * indistinguishable from somebody covering their tracks.
   */
  await wakeupsQueue().add(
    "audit-log-retention",
    {},
    { repeat: { pattern: "40 3 * * *" }, jobId: "audit-log-retention" },
  );
  /**
   * Outbound webhook delivery, every minute (P5/5.2).
   *
   * The finest cadence in this file, because an integration that learns about a
   * won deal an hour later is not an integration. A minute is close enough to
   * live for anything a person watches, and the sweep is a single indexed query
   * that usually finds nothing.
   *
   * Retries ride the same sweep: a row carries its own `next_attempt_at`, so
   * backoff needs no second timer and no per-endpoint repeat key that could be
   * orphaned by an edit.
   */
  await wakeupsQueue().add(
    "webhook-deliveries",
    {},
    { repeat: { pattern: "* * * * *" }, jobId: "webhook-deliveries" },
  );
  // The delivery log holds full payload copies — lead names, contract totals —
  // so it expires like any other tenant data. Nightly.
  await wakeupsQueue().add(
    "webhook-log-retention",
    {},
    { repeat: { pattern: "50 3 * * *" }, jobId: "webhook-log-retention" },
  );
  // Task-due sweep, hourly. The dedupe key carries the day, so an overdue task
  // notifies once a day rather than once an hour (P6/1).
  await wakeupsQueue().add(
    "task-due",
    {},
    { repeat: { pattern: "0 * * * *" }, jobId: "task-due" },
  );
  // Notification retention (90 days) at 03:45, beside the other nightly purges.
  await wakeupsQueue().add(
    "notification-retention",
    {},
    { repeat: { pattern: "45 3 * * *" }, jobId: "notification-retention" },
  );
  /**
   * Notice when a sector batch has finished, every ten minutes.
   *
   * The audits run asynchronously and there is no single moment they all land,
   * so the aggregation is a sweep rather than a callback — and ten minutes is
   * fast enough for something an Owner started deliberately and will come back
   * to.
   */
  await wakeupsQueue().add(
    "sector-aggregate",
    {},
    { repeat: { pattern: "*/10 * * * *" }, jobId: "sector-aggregate" },
  );
  // Referral asks at 09:00 — a morning task, on a day somebody is working.
  await wakeupsQueue().add(
    "referral-sweep",
    {},
    { repeat: { pattern: "0 9 * * *" }, jobId: "referral-sweep" },
  );
  // Quote-behaviour rules at 08:30 — before the working day, so a "call them"
  // task is on the list when the list is first read (v4 P14/3).
  await wakeupsQueue().add(
    "quote-rules",
    {},
    { repeat: { pattern: "30 8 * * *" }, jobId: "quote-rules" },
  );
  /**
   * The raw-IP purge, HOURLY (v3 P8/e).
   *
   * The promise on the privacy page is 24 hours, and a nightly job would make
   * that "up to 48" for an address recorded just after it ran. Hourly makes the
   * sentence true with an hour to spare.
   */
  await wakeupsQueue().add(
    "visitor-ip-purge",
    {},
    { repeat: { pattern: "20 * * * *" }, jobId: "visitor-ip-purge" },
  );
  // Open/click feedback beyond 90 days at 03:55, beside the other purges.
  await wakeupsQueue().add(
    "mail-track-retention",
    {},
    { repeat: { pattern: "55 3 * * *" }, jobId: "mail-track-retention" },
  );
  // Visit detail beyond 90 days at 03:50 — the count survives, the session does not.
  await wakeupsQueue().add(
    "visitor-retention",
    {},
    { repeat: { pattern: "50 3 * * *" }, jobId: "visitor-retention" },
  );
  // Daily wake-up sweep at 06:00. Idempotent — repeat jobs dedupe by key.
  await wakeupsQueue().add(
    "daily",
    {},
    { repeat: { pattern: "0 6 * * *" }, jobId: "daily-wakeup" },
  );
  // Friday report at 16:00.
  await wakeupsQueue().add(
    "friday-report",
    {},
    { repeat: { pattern: "0 16 * * 5" }, jobId: "friday-report" },
  );
  // Monday per-user digest at 07:30.
  await wakeupsQueue().add(
    "monday-digest",
    {},
    { repeat: { pattern: "30 7 * * 1" }, jobId: "monday-digest" },
  );
  // Monthly inactivity anonymization sweep — 1st of month at 03:00 (spec §10).
  await wakeupsQueue().add(
    "monthly-anonymize",
    {},
    { repeat: { pattern: "0 3 1 * *" }, jobId: "monthly-anonymize" },
  );
  // Daily cold-email send sweep — 09:00, gated + capped (spec §4.16).
  await wakeupsQueue().add(
    "cold-send",
    {},
    { repeat: { pattern: "0 9 * * *" }, jobId: "cold-send" },
  );
  // Daily invoice payment-status poll — 05:00 (spec §4.23).
  await wakeupsQueue().add(
    "invoice-poll",
    {},
    { repeat: { pattern: "0 5 * * *" }, jobId: "invoice-poll" },
  );
  // Quarterly win/loss digest — 08:00 on the 1st of Jan/Apr/Jul/Oct.
  await wakeupsQueue().add(
    "quarterly-winloss",
    {},
    { repeat: { pattern: "0 8 1 1,4,7,10 *" }, jobId: "quarterly-winloss" },
  );
  // Workflow "task overdue by N days" — 07:30 daily. Once a day rather than on
  // the minute the clock passes: a rule that fired at 17:00:01 is nobody's idea
  // of "overdue by two days" (P7/5).
  await wakeupsQueue().add(
    "workflow-overdue",
    {},
    { repeat: { pattern: "30 7 * * *" }, jobId: "workflow-overdue" },
  );
  // Quarterly stage-probability recalibration — 08:30 on the 1st of the
  // quarter, half an hour after the win/loss digest so the two do not compete
  // for the same rows. Deterministic: no Claude call, no budget cost (P4/c).
  await wakeupsQueue().add(
    "quarterly-stage-probability",
    {},
    { repeat: { pattern: "30 8 1 1,4,7,10 *" }, jobId: "quarterly-stage-probability" },
  );
  // Signal Engine — weekly, Monday 07:00 (one Sonnet call/workspace).
  await wakeupsQueue().add(
    "signal-weekly",
    {},
    { repeat: { pattern: "0 7 * * 1" }, jobId: "signal-weekly" },
  );
  // Mailbox sync every two minutes (playbook-v2 P2b). Each pass is bounded and
  // skips mailboxes that need reconnecting, so a stuck account cannot make the
  // sweep run long.
  await wakeupsQueue().add(
    "mail-sync",
    {},
    { repeat: { pattern: "*/2 * * * *" }, jobId: "mail-sync" },
  );
  // Raw access logs are personal data: sweep anything past its 7-day window
  // daily at 03:30, as the backstop for an upload whose job never ran (P2/8).
  await wakeupsQueue().add(
    "log-retention",
    {},
    { repeat: { pattern: "30 3 * * *" }, jobId: "log-retention" },
  );
  // Weekly keyword positions — Tuesday 05:00. Dormant without a provider key,
  // and every query is billed, so this is the one sweep that costs money per
  // row rather than per run (P2/7).
  await wakeupsQueue().add(
    "keyword-tracking",
    {},
    { repeat: { pattern: "0 5 * * 2" }, jobId: "keyword-tracking" },
  );
  // Daily re-audit sweep — 04:00, before the working day, so a worsening
  // signal is on the lead by the time anyone opens the queue (P2/5).
  await wakeupsQueue().add(
    "audit-watch",
    {},
    { repeat: { pattern: "0 4 * * *" }, jobId: "audit-watch" },
  );
  // Daily insight — 06:30, rotates over the weekly digest (one Haiku call/day).
  await wakeupsQueue().add(
    "daily-insight",
    {},
    { repeat: { pattern: "30 6 * * *" }, jobId: "daily-insight" },
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[worker] fatal", err);
  process.exit(1);
});
