import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { executeRemoval, impactOf } from "../../src/modules/members/removal";

/**
 * Removing somebody from a workspace (§4).
 *
 * The dangerous action in this product, dangerous in two directions at once.
 * Leave the records and open deals lose their owner and fall out of the
 * forecast while a departed employee stays in every picker. Reassign
 * carelessly and a client's history changes hands with no record of why.
 *
 * The test that matters most is the last one: a forced failure mid-flight must
 * leave NOTHING changed.
 */
const WS = "Removal WS";
const LEAVER = "removal-leaver@ventureco.test";
const TAKER = "removal-taker@ventureco.test";
const OWNER = "removal-owner@ventureco.test";

let workspaceId = "";
let leaverId = "";
let takerId = "";
let ownerId = "";
let pipelineId = "";
let stageId = "";
let companyId = "";

async function ensure() {
  const existing = await prismaUnsafe.workspace.findFirst({ where: { name: WS } });
  const ws = existing ?? (await prismaUnsafe.workspace.create({ data: { name: WS } }));
  workspaceId = ws.id;

  for (const [email, name, role] of [
    [LEAVER, "Leaver Person", "BDR"],
    [TAKER, "Taker Person", "BDR"],
    [OWNER, "Owner Person", "OWNER"],
  ] as const) {
    const user = await prismaUnsafe.user.upsert({
      where: { email },
      update: {},
      create: { email, name, passwordHash: "x" },
    });
    await prismaUnsafe.membership.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
      update: { role, state: "ACTIVE", removedAt: null },
      create: { userId: user.id, workspaceId, role, grants: [], state: "ACTIVE" },
    });
    if (email === LEAVER) leaverId = user.id;
    if (email === TAKER) takerId = user.id;
    if (email === OWNER) ownerId = user.id;
  }

  const pipeline =
    (await prismaUnsafe.pipeline.findFirst({ where: { workspaceId } })) ??
    (await prismaUnsafe.pipeline.create({
      data: { workspaceId, name: "Main", key: "main", isDefault: true },
    }));
  pipelineId = pipeline.id;
  const stage =
    (await prismaUnsafe.dealStage.findFirst({ where: { pipelineId } })) ??
    (await prismaUnsafe.dealStage.create({
      data: { workspaceId, pipelineId, name: "Open", key: "open", position: 0 },
    }));
  stageId = stage.id;
  const company =
    (await prismaUnsafe.company.findFirst({ where: { workspaceId } })) ??
    (await prismaUnsafe.company.create({ data: { workspaceId, name: "Removal Co" } }));
  companyId = company.id;
}

async function clearWork() {
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.deal.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.savedView.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.membershipEvent.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.auditLog.deleteMany({ where: { workspaceId } });
}

beforeEach(async () => {
  await ensure();
  await clearWork();
});

afterAll(async () => {
  await clearWork();
  await prismaUnsafe.dealStage.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.pipeline.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.company.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.membership.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.user.deleteMany({ where: { email: { in: [LEAVER, TAKER, OWNER] } } });
  await prismaUnsafe.workspace.deleteMany({ where: { name: WS } });
});

async function seedWork() {
  for (let i = 0; i < 3; i += 1) {
    await prismaUnsafe.lead.create({
      data: { workspaceId, companyId, contactName: `Lead ${i}`, ownerId: leaverId },
    });
  }
  await prismaUnsafe.deal.create({
    data: {
      workspaceId,
      companyId,
      pipelineId,
      stageId,
      title: "Open deal",
      ownerId: leaverId,
      status: "OPEN",
    },
  });
  await prismaUnsafe.deal.create({
    data: {
      workspaceId,
      companyId,
      pipelineId,
      stageId,
      title: "Won deal",
      ownerId: leaverId,
      status: "WON",
      closedAt: new Date(),
    },
  });
  await prismaUnsafe.task.create({
    data: { workspaceId, title: "Open task", position: 1, assigneeId: leaverId },
  });
  await prismaUnsafe.task.create({
    data: {
      workspaceId,
      title: "Done task",
      position: 2,
      assigneeId: leaverId,
      doneAt: new Date(),
    },
  });
}

describe("the impact report", () => {
  it("counts what they hold, and only what is still open", async () => {
    await seedWork();
    const impact = await impactOf(workspaceId, leaverId);
    expect(impact!.counts.leads).toBe(3);
    // The won deal and the done task keep whoever had them — reassigning
    // either would rewrite a record of what happened.
    expect(impact!.counts.deals).toBe(1);
    expect(impact!.counts.tasks).toBe(1);
    expect(impact!.total).toBe(5);
  });

  it("says when somebody is the last Owner who can sign in", async () => {
    const impact = await impactOf(workspaceId, ownerId);
    expect(impact!.isLastOwner).toBe(true);
    const other = await impactOf(workspaceId, leaverId);
    expect(other!.isLastOwner).toBe(false);
  });
});

