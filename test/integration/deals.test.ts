import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import {
  convertLeadIn,
  createDealIn,
  moveStageIn,
} from "../../src/modules/deals/mutations";
import { applyDealInlineEdit } from "../../src/modules/deals/inline";
import {
  dealChipsForLeads,
  ensurePipelines,
  listPipelines,
  loadPipelineBoard,
  loadForecastDeals,
} from "../../src/modules/deals/store";
import { buildForecast } from "../../src/modules/deals/logic";

/**
 * The deals layer against the real database (playbook-v2 P4/b).
 *
 * What matters here is what a mutation can REACH: the conversion gate, a stage
 * id borrowed from another pipeline, and a deal id from another workspace.
 */
const NAMES = ["Deals Alpha", "Deals Bravo"];
let wsA = "";
let wsB = "";
let companyA = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  await prismaUnsafe.activity.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.document.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.deal.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.dealStage.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.pipeline.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.company.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
});

afterAll(clean);

beforeEach(async () => {
  const ids = [wsA, wsB];
  await prismaUnsafe.activity.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.document.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.deal.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.dealStage.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.pipeline.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.company.deleteMany({ where: { workspaceId: { in: ids } } });
  companyA = (
    await prismaUnsafe.company.create({ data: { workspaceId: wsA, name: "Danubia Kft" } })
  ).id;
});

const db = () => getWorkspaceClient(wsA);

async function lead(stage: string, over: Record<string, unknown> = {}) {
  return prismaUnsafe.lead.create({
    data: {
      workspaceId: wsA,
      companyId: companyA,
      contactName: "Kovács Anna",
      stage: stage as never,
      ...over,
    },
  });
}

async function stagesOf(key: string) {
  const pipelines = await ensurePipelines(wsA);
  const p = pipelines.find((x) => x.key === key)!;
  return { pipeline: p, stages: p.stages };
}

describe("provisioning", () => {
  it("creates both pipelines with their stages, and is idempotent", async () => {
    const first = await ensurePipelines(wsA);
    expect(first.map((p) => p.key).sort()).toEqual(["grants", "web-projects"]);
    expect(first.find((p) => p.key === "web-projects")!.stages).toHaveLength(7);

    const second = await ensurePipelines(wsA);
    expect(second).toHaveLength(2);
    expect(await db().pipeline.count()).toBe(2);
  });

  it("leaves a workspace's own tuning alone on a re-run", async () => {
    const { stages } = await stagesOf("web-projects");
    await db().dealStage.update({
      where: { id: stages[0].id },
      data: { name: "Sifted", probability: 33 },
    });

    await ensurePipelines(wsA);
    const after = await db().dealStage.findUniqueOrThrow({ where: { id: stages[0].id } });
    expect(after.name).toBe("Sifted");
    expect(after.probability).toBe(33);
  });

  it("does not provision another workspace", async () => {
    await ensurePipelines(wsA);
    expect(await prismaUnsafe.pipeline.count({ where: { workspaceId: wsB } })).toBe(0);
  });
});

describe("converting a lead", () => {
  it("refuses a lead that has not reached the money journey", async () => {
    const l = await lead("RESEARCHED");
    const res = await convertLeadIn(wsA, { leadId: l.id });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Only a qualified lead/);
    expect(await db().deal.count()).toBe(0);
  });

  it("creates a deal pre-filled from the lead and its newest quote", async () => {
    const l = await lead("QUALIFIED", { ownerId: "user-7" });
    await prismaUnsafe.document.create({
      data: {
        workspaceId: wsA,
        leadId: l.id,
        type: "QUOTE",
        totals: { net: 1_250_000, vat: 337_500, gross: 1_587_500 },
      },
    });

    const res = await convertLeadIn(wsA, { leadId: l.id });
    expect(res.ok).toBe(true);
    const deal = await db().deal.findFirstOrThrow();
    expect(deal.value).toBe(1_250_000);
    expect(deal.ownerId).toBe("user-7");
    expect(deal.companyId).toBe(companyA);
    expect(deal.title).toContain("Danubia Kft");
  });

  it("logs the conversion on the lead's timeline", async () => {
    const l = await lead("MEETING_BOOKED");
    await convertLeadIn(wsA, { leadId: l.id });
    const activity = await db().activity.findFirstOrThrow({ where: { leadId: l.id } });
    expect(activity.type).toBe("deal_created");
  });

  it("cannot convert a lead from another workspace", async () => {
    const otherCompany = await prismaUnsafe.company.create({
      data: { workspaceId: wsB, name: "Bravo Kft" },
    });
    const other = await prismaUnsafe.lead.create({
      data: {
        workspaceId: wsB,
        companyId: otherCompany.id,
        contactName: "Other",
        stage: "QUALIFIED",
      },
    });
    const res = await convertLeadIn(wsA, { leadId: other.id });
    expect(res.ok).toBe(false);
    expect(await prismaUnsafe.deal.count({ where: { workspaceId: wsB } })).toBe(0);
  });
});

