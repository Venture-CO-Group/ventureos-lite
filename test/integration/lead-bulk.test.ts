import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { csvCell, parseCsv } from "../helpers/csv";
import { prismaUnsafe } from "../../src/lib/db";
import {
  applyOwner,
  applySignals,
  applyStageChange,
  deleteLeadsBulk,
  exportLeadsCsv,
  resolveSelection,
} from "../../src/modules/leads/bulk-store";
import type { FilterSet } from "../../src/modules/leads/filters";

/**
 * Bulk actions against the real database (playbook-v2 P3/2).
 *
 * The pure decisions are covered in test/unit/lead-bulk.test.ts. What matters
 * here is what a mutation can REACH: the score gate must still hold when 200
 * leads move at once, and a lead id from another workspace must do nothing at
 * all even when it is passed in deliberately (CLAUDE.md hard rule #1).
 */
const NAMES = ["Bulk Alpha", "Bulk Bravo"];
let wsA = "";
let wsB = "";
let actor = "";
let bLeadId = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    await prismaUnsafe.activity.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.auditLog.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.lead.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.company.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.membership.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
  }
  await prismaUnsafe.user.deleteMany({ where: { email: "bulk-actor@iso.test" } });
}

/** Fresh leads for each test, so one test's mutations cannot bias the next. */
async function seedLeads() {
  await prismaUnsafe.activity.deleteMany({ where: { workspaceId: wsA } });
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId: wsA } });
  const company = await prismaUnsafe.company.findFirst({ where: { workspaceId: wsA } });
  const mk = (name: string, icpScore: number | null, stage: string, signals: string[] = []) =>
    prismaUnsafe.lead.create({
      data: {
        workspaceId: wsA,
        companyId: company!.id,
        contactName: name,
        icpScore,
        stage: stage as "RESEARCHED",
        signals,
      },
    });
  return {
    high: (await mk("High", 5, "RESEARCHED", ["hiring"])).id,
    mid: (await mk("Mid", 3, "RESEARCHED")).id,
    low: (await mk("Low", 1, "RESEARCHED")).id,
    unscored: (await mk("Unscored", null, "RESEARCHED")).id,
  };
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
  actor = (
    await prismaUnsafe.user.create({
      data: { email: "bulk-actor@iso.test", name: "Actor", passwordHash: "x" },
    })
  ).id;
  await prismaUnsafe.membership.create({
    data: { userId: actor, workspaceId: wsA, role: "OWNER" },
  });
  await prismaUnsafe.company.create({ data: { workspaceId: wsA, name: "Alpha Co" } });

  const bCompany = await prismaUnsafe.company.create({
    data: { workspaceId: wsB, name: "Bravo Co" },
  });
  bLeadId = (
    await prismaUnsafe.lead.create({
      data: {
        workspaceId: wsB,
        companyId: bCompany.id,
        contactName: "Bravo Secret",
        icpScore: 5,
        stage: "RESEARCHED",
      },
    })
  ).id;
});

afterAll(async () => {
  await clean();
});

describe("bulk stage change", () => {
  let ids: Awaited<ReturnType<typeof seedLeads>>;
  beforeEach(async () => {
    ids = await seedLeads();
  });

  it("moves the leads above the gate and skips the ones below it", async () => {
    const res = await applyStageChange(
      wsA,
      actor,
      [ids.high, ids.mid, ids.low, ids.unscored],
      "CONTACTED",
      3,
    );
    expect(res.applied).toBe(2);
    expect(res.skipped).toHaveLength(2);

    const rows = await prismaUnsafe.lead.findMany({
      where: { id: { in: [ids.high, ids.mid, ids.low, ids.unscored] } },
      select: { id: true, stage: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.stage]));
    expect(byId.get(ids.high)).toBe("CONTACTED");
    expect(byId.get(ids.mid)).toBe("CONTACTED");
    // The gate held for the whole batch, not just for the UI.
    expect(byId.get(ids.low)).toBe("RESEARCHED");
    expect(byId.get(ids.unscored)).toBe("RESEARCHED");
  });

  it("names every skipped lead and why", async () => {
    const res = await applyStageChange(wsA, actor, [ids.low, ids.unscored], "CONTACTED", 3);
    expect(res.applied).toBe(0);
    const reasons = Object.fromEntries(res.skipped.map((s) => [s.id, s.reason]));
    expect(reasons[ids.low]).toMatch(/1 < 3/);
    expect(reasons[ids.unscored]).toMatch(/unscored/i);
  });

  it("records an activity for each lead that actually moved", async () => {
    await applyStageChange(wsA, actor, [ids.high, ids.low], "CONTACTED", 3);
    const activities = await prismaUnsafe.activity.findMany({
      where: { workspaceId: wsA, type: "stage_change" },
      select: { leadId: true },
    });
    expect(activities.map((a) => a.leadId)).toEqual([ids.high]);
  });

  it("sets a wake-up date when parking leads as Not now", async () => {
    const wakeUpAt = new Date("2027-01-15T00:00:00Z");
    const res = await applyStageChange(wsA, actor, [ids.low], "NOT_NOW", 3, { wakeUpAt });
    expect(res.applied).toBe(1);
    const row = await prismaUnsafe.lead.findUnique({ where: { id: ids.low } });
    expect(row?.stage).toBe("NOT_NOW");
    expect(row?.wakeUpAt?.toISOString()).toBe(wakeUpAt.toISOString());
  });

  it("refuses to disqualify without a reason", async () => {
    const res = await applyStageChange(wsA, actor, [ids.high], "DISQUALIFIED", 3);
    expect(res.applied).toBe(0);
    expect(res.skipped[0]!.reason).toMatch(/reason/i);
  });

  it("cannot touch another workspace's lead, even when handed its id", async () => {
    const res = await applyStageChange(wsA, actor, [bLeadId], "CONTACTED", 3);
    expect(res.applied).toBe(0);
    const untouched = await prismaUnsafe.lead.findUnique({ where: { id: bLeadId } });
    expect(untouched?.stage).toBe("RESEARCHED");
  });
});

