import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { DIGEST_HOUR, localHourFor, processTaskDigests } from "../../src/modules/tasks/digest-job";

/**
 * The start-of-day task email, against a real database (P8/2).
 *
 * The email BODY is covered by the pure tests in `test/unit/task-digest.ts` —
 * bucketing, ordering, the subject line. What needs a database is who gets one
 * at all, and the guarantee that an hourly sweep sends once a day rather than
 * twelve times.
 */
const WS = "Task Digest WS";
const EMAIL = "digest-member@ventureco.test";
const OTHER = "digest-other@ventureco.test";
let workspaceId = "";
let userId = "";
let otherId = "";
let boardId = "";

/** 06:00 UTC is 07:00 in Budapest — the hour the digest aims at. */
const AT_SEVEN_CET = new Date("2026-11-10T06:00:00Z");

async function ensure() {
  const existing = await prismaUnsafe.workspace.findFirst({ where: { name: WS } });
  const ws = existing ?? (await prismaUnsafe.workspace.create({ data: { name: WS } }));
  workspaceId = ws.id;

  for (const [email, name] of [
    [EMAIL, "Digest Member"],
    [OTHER, "Digest Other"],
  ] as const) {
    const user = await prismaUnsafe.user.upsert({
      where: { email },
      update: { timezone: "Europe/Budapest" },
      create: { email, name, passwordHash: "x", timezone: "Europe/Budapest" },
    });
    await prismaUnsafe.membership.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
      update: { role: "BDR", suspendedAt: null },
      create: { userId: user.id, workspaceId, role: "BDR", grants: [] },
    });
    if (email === EMAIL) userId = user.id;
    else otherId = user.id;
  }

  const board =
    (await prismaUnsafe.taskBoard.findFirst({ where: { workspaceId } })) ??
    (await prismaUnsafe.taskBoard.create({ data: { workspaceId, name: "Digest Board" } }));
  boardId = board.id;
}

async function clear() {
  if (!workspaceId) return;
  await prismaUnsafe.task.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.notification.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.notificationPreference.deleteMany({ where: { workspaceId } });
}

beforeEach(async () => {
  await ensure();
  await clear();
});

afterAll(async () => {
  await clear();
  await prismaUnsafe.taskBoard.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.membership.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.user.deleteMany({ where: { email: { in: [EMAIL, OTHER] } } });
  await prismaUnsafe.workspace.deleteMany({ where: { name: WS } });
});

