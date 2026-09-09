import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { PipelineBoardSkeleton } from "@/components/skeletons";
import { PipelineBoard, type PipelineCard } from "@/components/pipeline-board";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { daysInStage } from "@/modules/pipeline/schedule";
import { PIPELINE_STAGES, SIDE_STAGES } from "@/modules/pipeline/transitions";
import { dealChipsForLeads } from "@/modules/deals/store";

export const dynamic = "force-dynamic";

/** Cards per column before "load more". Two screens' worth on a laptop. */
const STAGE_PAGE_SIZE = 25;

const ALL_STAGE_KEYS = [...PIPELINE_STAGES, ...SIDE_STAGES];

export default function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ per?: string }>;
}) {
  return (
    <AppShell activePath="/pipeline">
      <Suspense fallback={<PipelineBoardSkeleton />}>
        <PipelineBody searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}

async function PipelineBody({
  searchParams,
}: {
  searchParams: Promise<{ per?: string }>;
}) {
  const { per: showAll } = await searchParams;
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  // A column shows the OLDEST cards in its stage — the ones that have sat
  // longest are the ones worth looking at — and stops at the cap, with the
  // remainder behind "load more" (P6/3). Before this, the board fetched every
  // lead in the workspace and painted 5,000 cards nobody scrolled to.
  const perStage = Math.max(1, Math.min(400, Number(showAll) || STAGE_PAGE_SIZE));

  const counts = await db.lead.groupBy({
    by: ["stage"],
    where: { mergedIntoId: null },
    _count: { _all: true },
  });
  const totalByStage = new Map(counts.map((c) => [c.stage as string, c._count._all]));

  const leadsByStage = await Promise.all(
    ALL_STAGE_KEYS.map((stage) =>
      db.lead.findMany({
        where: { mergedIntoId: null, stage: stage as never },
        orderBy: { stageEnteredAt: "asc" },
        take: perStage,
        include: { company: { select: { name: true } } },
      }),
    ),
  );
  const leads = leadsByStage.flat();

  // Document-chain state per lead (spec §4.9 — chain state on the pipeline card).
  const docs = await db.document.findMany({
    where: { leadId: { in: leads.map((l) => l.id) } },
    select: { id: true, leadId: true, type: true },
  });
  const chainByLead = new Map<string, string[]>();
  const docToLead = new Map<string, string>();
  for (const d of docs) {
    if (!d.leadId) continue;
    docToLead.set(d.id, d.leadId);
    const arr = chainByLead.get(d.leadId) ?? [];
    if (!arr.includes(d.type)) arr.push(d.type);
    chainByLead.set(d.leadId, arr);
  }

  // Invoice status per lead (spec §4.23 — payment status on the pipeline card).
  const invoices = await db.invoice.findMany({
    where: { documentId: { in: docs.map((d) => d.id) } },
    orderBy: { at: "desc" },
    select: { documentId: true, status: true },
  });
  const invoiceByLead = new Map<string, string>();
  for (const inv of invoices) {
    const leadOfDoc = inv.documentId ? docToLead.get(inv.documentId) : undefined;
    if (leadOfDoc && !invoiceByLead.has(leadOfDoc)) invoiceByLead.set(leadOfDoc, inv.status);
  }

  // Latest win/loss outcome per lead (spec §4.20 — closed chip on Handed off).
  const outcomes = await db.dealOutcome.findMany({
    where: { leadId: { in: leads.map((l) => l.id) } },
    orderBy: { at: "desc" },
    select: { leadId: true, result: true },
  });
  const outcomeByLead = new Map<string, string>();
  for (const o of outcomes) if (!outcomeByLead.has(o.leadId)) outcomeByLead.set(o.leadId, o.result);

  // Which leads have crossed into the money journey (P4/b). The card says so
  // and links across, so the split between the two boards is visible on the
  // board itself rather than only in a doc nobody opens.
  const dealChips = await dealChipsForLeads(workspaceId, leads.map((l) => l.id));

  const now = new Date();
  const cards: PipelineCard[] = leads.map((l) => ({
    id: l.id,
    name: l.contactName ?? "Unnamed contact",
    company: l.company?.name ?? "—",
    icpScore: l.icpScore,
    stage: l.stage,
    daysInStage: daysInStage(l.stageEnteredAt, now),
    wakeUpAt: l.wakeUpAt ? l.wakeUpAt.toISOString().slice(0, 10) : null,
    reason: l.stageReason,
    chainTypes: chainByLead.get(l.id) ?? [],
    closedResult: outcomeByLead.get(l.id) ?? null,
    invoiceStatus: invoiceByLead.get(l.id) ?? null,
    deal: dealChips.get(l.id) ?? null,
  }));

  return (
    <>
      <PipelineBoard
        cards={cards}
        totals={Object.fromEntries(totalByStage)}
        shown={perStage}
        pageSize={STAGE_PAGE_SIZE}
      />
    </>
  );
}
