import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import {
  addManualEntry,
  boardTimeReport,
  deleteEntry,
  loggedMinutesFor,
  runningTimerFor,
  startTimer,
  stopTimer,
  taskTime,
  timeEntriesForExport,
  weeklyTime,
} from "../../src/modules/tasks/time-store";

/**
 * Estimates and time, against a real database (playbook-v5 P20/1).
 *
 * The arithmetic is covered in test/unit/time-logic.test.ts. These are the
 * guarantees that only a database can make: one running timer per person, a
 * roll-up that matches a hand-checked fixture, and time that is visible to the
 * removal report and the export.
 */
const WS = "Time WS";
let workspaceId = "";
let boardId = "";
let parentId = "";
const userId = "time-user";
const otherUserId = "time-other";

beforeAll(async () => {
  const ws =
    (await prismaUnsafe.workspace.findFirst({ where: { name: WS } })) ??
    (await prismaUnsafe.workspace.create({ data: { name: WS } }));
  workspaceId = ws.id;
  await prismaUnsafe.timeEntry.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskBoard.deleteMany({ where: { workspaceId } });
  const board = await prismaUnsafe.taskBoard.create({
    data: { workspaceId, name: "Time board" },
  });
  boardId = board.id;
});

beforeEach(async () => {
  await prismaUnsafe.timeEntry.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  const parent = await prismaUnsafe.task.create({
    data: { workspaceId, boardId, title: "Parent" },
  });
  parentId = parent.id;
});

afterAll(async () => {
  await prismaUnsafe.timeEntry.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.taskBoard.deleteMany({ where: { workspaceId } });
});

const at = (h: number, m = 0) => new Date(2026, 8, 9, h, m, 0, 0);

async function subtask(estimateMinutes: number | null) {
  return prismaUnsafe.task.create({
    data: { workspaceId, boardId, title: "Sub", parentId, estimateMinutes },
  });
}

describe("the timer", () => {
  it("starts, and reports the minutes as they pass", async () => {
    const started = await startTimer(workspaceId, userId, parentId, at(9));
    expect(started.ok).toBe(true);

    const running = await runningTimerFor(workspaceId, userId, at(10, 30));
    expect(running).not.toBeNull();
    expect(running!.taskId).toBe(parentId);
    expect(running!.minutesSoFar).toBe(90);
  });

  /**
   * ONE PER PERSON, and the database enforces it with a partial unique index —
   * so two tabs racing to start cannot produce two rows.
   */
  it("keeps at most one running entry per person, at the database level", async () => {
    await startTimer(workspaceId, userId, parentId, at(9));
    const second = await prismaUnsafe.task.create({
      data: { workspaceId, boardId, title: "Second" },
    });
    await startTimer(workspaceId, userId, second.id, at(10));

    const openRows = await prismaUnsafe.timeEntry.count({
      where: { workspaceId, userId, endedAt: null },
    });
    expect(openRows).toBe(1);

    // Writing a second open row directly is refused by the index.
    await expect(
      prismaUnsafe.timeEntry.create({
        data: { workspaceId, taskId: parentId, userId, startedAt: at(11) },
      }),
    ).rejects.toThrow();
  });

  /**
   * Starting a second timer STOPS the first rather than refusing. Somebody who
   * has moved on has moved on, and a rule that makes them go back first is a
   * rule that teaches people to stop using the timer. It is reported, not
   * silent.
   */
  it("stops the previous task and says which", async () => {
    await startTimer(workspaceId, userId, parentId, at(9));
    const second = await prismaUnsafe.task.create({
      data: { workspaceId, boardId, title: "Second thing" },
    });
    const res = await startTimer(workspaceId, userId, second.id, at(10));
    expect(res.ok && res.stoppedPrevious).toBe("Parent");

    // And the first entry was closed with its real elapsed minutes.
    const closed = await prismaUnsafe.timeEntry.findFirst({
      where: { taskId: parentId, endedAt: { not: null } },
    });
    expect(closed!.minutes).toBe(60);
  });

  it("is idempotent when the same task is started twice", async () => {
    const first = await startTimer(workspaceId, userId, parentId, at(9));
    const again = await startTimer(workspaceId, userId, parentId, at(9, 30));
    expect(again.ok && again.entryId).toBe(first.ok && first.entryId);
    expect(
      await prismaUnsafe.timeEntry.count({ where: { workspaceId, userId } }),
    ).toBe(1);
  });

  it("does not confuse two people's timers", async () => {
    await startTimer(workspaceId, userId, parentId, at(9));
    await startTimer(workspaceId, otherUserId, parentId, at(9, 15));
    expect((await runningTimerFor(workspaceId, userId, at(10)))!.minutesSoFar).toBe(60);
    expect((await runningTimerFor(workspaceId, otherUserId, at(10)))!.minutesSoFar).toBe(45);
  });

  it("refuses to stop when nothing is running", async () => {
    const res = await stopTimer(workspaceId, userId, at(10));
    expect(res.ok).toBe(false);
  });

  it("refuses a task that does not exist", async () => {
    const res = await startTimer(workspaceId, userId, "no-such-task", at(9));
    expect(res.ok).toBe(false);
  });
});

