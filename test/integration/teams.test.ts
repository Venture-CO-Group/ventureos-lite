import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { listTeams, roundRobinPick, teamImpact } from "../../src/modules/teams/store";

/**
 * Teams (§5).
 *
 * The most important property is one this file cannot assert directly: teams
 * grant nothing. There is no permission logic in the teams module, which the
 * grants property test over role × grant combinations covers from the other
 * side. What is testable here is the workload view and the two different ways
 * a team resolves to a person.
 */
const WS = "Teams WS";
const EMAILS = ["team-a@ventureco.test", "team-b@ventureco.test", "team-c@ventureco.test"];
let workspaceId = "";
const ids: string[] = [];
let teamId = "";

beforeEach(async () => {
  const existing = await prismaUnsafe.workspace.findFirst({ where: { name: WS } });
  const ws = existing ?? (await prismaUnsafe.workspace.create({ data: { name: WS } }));
  workspaceId = ws.id;

  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.teamMember.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.team.deleteMany({ where: { workspaceId } });

  ids.length = 0;
  for (const [i, email] of EMAILS.entries()) {
    const u = await prismaUnsafe.user.upsert({
      where: { email },
      update: {},
      create: { email, name: `Team Member ${"ABC"[i]}`, passwordHash: "x" },
    });
    ids.push(u.id);
    await prismaUnsafe.membership.upsert({
      where: { userId_workspaceId: { userId: u.id, workspaceId } },
      update: { state: "ACTIVE", role: "BDR" },
      create: { userId: u.id, workspaceId, role: "BDR", grants: [], state: "ACTIVE" },
    });
  }

  const team = await prismaUnsafe.team.create({
    data: { workspaceId, name: "Budapest desk", color: "#3DDC97" },
  });
  teamId = team.id;
});

afterAll(async () => {
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.teamMember.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.team.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.membership.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.user.deleteMany({ where: { email: { in: EMAILS } } });
  await prismaUnsafe.workspace.deleteMany({ where: { name: WS } });
});

async function join(userId: string, isLead = false) {
  await prismaUnsafe.teamMember.create({
    data: { workspaceId, teamId, userId, isLead },
  });
}

async function tasksFor(userId: string, n: number) {
  for (let i = 0; i < n; i += 1) {
    await prismaUnsafe.task.create({
      data: { workspaceId, title: `T${i}`, position: i, assigneeId: userId },
    });
  }
}

describe("the team view", () => {
  it("shows who is on it and what they are carrying", async () => {
    await join(ids[0]!, true);
    await join(ids[1]!);
    await tasksFor(ids[0]!, 3);
    await tasksFor(ids[1]!, 1);

    const [team] = await listTeams(workspaceId);
    expect(team!.name).toBe("Budapest desk");
    // Lead first: the person you escalate to is the one you look for.
    expect(team!.members[0]!.isLead).toBe(true);
    expect(team!.members[0]!.openTasks).toBe(3);
    expect(team!.members[1]!.openTasks).toBe(1);
  });

  it("does not count a finished task as workload", async () => {
    await join(ids[0]!);
    await tasksFor(ids[0]!, 2);
    await prismaUnsafe.task.updateMany({
      where: { workspaceId, assigneeId: ids[0] },
      data: { doneAt: new Date() },
    });
    const [team] = await listTeams(workspaceId);
    expect(team!.members[0]!.openTasks).toBe(0);
  });

  it("survives a member whose user row has gone", async () => {
    // A dangling row must render as a dash rather than crashing the panel.
    await prismaUnsafe.teamMember.create({
      data: { workspaceId, teamId, userId: "no-such-user" },
    });
    const [team] = await listTeams(workspaceId);
    expect(team!.members[0]!.name).toBe("—");
  });
});

describe("deleting a team", () => {
  it("is refused while somebody is on it, and says who", async () => {
    /**
     * Same impact-report pattern as removing a member, and for the same
     * reason: deleting a team that is somebody's escalation route would leave
     * that pointing at nothing, silently.
     */
    await join(ids[0]!);
    const impact = await teamImpact(workspaceId, teamId);
    expect(impact.canDelete).toBe(false);
    expect(impact.members).toBe(1);
    expect(impact.reason).toMatch(/archive the team instead/);
  });

  it("is allowed once it is empty", async () => {
    const impact = await teamImpact(workspaceId, teamId);
    expect(impact.canDelete).toBe(true);
    expect(impact.reason).toBeNull();
  });
});

describe("round-robin", () => {
  it("picks whoever has the least on", async () => {
    /**
     * Assigning ONE new thing to a team should spread the load. Handing over a
     * departing person's whole book should not — which is why `removal.ts`
     * resolves a team to its lead instead, and these are two functions.
     */
    await join(ids[0]!);
    await join(ids[1]!);
    await join(ids[2]!);
    await tasksFor(ids[0]!, 5);
    await tasksFor(ids[1]!, 1);
    await tasksFor(ids[2]!, 3);

    expect(await roundRobinPick(workspaceId, teamId)).toBe(ids[1]);
  });

  it("breaks a tie on who joined first, so the answer is stable", async () => {
    await join(ids[0]!);
    await join(ids[1]!);
    // Both on zero.
    expect(await roundRobinPick(workspaceId, teamId)).toBe(ids[0]);
    expect(await roundRobinPick(workspaceId, teamId)).toBe(ids[0]);
  });

  it("skips somebody who cannot pick the work up", async () => {
    await join(ids[0]!);
    await join(ids[1]!);
    await tasksFor(ids[1]!, 9);
    // A suspended member has the lightest load and must still be skipped.
    await prismaUnsafe.membership.update({
      where: { userId_workspaceId: { userId: ids[0]!, workspaceId } },
      data: { state: "SUSPENDED", suspendedAt: new Date() },
    });
    expect(await roundRobinPick(workspaceId, teamId)).toBe(ids[1]);
  });

  it("skips a read-only client account", async () => {
    await join(ids[0]!);
    await join(ids[1]!);
    await tasksFor(ids[1]!, 4);
    await prismaUnsafe.membership.update({
      where: { userId_workspaceId: { userId: ids[0]!, workspaceId } },
      data: { role: "CLIENT" },
    });
    expect(await roundRobinPick(workspaceId, teamId)).toBe(ids[1]);
  });

  it("returns nothing rather than guessing when nobody is eligible", async () => {
    // An empty team, or one where everybody is stood down. A caller that got a
    // user id here would assign work to somebody who cannot see it.
    expect(await roundRobinPick(workspaceId, teamId)).toBeNull();
    await join(ids[0]!);
    await prismaUnsafe.membership.update({
      where: { userId_workspaceId: { userId: ids[0]!, workspaceId } },
      data: { state: "SUSPENDED", suspendedAt: new Date() },
    });
    expect(await roundRobinPick(workspaceId, teamId)).toBeNull();
  });
});
