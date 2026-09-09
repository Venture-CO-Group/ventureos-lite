import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import {
  bulkAssignTasks,
  bulkCompleteTasks,
  bulkDeleteTasks,
  bulkMoveTasksToSection,
  bulkSetTaskDue,
  bulkSetTaskPriority,
  bulkTagTasks,
} from "../../src/modules/tasks/bulk";

/**
 * Bulk task actions, against a real database (playbook-v5 P17/1).
 *
 * ── WHY THESE ARE THE IMPORTANT TESTS ──────────────────────────────────────
 *
 * The requirement is not "a bar with buttons". It is that every per-row rule
 * STILL APPLIES PER ROW when forty rows go through at once, and that the rows
 * it refused come back named with a reason. A bulk action that reports only a
 * count is lying by omission, and only a test that inspects `skipped` can say
 * it does not.
 */
const WS = "Bulk Tasks WS";
const OTHER = "Bulk Tasks Other WS";
let workspaceId = "";
let otherWorkspaceId = "";
let boardId = "";
let otherBoardId = "";
let doing = "";
let later = "";
let elsewhere = "";
let memberId = "";
let suspendedId = "";

async function user(email: string) {
  return (
    (await prismaUnsafe.user.findUnique({ where: { email } })) ??
    (await prismaUnsafe.user.create({
      data: { email, name: email.split("@")[0]!, passwordHash: "x" },
    }))
  );
}

beforeAll(async () => {
  const ws =
    (await prismaUnsafe.workspace.findFirst({ where: { name: WS } })) ??
    (await prismaUnsafe.workspace.create({ data: { name: WS } }));
  workspaceId = ws.id;
  const other =
    (await prismaUnsafe.workspace.findFirst({ where: { name: OTHER } })) ??
    (await prismaUnsafe.workspace.create({ data: { name: OTHER } }));
  otherWorkspaceId = other.id;

  memberId = (await user("bulk-member@ventureco.test")).id;
  suspendedId = (await user("bulk-suspended@ventureco.test")).id;
  for (const [userId, state] of [[memberId, "ACTIVE"], [suspendedId, "SUSPENDED"]] as const) {
    await prismaUnsafe.membership.upsert({
      where: { userId_workspaceId: { userId, workspaceId } },
      update: { state, role: "BDR", grants: [] },
      create: { userId, workspaceId, state, role: "BDR", grants: [] },
    });
  }

  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskSection.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskBoard.deleteMany({ where: { workspaceId } });

  const board = await prismaUnsafe.taskBoard.create({
    data: {
      workspaceId,
      name: "Bulk board",
      sections: {
        create: [
          { workspaceId, name: "Doing", position: 1024 },
          { workspaceId, name: "Later", position: 2048 },
        ],
      },
    },
    include: { sections: true },
  });
  boardId = board.id;
  doing = board.sections.find((s) => s.name === "Doing")!.id;
  later = board.sections.find((s) => s.name === "Later")!.id;

  const otherBoard = await prismaUnsafe.taskBoard.create({
    data: {
      workspaceId,
      name: "Another board",
      sections: { create: [{ workspaceId, name: "Elsewhere", position: 1024 }] },
    },
    include: { sections: true },
  });
  otherBoardId = otherBoard.id;
  elsewhere = otherBoard.sections[0]!.id;
});

afterAll(async () => {
  for (const id of [workspaceId, otherWorkspaceId]) {
    await prismaUnsafe.task.deleteMany({ where: { workspaceId: id } });
    await prismaUnsafe.taskSection.deleteMany({ where: { workspaceId: id } });
    await prismaUnsafe.taskBoard.deleteMany({ where: { workspaceId: id } });
    await prismaUnsafe.undoEntry.deleteMany({ where: { workspaceId: id } });
  }
});

async function task(over: Record<string, unknown> = {}) {
  return prismaUnsafe.task.create({
    data: { workspaceId, boardId, sectionId: doing, title: "Bulk subject", ...over },
  });
}

