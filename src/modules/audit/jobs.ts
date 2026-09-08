import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspaceClient, prismaUnsafe } from "../../lib/db";
import { callClaude } from "../../lib/ai/call-claude";
import { renderHtmlToPdf } from "../../lib/pdf";
import { buildAuditPdfHtml, type InlineShots } from "./pdf-template";
import { auditRowToView } from "./view";
import { AUDIT_SCHEMA_VERSION } from "./categories";
import {
  AUDIT_PITCH_SYSTEM,
  buildAuditPitchMessage,
} from "../../lib/ai/prompts/audit-pitch";
import { computeIcpScore, type IcpBreakdown } from "../leads/scoring";
import {
  probeSite,
  captureScreenshots,
  probePagesDeep,
  createRenderedFetcher,
} from "./probe";
import { AuditUnreachableError, failureMessage } from "./failure";
import { crawlSite } from "./crawl";
import { analyzeStructure } from "./structure";
import {
  detectFramework,
  jsDependencyPercent,
  crawlModeFor,
  JS_DEPENDENCY_THRESHOLD,
  RENDERED_CRAWL_CAP,
  RENDERED_PAGE_TIMEOUT_MS,
} from "./framework";
import { fetchPsi } from "./psi";
import { fetchCrux } from "./crux";
import { loadComparison } from "./comparison-load";
import { computeDelta, signalFor } from "./delta";
import { nextRunFrom } from "./watch";
import { createTaskFromSignal } from "../tasks/from-signal";
import { brandFrom } from "../workspaces/brand";
import { usageRecorderFor } from "@/lib/api-usage";
import { shareOfTopTen } from "../serp/provider";
import { resolveIntegration } from "@/modules/integrations/resolve";
import { analyzeAudit } from "./analyze";
import { auditThresholdsFromConfig } from "./config";
import { enqueueAudit, type AuditJobData, type PdfJobData } from "./enqueue";
import type { AuditCheck } from "./types";
import type { AuditStage } from "./stages";

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

type WorkspaceDb = ReturnType<typeof getWorkspaceClient>;

/** Audit flags attach to the lead as trigger signals and feed the ICP score (§4.4). */
async function attachFlagsToLead(
  db: WorkspaceDb,
  leadId: string,
  flags: string[],
): Promise<void> {
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { signals: true, scoreBreakdown: true },
  });
  if (!lead) return;

  const current = Array.isArray(lead.signals) ? (lead.signals as string[]) : [];
  const signals = Array.from(new Set([...current, ...flags]));
  const data: { signals: string[]; scoreBreakdown?: IcpBreakdown; icpScore?: number } = {
    signals,
  };

  if (
    flags.length &&
    lead.scoreBreakdown &&
    typeof lead.scoreBreakdown === "object" &&
    !Array.isArray(lead.scoreBreakdown)
  ) {
    const breakdown = {
      ...(lead.scoreBreakdown as unknown as IcpBreakdown),
      trigger_signal: 1 as const,
    };
    data.scoreBreakdown = breakdown;
    data.icpScore = computeIcpScore(breakdown);
  }

  await db.lead.update({ where: { id: leadId }, data });
}

/**
 * Compare this run with the previous audit of the same URL (P2/5).
 *
 * A first audit has no delta — and that is not a delta of zero, so the column
 * stays null and the trend strip renders nothing rather than "unchanged".
 *
 * A SIGNIFICANT move becomes a lead activity and a trigger signal. Worse means
 * something broke and they may not know; better means someone else is probably
 * working on the site, which is a competitive warning rather than good news.
 * Both are recorded, neither contacts anyone: no automated outreach, ever.
 */