describe("bulk signal tags", () => {
  let ids: Awaited<ReturnType<typeof seedLeads>>;
  beforeEach(async () => {
    ids = await seedLeads();
  });

  it("adds a tag to every selected lead without duplicating an existing one", async () => {
    const res = await applySignals(wsA, [ids.high, ids.mid], { add: ["hiring", "funding"] });
    expect(res.applied).toBe(2);
    const rows = await prismaUnsafe.lead.findMany({
      where: { id: { in: [ids.high, ids.mid] } },
      select: { id: true, signals: true },
    });
    for (const row of rows) {
      const signals = row.signals as string[];
      expect(signals).toContain("funding");
      expect(signals.filter((s) => s === "hiring")).toHaveLength(1);
    }
  });

  it("removes a tag", async () => {
    await applySignals(wsA, [ids.high], { remove: ["hiring"] });
    const row = await prismaUnsafe.lead.findUnique({ where: { id: ids.high } });
    expect(row?.signals as string[]).not.toContain("hiring");
  });

  it("ignores a lead from another workspace", async () => {
    await applySignals(wsA, [bLeadId], { add: ["leaked"] });
    const row = await prismaUnsafe.lead.findUnique({ where: { id: bLeadId } });
    expect(row?.signals as string[]).toEqual([]);
  });
});

describe("bulk owner assignment", () => {
  it("assigns and unassigns", async () => {
    const ids = await seedLeads();
    expect((await applyOwner(wsA, [ids.high, ids.mid], actor)).applied).toBe(2);
    let rows = await prismaUnsafe.lead.findMany({
      where: { id: { in: [ids.high, ids.mid] } },
      select: { ownerId: true },
    });
    expect(rows.every((r) => r.ownerId === actor)).toBe(true);

    await applyOwner(wsA, [ids.high], null);
    rows = await prismaUnsafe.lead.findMany({
      where: { id: ids.high },
      select: { ownerId: true },
    });
    expect(rows[0]!.ownerId).toBeNull();
  });

  it("refuses an owner who is not a member of the workspace", async () => {
    const ids = await seedLeads();
    const outsider = await prismaUnsafe.user.create({
      data: { email: "bulk-outsider@iso.test", name: "Outsider", passwordHash: "x" },
    });
    try {
      const res = await applyOwner(wsA, [ids.high], outsider.id);
      expect(res.applied).toBe(0);
      const row = await prismaUnsafe.lead.findUnique({ where: { id: ids.high } });
      expect(row?.ownerId).toBeNull();
    } finally {
      await prismaUnsafe.user.delete({ where: { id: outsider.id } });
    }
  });
});

describe("select all matching", () => {
  it("resolves the ids server-side from the filter, scoped to the workspace", async () => {
    const ids = await seedLeads();
    const filters: FilterSet = {
      match: "all",
      conditions: [{ field: "icpScore", operator: "gte", value: 3 }],
    };
    const matched = await resolveSelection(wsA, filters);
    expect(matched.sort()).toEqual([ids.high, ids.mid].sort());
    // Workspace B's lead scores 5 and would match — but it is not ours.
    expect(matched).not.toContain(bLeadId);
  });
});

describe("bulk delete", () => {
  it("erases the leads and audit-logs each one", async () => {
    const ids = await seedLeads();
    const res = await deleteLeadsBulk(wsA, actor, [ids.low, ids.unscored]);
    expect(res.applied).toBe(2);

    expect(await prismaUnsafe.lead.findUnique({ where: { id: ids.low } })).toBeNull();
    expect(await prismaUnsafe.lead.findUnique({ where: { id: ids.unscored } })).toBeNull();
    // Still there — only the selected two went.
    expect(await prismaUnsafe.lead.findUnique({ where: { id: ids.high } })).not.toBeNull();

    const logs = await prismaUnsafe.auditLog.findMany({
      where: { workspaceId: wsA, action: "lead.deleted" },
    });
    expect(logs.length).toBeGreaterThanOrEqual(2);
  });

  it("cannot delete another workspace's lead", async () => {
    const res = await deleteLeadsBulk(wsA, actor, [bLeadId]);
    expect(res.applied).toBe(0);
    expect(await prismaUnsafe.lead.findUnique({ where: { id: bLeadId } })).not.toBeNull();
  });
});

describe("bulk CSV export", () => {
  it("exports the selected leads, whole record", async () => {
    const ids = await seedLeads();
    const csv = await exportLeadsCsv(wsA, [ids.high]);
    expect(csvCell(csv, "Name")).toBe("High");
    expect(csvCell(csv, "ICP score")).toBe("5");
  });

  it("never exports a lead from another workspace", async () => {
    const csv = await exportLeadsCsv(wsA, [bLeadId]);
    expect(csv).not.toContain("Bravo Secret");
    // Header only.
    expect(parseCsv(csv)).toHaveLength(1);
  });
});