describe("completing many", () => {
  it("completes the open ones and names the ones already done", async () => {
    const open = await Promise.all([task(), task(), task()]);
    const done = await task({ doneAt: new Date() });

    const res = await bulkCompleteTasks(workspaceId, memberId, [
      ...open.map((t) => t.id),
      done.id,
    ]);
    expect(res.applied).toBe(3);
    expect(res.skipped.map((s) => s.reason)).toContain("Already complete.");
  });

  /**
   * Completion does not cascade in either direction — the model's rule. A
   * bulk tick of a parent must leave its subtasks open.
   */
  it("does not cascade to subtasks", async () => {
    const parent = await task({ title: "Parent" });
    const child = await prismaUnsafe.task.create({
      data: { workspaceId, boardId, sectionId: doing, title: "Child", parentId: parent.id },
    });
    await bulkCompleteTasks(workspaceId, memberId, [parent.id]);
    expect((await prismaUnsafe.task.findUnique({ where: { id: child.id } }))!.doneAt).toBeNull();
  });

  /**
   * A dependency is REPORTED, never enforced. So a blocked task is still
   * completed — but it is named, because ticking something that was waiting on
   * unfinished work is worth a second look.
   */
  it("completes a blocked task, and says it was blocked", async () => {
    const blocker = await task({ title: "Blocker" });
    const blocked = await task({ title: "Blocked" });
    await prismaUnsafe.taskDependency.create({
      data: { workspaceId, taskId: blocked.id, blockedById: blocker.id },
    });

    const res = await bulkCompleteTasks(workspaceId, memberId, [blocked.id]);
    expect(res.applied).toBe(1);
    expect(res.skipped.some((s) => /waiting on/i.test(s.reason))).toBe(true);
    expect((await prismaUnsafe.task.findUnique({ where: { id: blocked.id } }))!.doneAt).not.toBeNull();
  });

  it("records an undo that puts them all back", async () => {
    const rows = await Promise.all([task(), task()]);
    const res = await bulkCompleteTasks(workspaceId, memberId, rows.map((t) => t.id));
    expect(res.undoId).toBeTruthy();

    const { undo } = await import("../../src/modules/undo/store");
    const undone = await undo(workspaceId, memberId, res.undoId!);
    expect(undone.ok).toBe(true);
    for (const row of rows) {
      expect((await prismaUnsafe.task.findUnique({ where: { id: row.id } }))!.doneAt).toBeNull();
    }
  });
});

describe("assigning many", () => {
  it("assigns to an active member", async () => {
    const rows = await Promise.all([task(), task()]);
    const res = await bulkAssignTasks(workspaceId, memberId, rows.map((t) => t.id), memberId);
    expect(res.applied).toBe(2);
  });

  /** One person, one refusal — a hundred identical reasons is not a report. */
  it("refuses a suspended member for every row, once", async () => {
    const rows = await Promise.all([task(), task()]);
    const res = await bulkAssignTasks(workspaceId, memberId, rows.map((t) => t.id), suspendedId);
    expect(res.applied).toBe(0);
    expect(new Set(res.skipped.map((s) => s.reason)).size).toBe(1);
    expect(res.skipped[0]!.reason).toMatch(/suspended/i);
  });

  it("refuses somebody who is not in this workspace", async () => {
    const stranger = await user("bulk-stranger@ventureco.test");
    const rows = await Promise.all([task()]);
    const res = await bulkAssignTasks(workspaceId, memberId, rows.map((t) => t.id), stranger.id);
    expect(res.applied).toBe(0);
    expect(res.skipped[0]!.reason).toMatch(/not in this workspace/i);
  });
});

describe("dates and priorities", () => {
  it("refuses a due date that falls before a task's own start", async () => {
    const ok = await task();
    const clash = await task({ startAt: new Date("2026-11-01T12:00:00Z") });
    const res = await bulkSetTaskDue(workspaceId, memberId, [ok.id, clash.id], "2026-10-01");
    expect(res.applied).toBe(1);
    expect(res.skipped.some((s) => /starts after/i.test(s.reason))).toBe(true);
  });

  it("refuses a value that is not a date at all", async () => {
    const row = await task();
    const res = await bulkSetTaskDue(workspaceId, memberId, [row.id], "soon");
    expect(res.applied).toBe(0);
  });

  it("refuses a priority that does not exist", async () => {
    const row = await task();
    const res = await bulkSetTaskPriority(workspaceId, memberId, [row.id], "catastrophic");
    expect(res.applied).toBe(0);
  });
});

