import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { copyWorkspaceSettings } from "../../src/modules/workspaces/copy";
import { COPY_GROUP_KEYS } from "../../src/modules/workspaces/copy-plan";

/**
 * Copying settings between workspaces, against a real database (P6/6.1).
 *
 * This is the one function in the codebase that deliberately reads workspace A
 * and writes workspace B, so it runs on `prismaUnsafe` — no guarded client can
 * do that, correctly. Which makes these tests the only thing standing between
 * "copy the settings" and "copy the customer list".
 */
const SRC = "Copy Source WS";
const DST = "Copy Target WS";
let sourceId = "";
let targetId = "";

async function ensure(name: string): Promise<string> {
  const existing = await prismaUnsafe.workspace.findFirst({ where: { name } });
  const ws = existing ?? (await prismaUnsafe.workspace.create({ data: { name } }));
  return ws.id;
}

async function wipe(id: string) {
  if (!id) return;
  await prismaUnsafe.dealStage.deleteMany({ where: { workspaceId: id } });
  await prismaUnsafe.pipeline.deleteMany({ where: { workspaceId: id } });
  await prismaUnsafe.customFieldDef.deleteMany({ where: { workspaceId: id } });
  await prismaUnsafe.template.deleteMany({ where: { workspaceId: id } });
  await prismaUnsafe.projectTemplate.deleteMany({ where: { workspaceId: id } });
  await prismaUnsafe.workflowRule.deleteMany({ where: { workspaceId: id } });
  await prismaUnsafe.target.deleteMany({ where: { workspaceId: id } });
  await prismaUnsafe.auditLog.deleteMany({ where: { workspaceId: id } });
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId: id } });
  await prismaUnsafe.company.deleteMany({ where: { workspaceId: id } });
}

beforeEach(async () => {
  sourceId = await ensure(SRC);
  targetId = await ensure(DST);
  await wipe(sourceId);
  await wipe(targetId);

  // ---- a source workspace somebody has actually tuned ----
  await prismaUnsafe.workspace.update({
    where: { id: sourceId },
    data: {
      legalName: "Source Kft.",
      brand: { color: "#123456", logoUrl: "/files/brand/src.png" },
      icpConfig: { gateThreshold: 4, criteria: [{ key: "fit", label: "Fit", weight: 1 }] },
      auditConfig: { verdict: { strong: 50, possible: 30 } },
      featureFlags: {
        quoteRules: { validDays: 21 },
        hiddenNav: ["cold", "campaigns"],
        clientHealth: { warnDays: 45 },
        // Not in any group: must not travel.
        security: { require2fa: true },
      },
      claudeBudget: 9,
    },
  });
  await prismaUnsafe.workspace.update({
    where: { id: targetId },
    data: { featureFlags: { retentionDays: 400 }, claudeBudget: 2 },
  });

  await prismaUnsafe.customFieldDef.create({
    data: {
      workspaceId: sourceId,
      entity: "lead",
      key: "sector",
      label: "Szektor",
      type: "SELECT",
      options: [{ value: "hvac", label: "HVAC" }],
      position: 3,
      help: "Melyik iparág",
    },
  });
  const pipeline = await prismaUnsafe.pipeline.create({
    data: {
      workspaceId: sourceId,
      name: "Retainer",
      key: "retainer",
      position: 2,
      isDefault: true,
      stages: {
        create: [
          { workspaceId: sourceId, name: "Beszélgetés", key: "talk", position: 0, probability: 20 },
          { workspaceId: sourceId, name: "Nyert", key: "won", position: 1, kind: "won", probability: 100 },
        ],
      },
    },
    include: { stages: true },
  });
  await prismaUnsafe.template.create({
    data: {
      workspaceId: sourceId,
      type: "QUOTE",
      lang: "HU",
      name: "Retainer ajánlat",
      body: "Kedves {{contact}}",
      variables: ["contact"],
      version: 7,
      status: "ACTIVE",
    },
  });
  await prismaUnsafe.projectTemplate.create({
    data: {
      workspaceId: sourceId,
      name: "Weboldal szállítás",
      milestones: [{ title: "Kick-off", dayOffset: 0, kind: "generic" }],
    },
  });
  await prismaUnsafe.workflowRule.create({
    data: {
      workspaceId: sourceId,
      name: "Kapcsolatba léptünk → task",
      trigger: "lead_stage_changed",
      triggerConfig: { toStage: "CONTACTED" },
      actions: [{ type: "create_task", title: "Hívd fel" }],
      enabled: true,
      version: 5,
    },
  });
  await prismaUnsafe.target.create({
    data: { workspaceId: sourceId, metric: "meetings_booked", period: "monthly", value: 14 },
  });

  // ---- and a lead in the source, which must never travel ----
  const company = await prismaUnsafe.company.create({
    data: { workspaceId: sourceId, name: "Source Client Zrt." },
  });
  await prismaUnsafe.lead.create({
    data: {
      workspaceId: sourceId,
      companyId: company.id,
      contactName: "Nem Utazhat",
      stage: "RESEARCHED",
    },
  });
  void pipeline;
});