async function recordDelta(
  db: WorkspaceDb,
  data: AuditJobData,
  current: { score: number; checks: AuditCheck[] },
): Promise<void> {
  try {
    const previous = await db.auditResult.findFirst({
      where: {
        url: data.url,
        status: "done",
        id: { not: data.auditId },
        // Only compare like with like: an audit scored under an older check
        // set would report changes we made, not changes they made.
        schemaVersion: AUDIT_SCHEMA_VERSION,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, score: true, checks: true },
    });
    if (!previous) return;

    const delta = computeDelta(
      {
        id: previous.id,
        createdAt: previous.createdAt,
        score: previous.score,
        checks: Array.isArray(previous.checks) ? (previous.checks as unknown as AuditCheck[]) : [],
      },
      current,
    );
    await db.auditResult.update({
      where: { id: data.auditId },
      data: { delta: delta as unknown as object },
    });

    const signal = signalFor(delta, data.url.replace(/^https?:\/\//, ""));
    if (!signal) return;

    // Tasks and the notification centre do not exist yet (P3/P6). The signal
    // lands where the operator already looks — the lead timeline — carrying
    // the suggested task text, so adopting it later is a read of one field
    // rather than a second parallel system to unpick.
    const leadId =
      data.leadId ??
      (
        await db.lead.findFirst({
          where: { company: { audits: { some: { id: data.auditId } } } },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        })
      )?.id;
    if (!leadId) return;

    await db.activity.create({
      data: {
        workspaceId: data.workspaceId,
        leadId,
        type: signal.type,
        payload: {
          auditId: data.auditId,
          previousAuditId: delta.previousAuditId,
          scoreFrom: delta.scoreFrom,
          scoreTo: delta.scoreTo,
          headline: signal.headlineHu,
          suggestedTask: signal.suggestedTaskHu,
        },
      },
    });
    await attachFlagsToLead(db, leadId, [signal.flag]);

    // The suggested task the signal has been carrying since P2/5 now exists as
    // a real task instead of a string in a payload nothing rendered.
    await createTaskFromSignal(db, {
      workspaceId: data.workspaceId,
      title: signal.suggestedTaskHu,
      note: signal.headlineHu,
      type: "call",
      entityType: "lead",
      entityId: leadId,
      source: signal.type,
      // A worsening site is a same-day call; an improving one is more urgent
      // still, because somebody else may already be talking to them.
      dueInDays: signal.type === "audit_improved" ? 0 : 1,
    });
  } catch {
    // A delta is an extra: never fail a completed audit over it.
  }
}

/**
 * The whole-run ceiling.
 *
 * Every individual step is bounded now, but "bounded" multiplied by enough
 * steps is still unbounded, and a job that never returns is worse than one
 * that fails: BullMQ has no default timeout, the audit queue runs at a
 * concurrency of two, and two stuck jobs mean every subsequent audit in the
 * workspace sits at `queued` forever with nothing anywhere saying why. Five
 * minutes is comfortably above a rendered crawl's own three-minute cap and
 * far below "the operator has given up and reloaded".
 */
export const AUDIT_DEADLINE_MS = 5 * 60_000;

/**
 * Resolve with the work, or with `fallback` when the budget runs out.
 *
 * The losing promise is abandoned, not cancelled — Playwright will close its
 * browser when the context is disposed. The point is that the JOB returns:
 * a step that hangs must cost the audit that step, not the queue.
 */
async function withBudget<T>(
  work: Promise<T>,
  budgetMs: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), Math.max(1, budgetMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Worker processor: probe → analyze → persist in stages (progressive results),
 * PSI, screenshots, optional Haiku pitch, then attach flags to the lead.
 *
 * ── PROGRESS ────────────────────────────────────────────────────────────────
 *
 * Each step writes `stage` before it starts. The runner used to infer the step
 * from `status`, which only ever held `running` — so its three-step bar could
 * physically never reach step three, and every audit looked stuck at 2 of 3
 * before going silent. See ./stages.
 */
export async function processAudit(data: AuditJobData): Promise<void> {
  const db = getWorkspaceClient(data.workspaceId);
  const deadline = Date.now() + AUDIT_DEADLINE_MS;
  const timeLeft = () => Math.max(0, deadline - Date.now());

  /** Record the step we are about to take. Never worth failing a run over. */
  const setStage = async (stage: AuditStage): Promise<void> => {
    await db.auditResult
      .update({ where: { id: data.auditId }, data: { stage } })
      .catch(() => {});
  };

  try {
    await db.auditResult.update({
      where: { id: data.auditId },
      data: { status: "running", stage: "loading", errorMessage: null },
    });

    const ws = await prismaUnsafe.workspace.findUnique({
      where: { id: data.workspaceId },
      select: { auditConfig: true },
    });
    const thresholds = auditThresholdsFromConfig(ws?.auditConfig);

    // Stage 1 — deterministic checks (fast; write partial result).
    const probe = await probeSite(data.url);
    let analysis = analyzeAudit(probe, thresholds);
    await db.auditResult.update({
      where: { id: data.auditId },
      data: {
        status: "running",
        score: analysis.score,
        verdict: analysis.verdict,
        checks: analysis.checks,
        flags: analysis.flags,
      },
    });

    // Stage 1b — multi-page crawl (P2/1), internal runs only.
    //
    // Its checks are appended to the single-page ones and its two flags join
    // the lead's trigger signals, but they deliberately do NOT move the score:
    // a crawled and an uncrawled audit of the same site must stay comparable,
    // or the re-audit delta would report a site "getting worse" when all that
    // changed was the toggle. That now happens by construction rather than by
    // arithmetic — the structure category simply is not present in the
    // analysis, so `overallFromCategories` leaves it out of the divisor.
    let extraChecks: AuditCheck[] = [];
    let extraFlags: string[] = [];

    // ---- P2/9: does this site need a browser to be crawled at all? --------
    // Decided from the homepage we have already loaded, so the detection costs
    // nothing: framework markers plus how much text is missing from the HTML.
    // Markers alone cannot tell a server-rendered Next page (fine) from a
    // client-rendered SPA (the finding), which is why both are used.
    //
    // The FINDING itself is emitted by `analyzeAudit` now, and therefore
    // scored; what is still decided here is only the crawl MODE, which is a
    // worker concern.
    const detection = detectFramework(probe.rawHtml ?? "");
    const jsDependency = jsDependencyPercent(probe.rawHtml ?? "", probe.renderedTextLength ?? 0);
    const mode = crawlModeFor(detection, jsDependency);
    if (jsDependency >= JS_DEPENDENCY_THRESHOLD) extraFlags = ["JS-only content"];

    if (data.crawl) {
      await setStage("crawling");
      let renderer: Awaited<ReturnType<typeof createRenderedFetcher>> | null = null;
      try {
        // Rendered crawling is roughly ten times the cost, so it is capped
        // harder and only entered when the static crawl would have read empty
        // pages anyway.
        if (mode === "rendered") {
          renderer = await createRenderedFetcher(RENDERED_PAGE_TIMEOUT_MS);
        }
        const crawl = await crawlSite(data.url, {
          cap: mode === "rendered" ? Math.min(data.crawl.cap, RENDERED_CRAWL_CAP) : data.crawl.cap,
          ...(renderer ? { renderPage: renderer.render } : {}),
        });

        // The deep checks are the expensive half, so they run on the homepage
        // (already probed above) plus the two heaviest crawled pages only.
        const heaviest = crawl.pages
          .filter((p) => p.status !== null && p.status < 400 && p.url !== crawl.startUrl)
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 2)
          .map((p) => p.url);
        if (heaviest.length > 0) {
          // 10s each, so the two of them cannot push the audit past its budget.
          const deep = await probePagesDeep(heaviest, 10_000);
          for (const page of crawl.pages) {
            if (deep[page.url]) page.deep = deep[page.url];
          }
        }

        const structure = analyzeStructure(crawl);
        extraChecks = [...extraChecks, ...structure.checks];
        extraFlags = [...new Set([...extraFlags, ...structure.flags])];
        await db.auditResult.update({
          where: { id: data.auditId },
          data: {
            crawl: crawl as unknown as object,
            checks: [...analysis.checks, ...extraChecks],
            flags: [...new Set([...analysis.flags, ...extraFlags])],
          },
        });
      } catch {
        // A crawl that dies must not cost the audit its single-page result.
      } finally {
        await renderer?.close();
      }
    }

    // Stage 2 — PageSpeed Insights (lab) and Chrome UX Report (field).
    //
    // Both are Google, both are free, and they answer different questions:
    // PSI is one synthetic load, CrUX is what real Chrome users lived through.
    // They run together because neither depends on the other, and CrUX is
    // stored separately because it does not feed the score (see crux.ts).
    await setStage("pagespeed");
    try {
      const psiKey = await resolveIntegration(data.workspaceId, "google.pagespeedApiKey");
      // The CrUX key is optional: the same project usually serves both, so an
      // unset override falls back to the PageSpeed key rather than disabling
      // the feature.
      const cruxKey =
        (await resolveIntegration(data.workspaceId, "google.cruxApiKey")) ?? psiKey;

      // Guarded independently: a PageSpeed outage must not also cost us the
      // field data, and vice versa.
      const [psi, crux] = await Promise.all([
        fetchPsi(
          probe.finalUrl,
          psiKey,
          usageRecorderFor(data.workspaceId, "pagespeed", "audit"),
        ).catch((e: unknown) => ({
          scores: null,
          reason: "network" as const,
          detail: failureMessage(e),
        })),
        fetchCrux(
          probe.finalUrl,
          cruxKey,
          fetch,
          usageRecorderFor(data.workspaceId, "crux", "audit"),
        ).catch(() => null),
      ]);
      probe.psi = psi.scores;
      // Carried into the analysis so a missing measurement appears in the
      // report as a stated absence rather than as three rows that quietly
      // are not there.
      if (!psi.scores && psi.detail) probe.psiUnavailable = psi.detail;
      if (crux) {
        await db.auditResult.update({
          where: { id: data.auditId },
          data: { crux: crux as unknown as object },
        });
      }
      analysis = analyzeAudit(probe, thresholds);
      await db.auditResult.update({
        where: { id: data.auditId },
        data: {
          score: analysis.score,
          verdict: analysis.verdict,
          // Re-scoring from the probe rebuilds the check list from scratch, so
          // the appended findings have to be folded back in — otherwise the
          // PSI stage quietly erases the whole Site structure category and the
          // JS-dependency finding with it.
          checks: [...analysis.checks, ...extraChecks],
          flags: [...new Set([...analysis.flags, ...extraFlags])],
        },
      });
    } catch {
      /* PSI is optional; keep deterministic result */
    }

    // Stage 3 — screenshots to the files volume.
    //
    // Bounded by what is left of the run's budget rather than by its own
    // timeouts alone: two captures of a slow site are the likeliest place for
    // an audit to spend minutes it does not have, and a report without
    // pictures beats a report that never arrives.
    await setStage("screenshots");
    try {
      const screenshots = await withBudget(
        captureScreenshots(data.url, data.auditId),
        Math.min(timeLeft(), 90_000),
        {} as { desktop?: string; mobile?: string },
      );
      if (screenshots.desktop || screenshots.mobile) {
        await db.auditResult.update({
          where: { id: data.auditId },
          data: { screenshots },
        });
      }
    } catch {
      /* screenshots best-effort */
    }

    // Stage 4 — optional Haiku pitch (behind the toggle).
    if (data.withPitch) {
      await setStage("pitch");
      try {
        const { data: pitch } = await callClaude({
          useCase: "audit_summary",
          workspaceId: data.workspaceId,
          system: AUDIT_PITCH_SYSTEM,
          messages: [
            { role: "user", content: buildAuditPitchMessage(probe.finalUrl, analysis) },
          ],
        });
        await db.auditResult.update({
          where: { id: data.auditId },
          data: { pitchSummary: pitch as string },
        });
      } catch {
        /* pitch best-effort (budget cap etc.) */
      }
    }

    await setStage("finishing");

    // Stage 5 — flags → lead trigger signals.
    if (data.leadId) {
      await attachFlagsToLead(db, data.leadId, [
        ...new Set([...analysis.flags, ...extraFlags]),
      ]);
    }

    await db.auditResult.update({
      where: { id: data.auditId },
      // Stamp the check set this run was scored under, so the report can
      // render an older cached audit the way it was actually scored (P1/3d).
      data: {
        status: "done",
        stage: null,
        errorMessage: null,
        schemaVersion: AUDIT_SCHEMA_VERSION,
      },
    });

    // Stage 6 — what changed since last time (P2/5).
    await recordDelta(db, data, {
      score: analysis.score,
      checks: [...analysis.checks, ...extraChecks],
    });
  } catch (e) {
    // The reason goes on the row, not only into the worker log. A failed audit
    // used to render as the single word "failed", which is exactly as useful
    // as a spinner that never stops — and told the operator nothing about
    // whether to retry, fix the URL, or give up on the prospect.
    await db.auditResult
      .update({
        where: { id: data.auditId },
        data: { status: "error", stage: null, errorMessage: failureMessage(e) },
      })
      .catch(() => {});
    // An unreachable site is a fact about the site, not a bug in the worker.
    // Rethrowing it only fills the log with stack traces and makes BullMQ
    // retry something that will fail identically.
    if (e instanceof AuditUnreachableError) return;
    throw e;
  }
}

/**
 * Daily sweep: re-audit every watch that has come due (P2/5).
 *
 * Deliberately dumb about pacing beyond the due date — the audit queue's own
 * concurrency of 2 is what stops fifty due watches from becoming fifty
 * simultaneous browsers, and the weekly-load projection in Settings is what
 * stops fifty watches from existing in the first place.
 *
 * Returns how many were queued, for the worker log.
 */
export async function processAuditWatchSweep(now: Date = new Date()): Promise<number> {
  const due = await prismaUnsafe.auditWatch.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    include: { company: { select: { id: true, leads: { select: { id: true }, take: 1 } } } },
    take: 200,
  });

  let queued = 0;
  for (const watch of due) {
    const db = getWorkspaceClient(watch.workspaceId);
    try {
      const rec = await db.auditResult.create({
        data: {
          workspaceId: watch.workspaceId,
          companyId: watch.companyId,
          url: watch.url,
          status: "queued",
          score: 0,
          verdict: "SKIP",
          flags: [],
          screenshots: {},
          expiresAt: new Date(now.getTime() + 30 * 86_400_000),
        },
      });
      await enqueueAudit({
        auditId: rec.id,
        workspaceId: watch.workspaceId,
        url: watch.url,
        leadId: watch.company.leads[0]?.id,
        withPitch: false,
      });
      queued += 1;
    } finally {
      // Reschedule even if the enqueue failed: a watch that cannot run must
      // not spin every minute for the rest of its life.
      await prismaUnsafe.auditWatch.update({
        where: { id: watch.id },
        data: { lastRunAt: now, nextRunAt: nextRunFrom(now, watch.frequencyDays) },
      });
    }
  }
  return queued;
}

