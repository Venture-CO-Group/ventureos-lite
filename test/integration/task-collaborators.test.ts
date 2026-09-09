import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import {
  addCollaborator,
  applyAssignment,
  collaboratingTaskIds,
  listCollaborators,
  removeCollaborator,
  taskTrail,
} from "../../src/modules/tasks/collaborators";

/**
 * Collaborators and the delegation trail, against the real database
 * (playbook-v5 P20/6).
 *
 * The verification the playbook asks for by name is "reassignment records the
 * delegation trail". The rest is the shape of the three relationships: that
 * the assignee stays ONE person, that a collaborator is not the same thing as
 * a follower, and that removing somebody from the work does not silently
 * unsubscribe them from it.
 */
const WS = "Collab WS";
let workspaceId = "";
let boardId = "";
let taskId = "";
const ANNA = "collab-anna";
const BELA = "collab-bela";
const CSABA = "collab-csaba";

async function member(id: string, name: string) {
  await prismaUnsafe.user.upsert({
    where: { id },
    update: { name },
    create: { id, name, email: `${id}@example.test`, passwordHash: "x" },
  });
  await prismaUnsafe.membership.upsert({
    where: { userId_workspaceId: { userId: id, workspaceId } },
    update: {},
    create: { userId: id, workspaceId, role: "BDR" },
  });
}

beforeAll(async () => {
  const ws =
    (await prismaUnsafe.workspace.findFirst({ where: { name: WS } })) ??
    (await prismaUnsafe.workspace.create({ data: { name: WS } }));
  workspaceId = ws.id;
  await prismaUnsafe.taskEvent.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskCollaborator.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskBoard.deleteMany({ where: { workspaceId } });
  boardId = (await prismaUnsafe.taskBoard.create({ data: { workspaceId, name: "Collab board" } }))
    .id;
  await member(ANNA, "Anna");
  await member(BELA, "Béla");
  await member(CSABA, "Csaba");
});

beforeEach(async () => {
  await prismaUnsafe.taskEvent.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskCollaborator.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskFollower.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  taskId = (
    await prismaUnsafe.task.create({
      data: { workspaceId, boardId, title: "Rewrite the deck" },
    })
  ).id;
});

afterAll(async () => {
  await prismaUnsafe.taskEvent.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskCollaborator.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskFollower.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskBoard.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.membership.deleteMany({ where: { workspaceId } });
});

const task = () => prismaUnsafe.task.findUniqueOrThrow({ where: { id: taskId } });

describe("reassignment records the delegation trail", () => {
  it("stamps who handed it over, and only on a real handover", async () => {
    // Given out for the first time: an assignment, not a handover.
    expect(
      await applyAssignment(workspaceId, taskId, {
        before: null,
        after: ANNA,
        actorUserId: CSABA,
      }),
    ).toBe("assigned");
    let row = await task();
    expect(row.assigneeId).toBe(ANNA);
    expect(
      row.delegatedBy,
      "a first assignment was recorded as a handover, which would make the trail meaningless",
    ).toBeNull();

    // Anna hands it to Béla: now it is a delegation.
    expect(
      await applyAssignment(workspaceId, taskId, {
        before: ANNA,
        after: BELA,
        actorUserId: ANNA,
      }),
    ).toBe("delegated");
    row = await task();
    expect(row.assigneeId).toBe(BELA);
    expect(row.delegatedBy).toBe(ANNA);
    expect(row.delegatedAt).not.toBeNull();

    // The trail has both, newest first, as sentences.
    const trail = await taskTrail(workspaceId, taskId);
    expect(trail.map((t) => t.kind)).toEqual(["delegated", "assigned"]);
    expect(trail[0].text).toBe("Anna handed this from Anna to Béla.");
  });

  it("clears the handover when the owner is taken away", async () => {
    await applyAssignment(workspaceId, taskId, {
      before: null,
      after: ANNA,
      actorUserId: CSABA,
    });
    await applyAssignment(workspaceId, taskId, {
      before: ANNA,
      after: BELA,
      actorUserId: ANNA,
    });
    await applyAssignment(workspaceId, taskId, {
      before: BELA,
      after: null,
      actorUserId: CSABA,
    });

    const row = await task();
    expect(row.assigneeId).toBeNull();
    // There is nobody it was handed to, so saying it was handed over is a lie.
    expect(row.delegatedBy).toBeNull();
    expect(row.delegatedAt).toBeNull();
  });

  it("writes nothing when the assignee does not change", async () => {
    await applyAssignment(workspaceId, taskId, {
      before: null,
      after: ANNA,
      actorUserId: CSABA,
    });
    expect(
      await applyAssignment(workspaceId, taskId, {
        before: ANNA,
        after: ANNA,
        actorUserId: CSABA,
      }),
    ).toBeNull();
    expect(await taskTrail(workspaceId, taskId)).toHaveLength(1);
  });

  it("records a rule's handover with no actor", async () => {
    await applyAssignment(workspaceId, taskId, { before: null, after: ANNA, actorUserId: null });
    await applyAssignment(workspaceId, taskId, {
      before: ANNA,
      after: BELA,
      actorUserId: null,
    });
    const trail = await taskTrail(workspaceId, taskId);
    expect(trail[0].text).toMatch(/^The system handed this/);
  });
});

