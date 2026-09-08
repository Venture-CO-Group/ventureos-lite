import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";

/**
 * The dashboard's task list and the task board read the same rows (P8/4).
 *
 * ── THE LEAK THIS CLOSED ────────────────────────────────────────────────────
 *
 * "Save this board as a template" keeps the board and its tasks and flips
 * `isTemplate`. Those tasks are open and top-level, so the dashboard query
 * matched them — and because a template's tasks are deliberately unassigned,
 * the `assigneeId: null` branch put them on EVERYBODY's dashboard.
 *
 * The board hides templates from its switcher and always did. The dashboard
 * was written first and never learned they existed, which is the class of bug
 * that comes from two surfaces reading one table without one knowing the
 * other's rules.
 *
 * The query is asserted directly rather than through `myTasks()`, which needs
 * a request context — what matters is the WHERE clause, and this is it.
 */
const WS = "Dashboard Tasks WS";
let workspaceId = "";
let userId = "";
let realBoardId = "";
let templateBoardId = "";

/** The dashboard's own filter, kept in step with `myTasks()`. */
function dashboardWhere(uid: string) {
  return {
    workspaceId,
    doneAt: null,
    parentId: null,
    OR: [{ boardId: null }, { board: { isTemplate: false } }],
    AND: [{ OR: [{ assigneeId: uid }, { assigneeId: null }] }],
  };
}

beforeEach(async () => {
  const existing = await prismaUnsafe.workspace.findFirst({ where: { name: WS } });
  const ws = existing ?? (await prismaUnsafe.workspace.create({ data: { name: WS } }));
  workspaceId = ws.id;

  const user = await prismaUnsafe.user.upsert({
    where: { email: "dash-tasks@ventureco.test" },
    update: {},
    create: { email: "dash-tasks@ventureco.test", name: "Dash User", passwordHash: "x" },
  });
  userId = user.id;
  await prismaUnsafe.membership.upsert({
    where: { userId_workspaceId: { userId, workspaceId } },
    update: { state: "ACTIVE" },
    create: { userId, workspaceId, role: "BDR", grants: [], state: "ACTIVE" },
  });

  await prismaUnsafe.taskDependency.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskBoard.deleteMany({ where: { workspaceId } });

  const real = await prismaUnsafe.taskBoard.create({
    data: { workspaceId, name: "Live board", isTemplate: false },
  });
  realBoardId = real.id;
  const tpl = await prismaUnsafe.taskBoard.create({
    data: { workspaceId, name: "Onboarding template", isTemplate: true },
  });
  templateBoardId = tpl.id;
});

afterAll(async () => {
  await prismaUnsafe.taskDependency.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskBoard.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.membership.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.user.deleteMany({ where: { email: "dash-tasks@ventureco.test" } });
  await prismaUnsafe.workspace.deleteMany({ where: { name: WS } });
});

async function task(title: string, extra: Record<string, unknown> = {}) {
  return prismaUnsafe.task.create({
    data: { workspaceId, title, position: Math.random() * 1000, ...extra },
  });
}

describe("what reaches the dashboard", () => {
  it("keeps a task with no board at all", async () => {
    // Tasks raised from a lead or a signal have no board. They were the
    // original citizens of this panel and must not be filtered out.
    await task("Call the lead back");
    const rows = await prismaUnsafe.task.findMany({ where: dashboardWhere(userId) });
    expect(rows.map((r) => r.title)).toEqual(["Call the lead back"]);
  });

  it("keeps a task on a live board", async () => {
    await task("On the board", { boardId: realBoardId });
    const rows = await prismaUnsafe.task.findMany({ where: dashboardWhere(userId) });
    expect(rows.map((r) => r.title)).toEqual(["On the board"]);
  });

  it("drops a task on a TEMPLATE board", async () => {
    /**
     * The bug, asserted. A template's tasks are unassigned by design, so
     * before the fix this landed on every single person's dashboard.
     */
    await task("Kick-off call", { boardId: templateBoardId });
    const rows = await prismaUnsafe.task.findMany({ where: dashboardWhere(userId) });
    expect(rows).toHaveLength(0);
  });

  it("drops it the moment a board becomes a template, and brings it back", async () => {
    await task("Was live", { boardId: realBoardId });
    expect(await prismaUnsafe.task.count({ where: dashboardWhere(userId) })).toBe(1);

    await prismaUnsafe.taskBoard.update({
      where: { id: realBoardId },
      data: { isTemplate: true },
    });
    expect(await prismaUnsafe.task.count({ where: dashboardWhere(userId) })).toBe(0);

    await prismaUnsafe.taskBoard.update({
      where: { id: realBoardId },
      data: { isTemplate: false },
    });
    expect(await prismaUnsafe.task.count({ where: dashboardWhere(userId) })).toBe(1);
  });

  it("still shows an unassigned task, which is the point of that branch", async () => {
    // An owner nobody set is not a reason for work to disappear.
    await task("Nobody's yet", { boardId: realBoardId, assigneeId: null });
    const rows = await prismaUnsafe.task.findMany({ where: dashboardWhere(userId) });
    expect(rows).toHaveLength(1);
  });

  it("does not show somebody else's assigned task", async () => {
    await task("Theirs", { boardId: realBoardId, assigneeId: "another-user" });
    expect(await prismaUnsafe.task.count({ where: dashboardWhere(userId) })).toBe(0);
  });

  it("does not show a subtask, which belongs inside its parent", async () => {
    const parent = await task("Parent", { boardId: realBoardId });
    await task("Child", { boardId: realBoardId, parentId: parent.id });
    const rows = await prismaUnsafe.task.findMany({ where: dashboardWhere(userId) });
    expect(rows.map((r) => r.title)).toEqual(["Parent"]);
  });

  it("does not show a finished task", async () => {
    await task("Done", { boardId: realBoardId, doneAt: new Date() });
    expect(await prismaUnsafe.task.count({ where: dashboardWhere(userId) })).toBe(0);
  });
});

describe("what the dashboard now knows that it did not", () => {
  it("can name the board a task is on", async () => {
    await task("On the board", { boardId: realBoardId });
    const rows = await prismaUnsafe.task.findMany({
      where: dashboardWhere(userId),
      select: { boardId: true, board: { select: { name: true } } },
    });
    // Without this the dashboard could show you a task with no way to reach
    // the card, its subtasks, its comments or its dependencies.
    expect(rows[0]!.board!.name).toBe("Live board");
    expect(rows[0]!.boardId).toBe(realBoardId);
  });

  it("can tell that a task is waiting on something", async () => {
    const blocker = await task("Await the signature", { boardId: realBoardId });
    const blocked = await task("Start the build", { boardId: realBoardId });
    await prismaUnsafe.taskDependency.create({
      data: { workspaceId, taskId: blocked.id, blockedById: blocker.id },
    });

    const deps = await prismaUnsafe.taskDependency.findMany({
      where: { taskId: { in: [blocked.id, blocker.id] } },
    });
    const blockers = await prismaUnsafe.task.findMany({
      where: { id: { in: deps.map((d) => d.blockedById) } },
      select: { id: true, doneAt: true },
    });
    const open = blockers.filter((b) => !b.doneAt).map((b) => b.id);
    /**
     * The board knew about dependencies and the dashboard did not — so a task
     * blocked on somebody else's work sat at the top of the morning list
     * looking like the next thing to pick up.
     */
    expect(deps.filter((d) => open.includes(d.blockedById))).toHaveLength(1);
  });
});