describe("manual entries", () => {
  it("records minutes with a note", async () => {
    const res = await addManualEntry(workspaceId, userId, {
      taskId: parentId,
      minutes: 45,
      day: at(9),
      note: "Reviewing the brief",
    });
    expect(res.ok).toBe(true);
    const row = await prismaUnsafe.timeEntry.findFirst({ where: { taskId: parentId } });
    expect(row!.minutes).toBe(45);
    expect(row!.note).toBe("Reviewing the brief");
    // Closed on arrival: a manual entry is not a running timer.
    expect(row!.endedAt).not.toBeNull();
  });

  it("refuses zero or negative minutes", async () => {
    for (const minutes of [0, -30]) {
      const res = await addManualEntry(workspaceId, userId, {
        taskId: parentId,
        minutes,
        day: at(9),
      });
      expect(res.ok).toBe(false);
    }
  });

  /** Somebody's own time is theirs to correct; another person's is not. */
  it("lets somebody delete their own entry and nobody else's", async () => {
    const mine = await addManualEntry(workspaceId, userId, {
      taskId: parentId,
      minutes: 30,
      day: at(9),
    });
    if (!mine.ok) throw new Error("setup failed");

    expect((await deleteEntry(workspaceId, otherUserId, mine.entryId)).ok).toBe(false);
    expect((await deleteEntry(workspaceId, userId, mine.entryId)).ok).toBe(true);
  });
});

/**
 * The roll-up, against a hand-checked fixture — which is what the playbook
 * asks for by name.
 */
describe("estimates", () => {
  it("sums the subtasks when the parent has no estimate of its own", async () => {
    await subtask(120);
    await subtask(90);
    await subtask(null);

    const time = (await taskTime(workspaceId, parentId))!;
    // 2h + 1.5h = 210 minutes. The unestimated subtask contributes nothing and
    // does not make the total null.
    expect(time.estimate.fromSubtasks).toBe(210);
    expect(time.estimate.minutes).toBe(210);
    expect(time.estimate.mode).toBe("subtasks");
  });

  it("prefers the parent's own estimate, and still reports the sum", async () => {
    await subtask(120);
    await subtask(90);
    await prismaUnsafe.task.update({
      where: { id: parentId },
      data: { estimateMinutes: 240 },
    });

    const time = (await taskTime(workspaceId, parentId))!;
    expect(time.estimate.minutes).toBe(240);
    expect(time.estimate.mode).toBe("own");
    // Both are shown, so a parent estimated at 4h whose subtasks add to 3.5h
    // is visible as a disagreement rather than hidden.
    expect(time.estimate.fromSubtasks).toBe(210);
  });

  it("has no estimate at all when neither exists", async () => {
    const time = (await taskTime(workspaceId, parentId))!;
    expect(time.estimate.minutes).toBeNull();
    expect(time.estimate.mode).toBe("none");
    expect(time.variance.ratio).toBeNull();
  });

  it("computes the variance against logged time", async () => {
    await prismaUnsafe.task.update({
      where: { id: parentId },
      data: { estimateMinutes: 120 },
    });
    await addManualEntry(workspaceId, userId, { taskId: parentId, minutes: 180, day: at(9) });

    const time = (await taskTime(workspaceId, parentId))!;
    expect(time.actualMinutes).toBe(180);
    expect(time.variance.deltaMinutes).toBe(60);
    expect(time.variance.ratio).toBeCloseTo(1.5);
  });
});

describe("the board report", () => {
  /**
   * `estimatedTasks` is reported beside the totals because a board where three
   * of forty tasks are estimated has a variance that means almost nothing, and
   * the reader has to be able to see that.
   */
  it("says how much of the board is estimated at all", async () => {
    await prismaUnsafe.task.update({ where: { id: parentId }, data: { estimateMinutes: 60 } });
    await prismaUnsafe.task.create({ data: { workspaceId, boardId, title: "Unestimated" } });
    await addManualEntry(workspaceId, userId, { taskId: parentId, minutes: 90, day: at(9) });

    const report = await boardTimeReport(workspaceId, boardId);
    expect(report.estimateMinutes).toBe(60);
    expect(report.actualMinutes).toBe(90);
    expect(report.estimatedTasks).toBe(1);
    expect(report.totalTasks).toBe(2);
  });
});

describe("what the rest of the system can see", () => {
  it("gives a person's week, by day", async () => {
    await addManualEntry(workspaceId, userId, { taskId: parentId, minutes: 60, day: at(9) });
    await addManualEntry(workspaceId, userId, {
      taskId: parentId,
      minutes: 30,
      day: new Date(2026, 8, 10, 9),
    });

    const week = await weeklyTime(workspaceId, userId, new Date(2026, 8, 7), new Date(2026, 8, 14));
    expect(week.totalMinutes).toBe(90);
    expect(week.byDay["2026-09-09"]).toBe(60);
    expect(week.byDay["2026-09-10"]).toBe(30);
  });

  it("exports every entry with its task and note", async () => {
    await addManualEntry(workspaceId, userId, {
      taskId: parentId,
      minutes: 45,
      day: at(9),
      note: "Notes",
    });
    const rows = await timeEntriesForExport(workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.taskTitle).toBe("Parent");
    expect(rows[0]!.note).toBe("Notes");
  });

  /** So a removal impact report can say what leaves with somebody. */
  it("totals one person's logged time", async () => {
    await addManualEntry(workspaceId, userId, { taskId: parentId, minutes: 60, day: at(9) });
    await addManualEntry(workspaceId, otherUserId, { taskId: parentId, minutes: 30, day: at(9) });
    expect(await loggedMinutesFor(workspaceId, userId)).toBe(60);
    expect(await loggedMinutesFor(workspaceId, otherUserId)).toBe(30);
  });
});
