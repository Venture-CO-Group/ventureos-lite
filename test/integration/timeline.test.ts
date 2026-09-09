import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { cyclePath, wouldCycle } from "../../src/modules/tasks/board-logic";

/**
 * The dependency graph, against a real database (playbook-v5 P19/1).
 *
 * ── WHY THE NAMING MATTERS ──────────────────────────────────────────────────
 *
 * "That would make a loop" was enough for a form with two dropdowns. On the
 * timeline somebody draws a dependency between two bars, and with fifteen
 * tasks on screen the useful question is WHICH chain — so the refusal walks it
 * and names every task in it.
 */
const WS = "Timeline WS";
let workspaceId = "";

beforeAll(async () => {
  const ws =
    (await prismaUnsafe.workspace.findFirst({ where: { name: WS } })) ??
    (await prismaUnsafe.workspace.create({ data: { name: WS } }));
  workspaceId = ws.id;
  await prismaUnsafe.taskDependency.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
});

afterAll(async () => {
  await prismaUnsafe.taskDependency.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
});

async function task(title: string) {
  return prismaUnsafe.task.create({ data: { workspaceId, title } });
}

describe("naming a cycle", () => {
  it("walks the chain it would close, from the task back to itself", async () => {
    const a = await task("Design");
    const b = await task("Build");
    const c = await task("Launch");
    // Launch waits for Build, Build waits for Design.
    const edges = [
      { taskId: c.id, blockedById: b.id },
      { taskId: b.id, blockedById: a.id },
    ];

    // Asking Design to wait for Launch closes the loop.
    const chain = cyclePath(edges, a.id, c.id);
    expect(chain).not.toBeNull();
    expect(chain![0]).toBe(a.id);
    expect(chain!.at(-1)).toBe(a.id);
    // Every task in the loop is named, so the message can print them.
    expect(new Set(chain!)).toEqual(new Set([a.id, b.id, c.id]));
  });

  it("finds the shortest loop rather than whichever one it stumbled on", async () => {
    const a = await task("A");
    const b = await task("B");
    const c = await task("C");
    const d = await task("D");
    const edges = [
      // A short way back: B waits for A.
      { taskId: b.id, blockedById: a.id },
      // And a long way: D waits for C, C waits for A.
      { taskId: c.id, blockedById: a.id },
      { taskId: d.id, blockedById: c.id },
    ];
    const chain = cyclePath(edges, a.id, b.id);
    // a → b → a, not a → c → d → … → a.
    expect(chain).toEqual([a.id, b.id, a.id]);
  });

  it("says a task waiting for itself is a loop of one", async () => {
    const a = await task("Alone");
    expect(cyclePath([], a.id, a.id)).toEqual([a.id, a.id]);
  });

  it("returns nothing for an edge that is perfectly fine", async () => {
    const a = await task("First");
    const b = await task("Second");
    expect(cyclePath([], b.id, a.id)).toBeNull();
  });

  /** One traversal, one answer: the boolean is the path question asked again. */
  it("agrees with wouldCycle, always", async () => {
    const a = await task("X");
    const b = await task("Y");
    const edges = [{ taskId: b.id, blockedById: a.id }];
    for (const [taskId, blockedById] of [
      [a.id, b.id],
      [b.id, a.id],
      [a.id, a.id],
    ] as const) {
      expect(wouldCycle(edges, taskId, blockedById)).toBe(
        cyclePath(edges, taskId, blockedById) !== null,
      );
    }
  });
});