describe("tagging many", () => {
  it("adds a tag and skips the ones that already carry it", async () => {
    const plain = await task();
    const tagged = await task({ tags: ["seo"] });
    const res = await bulkTagTasks(workspaceId, memberId, [plain.id, tagged.id], "seo");
    expect(res.applied).toBe(1);
    expect(res.skipped.some((s) => /already tagged/i.test(s.reason))).toBe(true);
  });

  it("refuses to push a task past the twelve-tag limit", async () => {
    const full = await task({ tags: Array.from({ length: 12 }, (_, i) => `t${i}`) });
    const res = await bulkTagTasks(workspaceId, memberId, [full.id], "one-more");
    expect(res.applied).toBe(0);
    expect(res.skipped[0]!.reason).toMatch(/twelve/i);
  });
});

describe("moving many into a column", () => {
  it("moves the ones on this board", async () => {
    const rows = await Promise.all([task(), task()]);
    const res = await bulkMoveTasksToSection(workspaceId, memberId, rows.map((t) => t.id), later);
    expect(res.applied).toBe(2);
    expect(
      (await prismaUnsafe.task.findUnique({ where: { id: rows[0]!.id } }))!.sectionId,
    ).toBe(later);
  });

  /**
   * A section belongs to a board. Moving a card from another board into this
   * column would leave it with a section that is not on its own board — a row
   * the board query cannot render.
   */
  it("refuses a task that lives on a different board", async () => {
    const foreign = await prismaUnsafe.task.create({
      data: { workspaceId, boardId: otherBoardId, sectionId: elsewhere, title: "Foreign" },
    });
    const res = await bulkMoveTasksToSection(workspaceId, memberId, [foreign.id], later);
    expect(res.applied).toBe(0);
    expect(res.skipped[0]!.reason).toMatch(/different board/i);
    expect((await prismaUnsafe.task.findUnique({ where: { id: foreign.id } }))!.boardId).toBe(
      otherBoardId,
    );
  });

  it("refuses a column that has gone", async () => {
    const row = await task();
    const res = await bulkMoveTasksToSection(workspaceId, memberId, [row.id], "no-such-section");
    expect(res.applied).toBe(0);
  });
});

describe("deleting many", () => {
  /** Reported before it happens: nobody should delete a parent thinking it was a leaf. */
  it("says how many subtasks go with a parent", async () => {
    const parent = await task({ title: "Doomed parent" });
    await prismaUnsafe.task.create({
      data: { workspaceId, boardId, sectionId: doing, title: "Doomed child", parentId: parent.id },
    });
    const res = await bulkDeleteTasks(workspaceId, [parent.id]);
    expect(res.applied).toBe(1);
    expect(res.skipped.some((s) => /1 subtask/.test(s.reason))).toBe(true);
    expect(await prismaUnsafe.task.count({ where: { title: "Doomed child" } })).toBe(0);
  });
});

/** The tenant guard, from the other side. */
describe("another workspace's rows", () => {
  it("cannot be touched", async () => {
    const theirs = await prismaUnsafe.task.create({
      data: { workspaceId: otherWorkspaceId, title: "Theirs" },
    });
    for (const res of [
      await bulkCompleteTasks(workspaceId, memberId, [theirs.id]),
      await bulkSetTaskPriority(workspaceId, memberId, [theirs.id], "urgent"),
      await bulkDeleteTasks(workspaceId, [theirs.id]),
    ]) {
      expect(res.applied).toBe(0);
    }
    expect(await prismaUnsafe.task.count({ where: { id: theirs.id } })).toBe(1);
  });
});