/** Worker processor: render the branded audit one-pager to PDF via headless Chrome. */
export async function processPdfRender(data: PdfJobData): Promise<void> {
  const db = getWorkspaceClient(data.workspaceId);
  const a = await db.auditResult.findUnique({ where: { id: data.auditId } });
  if (!a) return;

  // Inline the screenshots: headless Chrome renders this HTML with no session,
  // so an /api/files URL would come out as two broken boxes (P1/3a).
  const view = auditRowToView(a);
  const shots: InlineShots = {};
  for (const kind of ["desktop", "mobile"] as const) {
    const rel = view.screenshots[kind];
    if (!rel) continue;
    try {
      const bytes = await readFile(join(FILES_DIR, rel));
      shots[kind] = `data:image/png;base64,${bytes.toString("base64")}`;
    } catch {
      // A missing capture must not fail the whole PDF.
    }
  }
  // The sales PDF names competitors; the public page never does (P2/3).
  const comparison = await loadComparison(db, {
    id: a.id,
    url: a.url,
    status: a.status,
    score: a.score,
    checks: a.checks,
    comparison: a.comparison,
  });
  // Whose report this is (P2/6). Headless Chrome has no session, so a logo
  // living behind /api/files is inlined for exactly the reason the screenshots
  // are — otherwise the letterhead prints as a broken box.
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: data.workspaceId },
    select: { brand: true },
  });
  const brand = brandFrom(ws?.brand);
  if (brand.logoUrl && !brand.logoUrl.startsWith("data:")) {
    try {
      const rel = brand.logoUrl.replace(/^\/api\/files\//, "");
      const bytes = await readFile(join(FILES_DIR, rel));
      const ext = rel.split(".").pop()?.toLowerCase();
      const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
      brand.logoUrl = `data:${mime};base64,${bytes.toString("base64")}`;
    } catch {
      // A logo we cannot read is not worth failing a PDF over; the wordmark
      // takes over.
      brand.logoUrl = null;
    }
  }
  // Search visibility (P2/7): only when there is something measured to say.
  let visibility: { tracked: number; inTopTen: number; shareOfTopTen: number } | null = null;
  if (a.companyId) {
    const tracked = await db.trackedKeyword.findMany({
      where: { companyId: a.companyId, enabled: true },
      include: { positions: { orderBy: { checkedAt: "desc" }, take: 1 } },
    });
    const measured = tracked.filter((k) => k.positions.length > 0);
    if (measured.length > 0) {
      const positions = measured.map((k) => k.positions[0]!.position);
      visibility = {
        tracked: measured.length,
        inTopTen: positions.filter((p) => p !== null && p <= 10).length,
        shareOfTopTen: shareOfTopTen(positions),
      };
    }
  }
  const html = buildAuditPdfHtml(view, { shots, comparison, brand, visibility });
  const pdf = await renderHtmlToPdf(html);

  const rel = `audits/${data.auditId}.pdf`;
  await mkdir(join(FILES_DIR, "audits"), { recursive: true });
  await writeFile(join(FILES_DIR, rel), pdf);

  await db.auditResult.update({
    where: { id: data.auditId },
    data: { pdfPath: rel },
  });
}