describe("collaborators", () => {
  it("adds somebody, and makes them a follower too", async () => {
    expect(await addCollaborator(workspaceId, taskId, BELA, ANNA)).toEqual({ ok: true });
    const list = await listCollaborators(workspaceId, taskId);
    expect(list).toEqual([{ userId: BELA, name: "Béla", addedBy: ANNA }]);

    // Working on it implies hearing about it. The reverse is not true, which
    // is why a follower is never promoted to a collaborator.
    const follower = await prismaUnsafe.taskFollower.findFirst({
      where: { taskId, userId: BELA },
    });
    expect(follower, "a collaborator does not hear about comments on their own work").toBeTruthy();
  });

  it("refuses the assignee — they already own it", async () => {
    await prismaUnsafe.task.update({ where: { id: taskId }, data: { assigneeId: ANNA } });
    const res = await addCollaborator(workspaceId, taskId, ANNA, BELA);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already own/i);
    expect(await listCollaborators(workspaceId, taskId)).toHaveLength(0);
  });

  it("refuses somebody from outside the workspace", async () => {
    const res = await addCollaborator(workspaceId, taskId, "a-stranger", ANNA);
    expect(res).toMatchObject({ ok: false });
  });

  it("refuses the same person twice", async () => {
    await addCollaborator(workspaceId, taskId, BELA, ANNA);
    expect(await addCollaborator(workspaceId, taskId, BELA, ANNA)).toMatchObject({ ok: false });
    expect(await listCollaborators(workspaceId, taskId)).toHaveLength(1);
  });

  it("removes them from the work but not from the conversation", async () => {
    await addCollaborator(workspaceId, taskId, BELA, ANNA);
    expect(await removeCollaborator(workspaceId, taskId, BELA, ANNA)).toEqual({ ok: true });
    expect(await listCollaborators(workspaceId, taskId)).toHaveLength(0);

    // Still following: somebody taken off the work may still want to know how
    // it ends, and unsubscribing them silently is not our decision.
    const follower = await prismaUnsafe.taskFollower.findFirst({
      where: { taskId, userId: BELA },
    });
    expect(follower).toBeTruthy();

    // And it is in the trail, both ways.
    const trail = await taskTrail(workspaceId, taskId);
    expect(trail.map((t) => t.kind)).toEqual(["collaborator_removed", "collaborator_added"]);
  });

  it("says so when they were not a collaborator", async () => {
    const res = await removeCollaborator(workspaceId, taskId, CSABA, ANNA);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not a collaborator/i);
  });

  it("lists what somebody is collaborating on, for the My Work toggle", async () => {
    const second = await prismaUnsafe.task.create({
      data: { workspaceId, boardId, title: "Second task", assigneeId: ANNA },
    });
    await addCollaborator(workspaceId, taskId, BELA, ANNA);
    await addCollaborator(workspaceId, second.id, BELA, ANNA);

    const ids = await collaboratingTaskIds(workspaceId, BELA);
    expect(new Set(ids)).toEqual(new Set([taskId, second.id]));
    expect(await collaboratingTaskIds(workspaceId, CSABA)).toEqual([]);
  });

  it("takes the collaborators and the trail with the task when the task goes", async () => {
    await addCollaborator(workspaceId, taskId, BELA, ANNA);
    await applyAssignment(workspaceId, taskId, { before: null, after: ANNA, actorUserId: BELA });
    await prismaUnsafe.task.delete({ where: { id: taskId } });

    expect(await prismaUnsafe.taskCollaborator.count({ where: { taskId } })).toBe(0);
    expect(await prismaUnsafe.taskEvent.count({ where: { taskId } })).toBe(0);
  });
});
