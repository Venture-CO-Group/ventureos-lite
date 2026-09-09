import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { getFieldValues, listFieldDefs, setFieldValues } from "../../src/modules/fields/store";

/**
 * Custom fields on tasks (playbook-v5 P20/2).
 *
 * ── THE BUG THIS FOUND ──────────────────────────────────────────────────────
 *
 * `setFieldValues` dispatched on the entity with a ternary chain ending in
 * `: db.deal…`, so ANY entity the chain did not name fell through to deals.
 * Adding `task` to FIELD_ENTITIES therefore sent every task field write
 * looking for a DEAL with that id — it found nothing and reported "not found",
 * and would have written to the wrong table had an id ever collided. The
 * dispatch is an exhaustive switch now, so the next entity is a compile error
 * rather than a silent cross-entity write.
 */
const WS = "Task Fields WS";
let workspaceId = "";
let taskId = "";
let boardId = "";

beforeAll(async () => {
  const ws =
    (await prismaUnsafe.workspace.findFirst({ where: { name: WS } })) ??
    (await prismaUnsafe.workspace.create({ data: { name: WS } }));
  workspaceId = ws.id;
  await prismaUnsafe.customFieldDef.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskBoard.deleteMany({ where: { workspaceId } });

  boardId = (
    await prismaUnsafe.taskBoard.create({ data: { workspaceId, name: "Fields board" } })
  ).id;
  taskId = (
    await prismaUnsafe.task.create({ data: { workspaceId, boardId, title: "Subject" } })
  ).id;

  await prismaUnsafe.customFieldDef.create({
    data: {
      workspaceId,
      entity: "task",
      key: "segment",
      label: "Segment",
      type: "SELECT",
      options: [
        { value: "smb", label: "SMB" },
        { value: "enterprise", label: "Enterprise" },
      ],
      position: 0,
    },
  });
  await prismaUnsafe.customFieldDef.create({
    data: {
      workspaceId,
      entity: "task",
      key: "effort",
      label: "Effort",
      type: "NUMBER",
      position: 1,
    },
  });
});

afterAll(async () => {
  await prismaUnsafe.customFieldDef.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskBoard.deleteMany({ where: { workspaceId } });
});

describe("a task's own fields", () => {
  it("lists only the task-scoped definitions", async () => {
    const defs = await listFieldDefs(workspaceId, "task");
    expect(defs.map((d) => d.key).sort()).toEqual(["effort", "segment"]);
  });

  /** The write that used to go looking for a deal. */
  it("writes a value onto the TASK, not another entity", async () => {
    const res = await setFieldValues(workspaceId, "task", taskId, { segment: "enterprise" });
    expect(res.ok).toBe(true);

    const row = await prismaUnsafe.task.findUnique({ where: { id: taskId } });
    expect((row!.customFields as Record<string, unknown>).segment).toBe("enterprise");
    expect(await getFieldValues(workspaceId, "task", taskId)).toMatchObject({
      segment: "enterprise",
    });
  });

  it("merges rather than replacing the whole blob", async () => {
    await setFieldValues(workspaceId, "task", taskId, { segment: "smb" });
    await setFieldValues(workspaceId, "task", taskId, { effort: 3 });
    const values = await getFieldValues(workspaceId, "task", taskId);
    expect(values.segment).toBe("smb");
    expect(values.effort).toBe(3);
  });

  /** The shared validator, which is the reason not to have a second one. */
  it("refuses an option the definition does not offer", async () => {
    const res = await setFieldValues(workspaceId, "task", taskId, { segment: "government" });
    expect(res.ok).toBe(false);
  });

  it("refuses text in a number field", async () => {
    const res = await setFieldValues(workspaceId, "task", taskId, { effort: "loads" });
    expect(res.ok).toBe(false);
  });

  it("reports a task that does not exist rather than writing elsewhere", async () => {
    const res = await setFieldValues(workspaceId, "task", "no-such-task", { segment: "smb" });
    expect(res.ok).toBe(false);
  });

  /**
   * The entities stay apart: a task-scoped definition is not offered for a
   * lead, and vice versa.
   */
  it("keeps the entities' definitions separate", async () => {
    await prismaUnsafe.customFieldDef.create({
      data: {
        workspaceId,
        entity: "lead",
        key: "segment",
        label: "Lead segment",
        type: "TEXT",
        position: 0,
      },
    });
    const taskDefs = await listFieldDefs(workspaceId, "task");
    const leadDefs = await listFieldDefs(workspaceId, "lead");
    expect(taskDefs.find((d) => d.key === "segment")!.type).toBe("SELECT");
    expect(leadDefs.find((d) => d.key === "segment")!.type).toBe("TEXT");
  });
});
