import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import {
  addChecklistItem,
  editChecklistItem,
  listChecklist,
  promoteToSubtask,
  removeChecklistItem,
  setChecklistItemDone,
} from "../../src/modules/tasks/checklist";
import { MAX_CHECKLIST_ITEMS } from "../../src/modules/tasks/checklist-logic";
import { loadBoard } from "../../src/modules/tasks/board-store";

/**
 * Checklists against a real database (playbook-v5 P20/3).
 *
 * The one that matters most is "7/7 does not complete the task". It is the
 * rule the playbook states outright, and it is the rule a well-meaning later
 * change is most likely to break — completing the parent when the last box is
 * ticked feels helpful right up to the moment somebody's task closes itself.
 */
const WS = "Checklist WS";
let workspaceId = "";
let boardId = "";
let taskId = "";

beforeAll(async () => {
  const ws =
    (await prismaUnsafe.workspace.findFirst({ where: { name: WS } })) ??
    (await prismaUnsafe.workspace.create({ data: { name: WS } }));
  workspaceId = ws.id;
  await prismaUnsafe.taskChecklistItem.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskBoard.deleteMany({ where: { workspaceId } });
  const board = await prismaUnsafe.taskBoard.create({
    data: { workspaceId, name: "Checklist board" },
  });
  boardId = board.id;
});

beforeEach(async () => {
  await prismaUnsafe.taskChecklistItem.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  const task = await prismaUnsafe.task.create({
    data: { workspaceId, boardId, title: "Launch the thing" },
  });
  taskId = task.id;
});

afterAll(async () => {
  await prismaUnsafe.taskChecklistItem.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskBoard.deleteMany({ where: { workspaceId } });
});

async function seed(texts: string[]) {
  const ids: string[] = [];
  for (const text of texts) {
    const res = await addChecklistItem(workspaceId, taskId, text);
    expect(res.ok).toBe(true);
    if (res.ok) ids.push(res.item.id);
  }
  return ids;
}

describe("adding steps", () => {
  it("keeps them in the order they were written", async () => {
    await seed(["Draft", "Review", "Ship"]);
    const items = await listChecklist(workspaceId, taskId);
    expect(items.map((i) => i.text)).toEqual(["Draft", "Review", "Ship"]);
    expect(items.map((i) => i.position)).toEqual([1024, 2048, 3072]);
  });

  it("refuses an empty step and a whitespace-only one", async () => {
    expect(await addChecklistItem(workspaceId, taskId, "   ")).toMatchObject({ ok: false });
    expect(await listChecklist(workspaceId, taskId)).toHaveLength(0);
  });

  it("refuses a step on a task that does not exist", async () => {
    const res = await addChecklistItem(workspaceId, "no-such-task", "Draft");
    expect(res).toMatchObject({ ok: false });
  });

  it("stops at fifty and says why", async () => {
    await prismaUnsafe.taskChecklistItem.createMany({
      data: Array.from({ length: MAX_CHECKLIST_ITEMS }, (_, i) => ({
        workspaceId,
        taskId,
        text: `Step ${i}`,
        position: (i + 1) * 1024,
      })),
    });
    const res = await addChecklistItem(workspaceId, taskId, "One more");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/several tasks/i);
    expect(await listChecklist(workspaceId, taskId)).toHaveLength(MAX_CHECKLIST_ITEMS);
  });
});

describe("ticking steps", () => {
  it("reports progress as it goes", async () => {
    const [a, b] = await seed(["Draft", "Review", "Ship"]);
    expect(await setChecklistItemDone(workspaceId, a, true)).toMatchObject({
      ok: true,
      progress: { done: 1, total: 3 },
    });
    expect(await setChecklistItemDone(workspaceId, b, true)).toMatchObject({
      ok: true,
      progress: { done: 2, total: 3 },
    });
    // And back off again.
    expect(await setChecklistItemDone(workspaceId, a, false)).toMatchObject({
      ok: true,
      progress: { done: 1, total: 3 },
    });
  });

  it("a checklist reaching 7/7 does not complete the task", async () => {
    const ids = await seed(["1", "2", "3", "4", "5", "6", "7"]);
    for (const id of ids) {
      const res = await setChecklistItemDone(workspaceId, id, true);
      expect(res.ok).toBe(true);
    }
    const last = await setChecklistItemDone(workspaceId, ids[6], true);
    expect(last).toMatchObject({ ok: true, progress: { done: 7, total: 7 } });

    const task = await prismaUnsafe.task.findUnique({
      where: { id: taskId },
      select: { doneAt: true },
    });
    expect(
      task?.doneAt,
      "ticking every step completed the task — deciding the work is finished belongs to a person",
    ).toBeNull();
  });

  it("refuses a step that has been removed underneath it", async () => {
    const [a] = await seed(["Draft"]);
    await removeChecklistItem(workspaceId, a);
    expect(await setChecklistItemDone(workspaceId, a, true)).toMatchObject({ ok: false });
  });
});