describe("moving a deal", () => {
  it("refuses a stage that belongs to a different pipeline", async () => {
    const { pipeline: web } = await stagesOf("web-projects");
    const { stages: grantStages } = await stagesOf("grants");
    const created = await createDealIn(wsA, null, {
      title: "Cross-board",
      pipelineId: web.id,
      value: 100,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const res = await moveStageIn(wsA, null, created.dealId, grantStages[1].id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/different pipeline/);
  });

  it("closes the deal when it lands on a terminal stage, and reopens it on the way out", async () => {
    const { pipeline, stages } = await stagesOf("web-projects");
    const won = stages.find((s) => s.kind === "won")!;
    const open = stages.find((s) => s.kind === "open")!;
    const created = await createDealIn(wsA, null, {
      title: "Closer",
      pipelineId: pipeline.id,
      value: 500,
    });
    if (!created.ok) throw new Error("setup failed");

    await moveStageIn(wsA, null, created.dealId, won.id);
    let deal = await db().deal.findUniqueOrThrow({ where: { id: created.dealId } });
    expect(deal.status).toBe("WON");
    expect(deal.closedAt).not.toBeNull();

    await moveStageIn(wsA, null, created.dealId, open.id);
    deal = await db().deal.findUniqueOrThrow({ where: { id: created.dealId } });
    expect(deal.status).toBe("OPEN");
    expect(deal.closedAt).toBeNull();
  });

  it("requires a reason to mark a deal lost", async () => {
    const { pipeline, stages } = await stagesOf("web-projects");
    const lost = stages.find((s) => s.kind === "lost")!;
    const created = await createDealIn(wsA, null, { title: "Loser", pipelineId: pipeline.id });
    if (!created.ok) throw new Error("setup failed");

    const refused = await moveStageIn(wsA, null, created.dealId, lost.id);
    expect(refused.ok).toBe(false);

    const ok = await moveStageIn(wsA, null, created.dealId, lost.id, { lostReason: "price" });
    expect(ok.ok).toBe(true);
    const deal = await db().deal.findUniqueOrThrow({ where: { id: created.dealId } });
    expect(deal.status).toBe("LOST");
    expect(deal.lostReason).toBe("price");
  });

  it("cannot move a deal in another workspace", async () => {
    const bStages = await ensurePipelines(wsB);
    const bPipeline = bStages[0];
    const bDeal = await prismaUnsafe.deal.create({
      data: {
        workspaceId: wsB,
        title: "Theirs",
        pipelineId: bPipeline.id,
        stageId: bPipeline.stages[0].id,
      },
    });
    const res = await moveStageIn(wsA, null, bDeal.id, bPipeline.stages[1].id);
    expect(res.ok).toBe(false);
    const after = await prismaUnsafe.deal.findUniqueOrThrow({ where: { id: bDeal.id } });
    expect(after.stageId).toBe(bPipeline.stages[0].id);
  });
});

describe("editing a deal", () => {
  it("clears the probability override back to the stage default", async () => {
    const { pipeline, stages } = await stagesOf("web-projects");
    const created = await createDealIn(wsA, null, {
      title: "Weighted",
      pipelineId: pipeline.id,
      stageId: stages[0].id,
      value: 1_000_000,
    });
    if (!created.ok) throw new Error("setup failed");

    await applyDealInlineEdit(wsA, null, {
      dealId: created.dealId,
      field: "probability",
      value: 90,
    });
    let cards = await loadPipelineBoard(wsA, pipeline.id);
    expect(cards[0].probability).toBe(90);
    expect(cards[0].inheritedProbability).toBe(false);

    await applyDealInlineEdit(wsA, null, {
      dealId: created.dealId,
      field: "probability",
      value: null,
    });
    cards = await loadPipelineBoard(wsA, pipeline.id);
    expect(cards[0].probability).toBe(stages[0].probability);
    expect(cards[0].inheritedProbability).toBe(true);
  });

  it("refuses a probability outside 0-100", async () => {
    const created = await createDealIn(wsA, null, { title: "Silly" });
    if (!created.ok) throw new Error("setup failed");
    const res = await applyDealInlineEdit(wsA, null, {
      dealId: created.dealId,
      field: "probability",
      value: 140,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/0 to 100/);
  });
});

describe("board and forecast reads", () => {
  it("shows the document chain and the deal chip on the lead", async () => {
    const l = await lead("QUALIFIED");
    const converted = await convertLeadIn(wsA, { leadId: l.id });
    if (!converted.ok) throw new Error("setup failed");

    await prismaUnsafe.document.create({
      data: {
        workspaceId: wsA,
        leadId: l.id,
        dealId: converted.dealId,
        type: "QUOTE",
      },
    });

    const pipelines = await listPipelines(db());
    const web = pipelines.find((p) => p.key === "web-projects")!;
    const cards = await loadPipelineBoard(wsA, web.id);
    expect(cards[0].chainTypes).toEqual(["QUOTE"]);

    const chips = await dealChipsForLeads(wsA, [l.id]);
    expect(chips.get(l.id)?.dealId).toBe(converted.dealId);
  });

  it("feeds a forecast whose numbers match a hand-checked fixture", async () => {
    const { pipeline, stages } = await stagesOf("web-projects");
    const qualified = stages.find((s) => s.key === "qualified")!; // 20%
    const negotiation = stages.find((s) => s.key === "negotiation")!; // 75%

    const a = await createDealIn(wsA, null, {
      title: "A",
      pipelineId: pipeline.id,
      stageId: qualified.id,
      value: 1_000_000,
      expectedCloseAt: "2026-09-10",
    });
    const b = await createDealIn(wsA, null, {
      title: "B",
      pipelineId: pipeline.id,
      stageId: negotiation.id,
      value: 2_000_000,
      expectedCloseAt: "2026-09-25",
    });
    if (!a.ok || !b.ok) throw new Error("setup failed");

    const deals = await loadForecastDeals(wsA);
    const forecast = buildForecast(deals);
    const sep = forecast.rows.find((r) => r.month === "2026-09")!;
    // 1,000,000 × 0.20 + 2,000,000 × 0.75 = 200,000 + 1,500,000
    expect(sep.weighted).toBe(1_700_000);
    expect(sep.commit).toBe(1_500_000);
    expect(sep.upside).toBe(200_000);
  });
});