async function makeTask(
  assignee: string | null,
  dueAt: Date | null,
  title = "Do the thing",
  createdAt?: Date,
) {
  return prismaUnsafe.task.create({
    data: {
      workspaceId,
      boardId,
      title,
      position: Math.random() * 100_000,
      assigneeId: assignee,
      dueAt,
      // Set explicitly where a test cares: the "new on your plate" bucket is
      // relative to the digest's own `now`, which these tests move around.
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

const daysFrom = (base: Date, n: number) => new Date(base.getTime() + n * 86_400_000);

describe("whose morning it is", () => {
  it("reads the local hour from the person's own timezone", () => {
    // The column stores an IANA name, not an offset, so this is right on both
    // sides of a daylight-saving change.
    expect(localHourFor("Europe/Budapest", AT_SEVEN_CET)).toBe(DIGEST_HOUR);
    // Same instant, different person: not their morning yet.
    expect(localHourFor("America/New_York", AT_SEVEN_CET)).toBe(1);
    expect(localHourFor("UTC", AT_SEVEN_CET)).toBe(6);
  });

  it("degrades an unknown zone to UTC rather than throwing", () => {
    // A digest an hour early is a nuisance; a sweep that dies is a feature
    // nobody gets.
    expect(localHourFor("Mars/Olympus", AT_SEVEN_CET)).toBe(6);
    expect(localHourFor(null, AT_SEVEN_CET)).toBe(6);
  });
});

describe("sending it", () => {
  it("sends to somebody with work due, and records it once", async () => {
    await makeTask(userId, daysFrom(AT_SEVEN_CET, -2), "Late one");
    await makeTask(userId, new Date("2026-11-10T15:00:00Z"), "Due today");

    const sent = await processTaskDigests(AT_SEVEN_CET);
    expect(sent).toBe(1);

    const rows = await prismaUnsafe.notification.findMany({ where: { workspaceId, userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toContain("késésben");
    expect(rows[0]!.body).toContain("mára");
    // Marked read: the email is the delivery, and it should not sit in the
    // badge next to notifications about things that actually happened.
    expect(rows[0]!.readAt).not.toBeNull();
  });

  it("sends once a day however often the sweep runs", async () => {
    await makeTask(userId, daysFrom(AT_SEVEN_CET, -1));

    expect(await processTaskDigests(AT_SEVEN_CET)).toBe(1);
    // The same hour again — a retried BullMQ job, or a second worker.
    expect(await processTaskDigests(AT_SEVEN_CET)).toBe(0);
    // And an hour later, still the same local day.
    expect(await processTaskDigests(new Date("2026-11-10T07:00:00Z"))).toBe(0);

    expect(await prismaUnsafe.notification.count({ where: { workspaceId, userId } })).toBe(1);
  });

  it("sends again the next day", async () => {
    await makeTask(userId, daysFrom(AT_SEVEN_CET, -1));
    expect(await processTaskDigests(AT_SEVEN_CET)).toBe(1);
    expect(await processTaskDigests(new Date("2026-11-11T06:00:00Z"))).toBe(1);
    expect(await prismaUnsafe.notification.count({ where: { workspaceId, userId } })).toBe(2);
  });

  it("stays quiet when there is nothing due", async () => {
    // A daily message that says "nothing due" trains people to filter the ones
    // that matter, and this is the only mail that goes out on a timer.
    await makeTask(userId, daysFrom(AT_SEVEN_CET, 30), "Miles away");
    expect(await processTaskDigests(AT_SEVEN_CET)).toBe(0);
    expect(await prismaUnsafe.notification.count({ where: { workspaceId } })).toBe(0);
  });

  it("stays quiet outside the recipient's own morning", async () => {
    await makeTask(userId, daysFrom(AT_SEVEN_CET, -1));
    // 14:00 in Budapest.
    expect(await processTaskDigests(new Date("2026-11-10T13:00:00Z"))).toBe(0);
  });

  it("never mails somebody else's tasks", async () => {
    await makeTask(otherId, daysFrom(AT_SEVEN_CET, -1), "Not mine");
    const sent = await processTaskDigests(AT_SEVEN_CET);
    // The other member gets theirs; the first member has nothing and is silent.
    expect(sent).toBe(1);
    const rows = await prismaUnsafe.notification.findMany({ where: { workspaceId } });
    expect(rows.map((r) => r.userId)).toEqual([otherId]);
  });

  it("skips an unassigned task entirely", async () => {
    // Nobody's morning. A digest that lists the whole board is a report.
    await makeTask(null, daysFrom(AT_SEVEN_CET, -1), "Unassigned");
    expect(await processTaskDigests(AT_SEVEN_CET)).toBe(0);
  });

  it("skips a task that is already done", async () => {
    const t = await makeTask(userId, daysFrom(AT_SEVEN_CET, -1));
    await prismaUnsafe.task.update({ where: { id: t.id }, data: { doneAt: new Date() } });
    expect(await processTaskDigests(AT_SEVEN_CET)).toBe(0);
  });

  it("respects the preference the person already set", async () => {
    /**
     * Reuses the existing matrix rather than adding a switch of its own.
     * Somebody who turned `task_due` email off has already said what they
     * want, and a second control that ignores the first is how a product ends
     * up mailing people who opted out.
     */
    await makeTask(userId, daysFrom(AT_SEVEN_CET, -1));
    await prismaUnsafe.notificationPreference.create({
      data: { workspaceId, userId, type: "task_due", emailDigest: false },
    });
    expect(await processTaskDigests(AT_SEVEN_CET)).toBe(0);
  });

  it("skips a suspended member", async () => {
    await makeTask(userId, daysFrom(AT_SEVEN_CET, -1));
    await prismaUnsafe.membership.update({
      where: { userId_workspaceId: { userId, workspaceId } },
      data: { suspendedAt: new Date() },
    });
    // Somebody stood down should not be getting a work list every morning.
    expect(await processTaskDigests(AT_SEVEN_CET)).toBe(0);
  });

  it("skips a read-only client account", async () => {
    await makeTask(userId, daysFrom(AT_SEVEN_CET, -1));
    await prismaUnsafe.membership.update({
      where: { userId_workspaceId: { userId, workspaceId } },
      data: { role: "CLIENT", clientCompanyId: null },
    });
    expect(await processTaskDigests(AT_SEVEN_CET)).toBe(0);
  });

  it("includes a task assigned yesterday that has no due date at all", async () => {
    // "New on your plate" is the fourth thing Asana's morning mail tells you,
    // and the one that stops a handover going unnoticed.
    await makeTask(userId, null, "Freshly handed over", new Date("2026-11-09T16:00:00Z"));
    const sent = await processTaskDigests(AT_SEVEN_CET);
    expect(sent).toBe(1);
    const row = await prismaUnsafe.notification.findFirst({ where: { workspaceId, userId } });
    expect(row!.body).toContain("új");
  });
});