describe("editing and removing", () => {
  it("renames a step and refuses to blank it", async () => {
    const [a] = await seed(["Drft"]);
    expect(await editChecklistItem(workspaceId, a, "Draft")).toEqual({ ok: true });
    expect(await editChecklistItem(workspaceId, a, "  ")).toMatchObject({ ok: false });
    const items = await listChecklist(workspaceId, taskId);
    expect(items[0].text).toBe("Draft");
  });

  it("removes one step and leaves the rest", async () => {
    const [, b] = await seed(["Draft", "Review", "Ship"]);
    expect(await removeChecklistItem(workspaceId, b)).toEqual({ ok: true });
    const items = await listChecklist(workspaceId, taskId);
    expect(items.map((i) => i.text)).toEqual(["Draft", "Ship"]);
    expect(await removeChecklistItem(workspaceId, b)).toMatchObject({ ok: false });
  });

  it("takes the steps with the task when the task goes", async () => {
    await seed(["Draft", "Review"]);
    await prismaUnsafe.task.delete({ where: { id: taskId } });
    const orphans = await prismaUnsafe.taskChecklistItem.count({ where: { taskId } });
    expect(orphans, "checklist steps outlived their task").toBe(0);
  });
});

describe("promoting a step to a subtask", () => {
  it("creates the subtask and removes the step", async () => {
    const [, b] = await seed(["Draft", "Get legal to read it", "Ship"]);
    const res = await promoteToSubtask(workspaceId, b);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const subtask = await prismaUnsafe.task.findUnique({
      where: { id: res.subtaskId },
      select: { title: true, parentId: true, boardId: true, doneAt: true },
    });
    expect(subtask).toMatchObject({
      title: "Get legal to read it",
      parentId: taskId,
      boardId,
      doneAt: null,
    });

    // Not left ticked beside its own subtask: two records of one piece of
    // work is how a progress count starts lying.
    const items = await listChecklist(workspaceId, taskId);
    expect(items.map((i) => i.text)).toEqual(["Draft", "Ship"]);
  });

  it("keeps a ticked step ticked as a completed subtask", async () => {
    const [a] = await seed(["Already done"]);
    await setChecklistItemDone(workspaceId, a, true);
    const res = await promoteToSubtask(workspaceId, a);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const subtask = await prismaUnsafe.task.findUnique({
      where: { id: res.subtaskId },
      select: { doneAt: true },
    });
    expect(subtask?.doneAt, "a ticked step lost the fact it was done").not.toBeNull();
  });

  it("refuses on a subtask, rather than making a grandchild", async () => {
    const child = await prismaUnsafe.task.create({
      data: { workspaceId, boardId, title: "A subtask", parentId: taskId },
    });
    const res = await addChecklistItem(workspaceId, child.id, "A step within the subtask");
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const promoted = await promoteToSubtask(workspaceId, res.item.id);
    expect(promoted.ok).toBe(false);
    if (!promoted.ok) expect(promoted.error).toMatch(/already a subtask/i);
    // And the step survives the refusal — a failed promotion must not eat it.
    expect(await listChecklist(workspaceId, child.id)).toHaveLength(1);
  });
});

function cardFor(board: Awaited<ReturnType<typeof loadBoard>>, id: string) {
  const all = [...(board?.unsectioned ?? []), ...(board?.sections ?? []).flatMap((s) => s.tasks)];
  return all.find((t) => t.id === id);
}

describe("the board card", () => {
  it("carries the checklist count separately from the subtask count", async () => {
    const ids = await seed(["Draft", "Review", "Ship"]);
    await setChecklistItemDone(workspaceId, ids[0], true);
    await prismaUnsafe.task.create({
      data: { workspaceId, boardId, title: "A subtask", parentId: taskId },
    });

    const board = await loadBoard(workspaceId, boardId);
    const card = cardFor(board, taskId);
    expect(card?.checklist).toEqual({ done: 1, total: 3 });
    expect(card?.subtasks).toEqual({ done: 0, total: 1 });
  });

  it("carries no checklist at all on a task that has never had a step", async () => {
    const board = await loadBoard(workspaceId, boardId);
    const card = cardFor(board, taskId);
    expect(card?.checklist).toBeNull();
  });
});