afterAll(async () => {
  await wipe(sourceId);
  await wipe(targetId);
  await prismaUnsafe.workspace.deleteMany({ where: { name: { in: [SRC, DST] } } });
});

describe("copying every group", () => {
  it("brings the configuration across", async () => {
    const res = await copyWorkspaceSettings(sourceId, targetId, COPY_GROUP_KEYS);

    const ws = await prismaUnsafe.workspace.findUnique({ where: { id: targetId } });
    expect(ws!.legalName).toBe("Source Kft.");
    expect(ws!.brand).toMatchObject({ color: "#123456" });
    expect(ws!.icpConfig).toMatchObject({ gateThreshold: 4 });
    expect(ws!.auditConfig).toMatchObject({ verdict: { strong: 50, possible: 30 } });

    const flags = ws!.featureFlags as Record<string, unknown>;
    expect(flags.quoteRules).toMatchObject({ validDays: 21 });
    expect(flags.hiddenNav).toEqual(["cold", "campaigns"]);
    expect(flags.clientHealth).toMatchObject({ warnDays: 45 });
    // The target's own flags survived the merge — featureFlags is one shared
    // JSON column and a careless write erases whatever it did not know about.
    expect(flags.retentionDays).toBe(400);
    // Not in any group: the 2FA policy is a security decision per workspace.
    expect(flags.security).toBeUndefined();

    const fields = await prismaUnsafe.customFieldDef.findMany({ where: { workspaceId: targetId } });
    expect(fields).toHaveLength(1);
    // The key never changes — it is the key inside `customFields`.
    expect(fields[0]!.key).toBe("sector");
    expect(fields[0]!.options).toEqual([{ value: "hvac", label: "HVAC" }]);
    expect(fields[0]!.position).toBe(3);

    const pipelines = await prismaUnsafe.pipeline.findMany({
      where: { workspaceId: targetId },
      include: { stages: { orderBy: { position: "asc" } } },
    });
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]!.key).toBe("retainer");
    expect(pipelines[0]!.isDefault).toBe(true);
    expect(pipelines[0]!.stages.map((s) => s.key)).toEqual(["talk", "won"]);
    // The kind travels, or dragging onto "Nyert" stops closing the deal.
    expect(pipelines[0]!.stages[1]!.kind).toBe("won");
    // And the stage rows belong to the TARGET, not the source.
    for (const s of pipelines[0]!.stages) expect(s.workspaceId).toBe(targetId);

    const templates = await prismaUnsafe.template.findMany({ where: { workspaceId: targetId } });
    expect(templates).toHaveLength(1);
    expect(templates[0]!.body).toBe("Kedves {{contact}}");
    // Version restarts: inheriting "7" would claim six edits nobody made here.
    expect(templates[0]!.version).toBe(1);

    const rules = await prismaUnsafe.workflowRule.findMany({ where: { workspaceId: targetId } });
    expect(rules).toHaveLength(1);
    // Copied SWITCHED OFF, always: a rule that arrives armed trips automation
    // nobody has read on the first lead somebody enters.
    expect(rules[0]!.enabled).toBe(false);
    expect(rules[0]!.version).toBe(1);
    expect(rules[0]!.triggerConfig).toMatchObject({ toStage: "CONTACTED" });

    expect(await prismaUnsafe.target.count({ where: { workspaceId: targetId } })).toBe(1);
    expect(
      await prismaUnsafe.projectTemplate.count({ where: { workspaceId: targetId } }),
    ).toBe(1);

    expect(res.counts.fields).toBe(1);
    expect(res.counts.pipelines).toBe(1);
    // The Owner is told the rules arrived disarmed.
    expect(res.skipped.join(" ")).toMatch(/kikapcsolva/);
  });

  it("never brings a lead, a company or an audit log", async () => {
    // The whole safety argument of the feature, asserted rather than described.
    await copyWorkspaceSettings(sourceId, targetId, COPY_GROUP_KEYS);
    expect(await prismaUnsafe.lead.count({ where: { workspaceId: targetId } })).toBe(0);
    expect(await prismaUnsafe.company.count({ where: { workspaceId: targetId } })).toBe(0);
    expect(await prismaUnsafe.document.count({ where: { workspaceId: targetId } })).toBe(0);
    expect(await prismaUnsafe.auditLog.count({ where: { workspaceId: targetId } })).toBe(0);
    expect(await prismaUnsafe.membership.count({ where: { workspaceId: targetId } })).toBe(0);
  });

  it("leaves the source untouched", async () => {
    await copyWorkspaceSettings(sourceId, targetId, COPY_GROUP_KEYS);
    const rules = await prismaUnsafe.workflowRule.findMany({ where: { workspaceId: sourceId } });
    // Disarming the COPY must not disarm the original.
    expect(rules[0]!.enabled).toBe(true);
    expect(rules[0]!.version).toBe(5);
    const templates = await prismaUnsafe.template.findMany({ where: { workspaceId: sourceId } });
    expect(templates[0]!.version).toBe(7);
    expect(await prismaUnsafe.lead.count({ where: { workspaceId: sourceId } })).toBe(1);
  });

  it("copies the budget for nobody", async () => {
    await copyWorkspaceSettings(sourceId, targetId, COPY_GROUP_KEYS);
    const ws = await prismaUnsafe.workspace.findUnique({ where: { id: targetId } });
    // A spending cap is a per-workspace decision, not a style choice.
    expect(ws!.claudeBudget).not.toBe(9);
  });
});