describe("refusals", () => {
  const plan = { leads: { kind: "user" as const, userId: "" } };

  it("refuses to remove the last Owner", async () => {
    const res = await executeRemoval({
      workspaceId,
      actorUserId: leaverId,
      userId: ownerId,
      plan: {},
      reason: "leaving",
      disconnectMail: false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/last Owner/i);
  });

  it("refuses to remove yourself", async () => {
    const res = await executeRemoval({
      workspaceId,
      actorUserId: leaverId,
      userId: leaverId,
      plan: {},
      reason: "leaving",
      disconnectMail: false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cannot remove yourself/i);
  });

  it("demands a reason", async () => {
    const res = await executeRemoval({
      workspaceId,
      actorUserId: ownerId,
      userId: leaverId,
      plan: {},
      reason: "   ",
      disconnectMail: false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/say why/i);
  });

  it("refuses an incomplete plan, listing every gap", async () => {
    await seedWork();
    const res = await executeRemoval({
      workspaceId,
      actorUserId: ownerId,
      userId: leaverId,
      plan: { leads: { kind: "unassign" } },
      reason: "left the company",
      disconnectMail: false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // Every gap at once: a removal flow that reports one at a time is a form
      // somebody submits five times.
      expect(res.problems).toHaveLength(2);
      expect(res.problems!.join(" ")).toMatch(/Open deals/);
      expect(res.problems!.join(" ")).toMatch(/Open tasks/);
    }
    void plan;
  });

  it("refuses to leave an open deal unowned", async () => {
    await seedWork();
    const res = await executeRemoval({
      workspaceId,
      actorUserId: ownerId,
      userId: leaverId,
      plan: {
        leads: { kind: "unassign" },
        deals: { kind: "unassign" },
        tasks: { kind: "user", userId: takerId },
      },
      reason: "left",
      disconnectMail: false,
    });
    expect(res.ok).toBe(false);
    // An unowned open deal is money nobody is chasing.
    if (!res.ok) expect(res.problems!.join(" ")).toMatch(/money nobody is chasing/);
  });

  it("refuses a target who is not an active member", async () => {
    await seedWork();
    await prismaUnsafe.membership.update({
      where: { userId_workspaceId: { userId: takerId, workspaceId } },
      data: { state: "SUSPENDED", suspendedAt: new Date() },
    });
    const res = await executeRemoval({
      workspaceId,
      actorUserId: ownerId,
      userId: leaverId,
      plan: {
        leads: { kind: "user", userId: takerId },
        deals: { kind: "user", userId: takerId },
        tasks: { kind: "user", userId: takerId },
      },
      reason: "left",
      disconnectMail: false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not an active member/i);
    // And nothing moved.
    expect(await prismaUnsafe.lead.count({ where: { workspaceId, ownerId: leaverId } })).toBe(3);
  });
});

describe("a completed removal", () => {
  it("moves what was chosen and leaves history alone", async () => {
    await seedWork();
    const res = await executeRemoval({
      workspaceId,
      actorUserId: ownerId,
      userId: leaverId,
      plan: {
        leads: { kind: "user", userId: takerId },
        deals: { kind: "user", userId: takerId },
        tasks: { kind: "user", userId: takerId },
      },
      reason: "left the company on the 30th",
      disconnectMail: false,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.moved).toMatchObject({ leads: 3, deals: 1, tasks: 1 });

    expect(await prismaUnsafe.lead.count({ where: { workspaceId, ownerId: takerId } })).toBe(3);
    // The won deal and the done task did NOT move: they are records of what
    // happened, and who they belonged to is part of the record.
    const wonDeal = await prismaUnsafe.deal.findFirstOrThrow({
      where: { workspaceId, title: "Won deal" },
    });
    expect(wonDeal.ownerId).toBe(leaverId);
    const doneTask = await prismaUnsafe.task.findFirstOrThrow({
      where: { workspaceId, title: "Done task" },
    });
    expect(doneTask.assigneeId).toBe(leaverId);
  });

  it("keeps the membership row, in REMOVED", async () => {
    await executeRemoval({
      workspaceId,
      actorUserId: ownerId,
      userId: leaverId,
      plan: {},
      reason: "left",
      disconnectMail: false,
    });
    const m = await prismaUnsafe.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: leaverId, workspaceId } },
    });
    // The row is what keeps `created by` and the timeline readable.
    expect(m.state).toBe("REMOVED");
    expect(m.removedBy).toBe(ownerId);
    expect(m.removedAt).not.toBeNull();
  });

  it("writes the reason and the reassignment to the timeline", async () => {
    await seedWork();
    await executeRemoval({
      workspaceId,
      actorUserId: ownerId,
      userId: leaverId,
      plan: {
        leads: { kind: "user", userId: takerId },
        deals: { kind: "user", userId: takerId },
        tasks: { kind: "user", userId: takerId },
      },
      reason: "left the company on the 30th",
      disconnectMail: false,
    });
    const events = await prismaUnsafe.membershipEvent.findMany({
      where: { workspaceId, userId: leaverId },
    });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("removed");
    expect(kinds).toContain("records_reassigned");
    expect(events.find((e) => e.kind === "removed")!.reason).toContain("30th");
    // And the audit log, which is the compliance half of the same fact.
    const audit = await prismaUnsafe.auditLog.findMany({ where: { workspaceId } });
    expect(audit.map((a) => a.action)).toContain("member.removed");
  });

  it("resolves a team target to its lead", async () => {
    await seedWork();
    const team = await prismaUnsafe.team.create({
      data: { workspaceId, name: `Removal Team ${Date.now()}` },
    });
    await prismaUnsafe.teamMember.create({
      data: { workspaceId, teamId: team.id, userId: takerId, isLead: true },
    });

    const res = await executeRemoval({
      workspaceId,
      actorUserId: ownerId,
      userId: leaverId,
      plan: {
        leads: { kind: "team", teamId: team.id },
        deals: { kind: "team", teamId: team.id },
        tasks: { kind: "team", teamId: team.id },
      },
      reason: "left",
      disconnectMail: false,
    });
    expect(res.ok).toBe(true);
    /**
     * The lead, not round-robin. This is a one-off handover of somebody's
     * book, and splitting twelve deals across four people is how each of them
     * assumes one of the others is handling it.
     */
    expect(await prismaUnsafe.lead.count({ where: { workspaceId, ownerId: takerId } })).toBe(3);

    await prismaUnsafe.teamMember.deleteMany({ where: { teamId: team.id } });
    await prismaUnsafe.team.delete({ where: { id: team.id } });
  });
});

describe("a failure mid-flight", () => {
  it("rolls everything back", async () => {
    /**
     * THE test for this section.
     *
     * A half-applied removal is the worst outcome available: some deals moved,
     * some did not, and nobody can say which. So the whole thing runs in one
     * transaction, and this forces it to fail after the first categories have
     * already been written.
     *
     * The forced failure is a real edge rather than a contrivance.
     * `SavedView` is unique on `[workspaceId, entity, ownerId, name]`, so
     * moving the leaver's "Hot leads" view to somebody who already has a view
     * of that name collides — which is exactly what happens when two people
     * name a view the same obvious thing. The plan validator cannot catch it
     * (both targets are legal); only the transaction can.
     */
    await seedWork();
    await prismaUnsafe.savedView.create({
      data: { workspaceId, name: "Hot leads", entity: "lead", ownerId: leaverId },
    });
    await prismaUnsafe.savedView.create({
      data: { workspaceId, name: "Hot leads", entity: "lead", ownerId: takerId },
    });

    const res = await executeRemoval({
      workspaceId,
      actorUserId: ownerId,
      userId: leaverId,
      plan: {
        leads: { kind: "user", userId: takerId },
        deals: { kind: "user", userId: takerId },
        tasks: { kind: "user", userId: takerId },
        savedViews: { kind: "user", userId: takerId },
      },
      reason: "left",
      disconnectMail: false,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/rolled back|Nothing was changed/i);

    // Every one of these is exactly as it was — including the leads, which
    // the transaction had already updated before it threw.
    expect(await prismaUnsafe.lead.count({ where: { workspaceId, ownerId: leaverId } })).toBe(3);
    expect(
      await prismaUnsafe.deal.count({ where: { workspaceId, ownerId: leaverId, status: "OPEN" } }),
    ).toBe(1);
    expect(
      await prismaUnsafe.task.count({ where: { workspaceId, assigneeId: leaverId, doneAt: null } }),
    ).toBe(1);
    const m = await prismaUnsafe.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: leaverId, workspaceId } },
    });
    expect(m.state).toBe("ACTIVE");
    // And no timeline entry claiming a removal that did not happen.
    expect(
      await prismaUnsafe.membershipEvent.count({ where: { workspaceId, kind: "removed" } }),
    ).toBe(0);

    await prismaUnsafe.savedView.deleteMany({ where: { workspaceId } });
  });
});