describe("copying a subset", () => {
  it("touches only what was asked for", async () => {
    await copyWorkspaceSettings(sourceId, targetId, ["brand"]);
    const ws = await prismaUnsafe.workspace.findUnique({ where: { id: targetId } });
    expect(ws!.brand).toMatchObject({ color: "#123456" });
    expect(await prismaUnsafe.customFieldDef.count({ where: { workspaceId: targetId } })).toBe(0);
    expect(await prismaUnsafe.pipeline.count({ where: { workspaceId: targetId } })).toBe(0);
  });

  it("ignores a group name that is not in the plan", async () => {
    const res = await copyWorkspaceSettings(sourceId, targetId, ["leads", "documents", "brand"]);
    expect(Object.keys(res.counts)).toEqual(["brand"]);
    expect(await prismaUnsafe.lead.count({ where: { workspaceId: targetId } })).toBe(0);
  });
});

describe("running it more than once", () => {
  it("is additive and never duplicates", async () => {
    await copyWorkspaceSettings(sourceId, targetId, COPY_GROUP_KEYS);
    const second = await copyWorkspaceSettings(sourceId, targetId, COPY_GROUP_KEYS);

    // Everything already present is skipped, so the second pass moves nothing.
    expect(second.counts.fields).toBe(0);
    expect(second.counts.pipelines).toBe(0);
    expect(second.counts.documentTemplates).toBe(0);
    expect(second.counts.workflows).toBe(0);
    expect(second.counts.targets).toBe(0);

    expect(await prismaUnsafe.pipeline.count({ where: { workspaceId: targetId } })).toBe(1);
    expect(await prismaUnsafe.customFieldDef.count({ where: { workspaceId: targetId } })).toBe(1);
    expect(await prismaUnsafe.workflowRule.count({ where: { workspaceId: targetId } })).toBe(1);
  });

  it("does not overwrite something that was tuned in the target afterwards", async () => {
    await copyWorkspaceSettings(sourceId, targetId, ["workflows"]);
    const rule = await prismaUnsafe.workflowRule.findFirst({ where: { workspaceId: targetId } });
    await prismaUnsafe.workflowRule.update({
      where: { id: rule!.id },
      data: { enabled: true, actions: [{ type: "create_task", title: "Átírtam" }] },
    });

    await copyWorkspaceSettings(sourceId, targetId, ["workflows"]);
    const after = await prismaUnsafe.workflowRule.findUnique({ where: { id: rule!.id } });
    // The Owner's edit survives — the copy skips, it does not reconcile.
    expect(after!.enabled).toBe(true);
    expect(after!.actions).toEqual([{ type: "create_task", title: "Átírtam" }]);
  });
});

describe("refusals", () => {
  it("refuses to copy a workspace onto itself", async () => {
    const res = await copyWorkspaceSettings(sourceId, sourceId, COPY_GROUP_KEYS);
    expect(res.skipped[0]).toMatch(/ugyanaz/i);
    expect(Object.keys(res.counts)).toEqual([]);
  });

  it("says so rather than throwing when a workspace is gone", async () => {
    const res = await copyWorkspaceSettings("no-such-id", targetId, ["brand"]);
    expect(res.skipped[0]).toMatch(/nem található/i);
  });
});
