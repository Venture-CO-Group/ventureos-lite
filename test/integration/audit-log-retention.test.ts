import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { processAuditLogRetention } from "../../src/modules/auditlog/jobs";

/**
 * The nightly audit-log sweep, against the real database (P5/5.3).
 *
 * Two properties are worth a real database rather than a mock:
 *
 *   - the sweep must not cross workspaces. One workspace choosing 90 days must
 *     not touch a workspace that keeps everything.
 *   - the sweep must leave a row behind. A retention job that silently removes
 *     audit rows is indistinguishable, after the fact, from somebody covering
 *     their tracks — the `audit_log.pruned` entry is the only account of the
 *     gap it made.
 */
const MARK = "retention-test.marker";
let keeper = "";
let pruner = "";

async function ensureWorkspaces() {
  const names = ["Retention Keeper WS", "Retention Pruner WS"];
  const ids: string[] = [];
  for (const name of names) {
    const existing = await prismaUnsafe.workspace.findFirst({ where: { name } });
    const ws =
      existing ??
      (await prismaUnsafe.workspace.create({ data: { name } }));
    ids.push(ws.id);
  }
  [keeper, pruner] = ids as [string, string];
}

async function clear() {
  await prismaUnsafe.auditLog.deleteMany({
    where: { workspaceId: { in: [keeper, pruner].filter(Boolean) } },
  });
}

beforeEach(async () => {
  await ensureWorkspaces();
  await clear();
  // Keeper keeps everything (the default: no flag at all).
  await prismaUnsafe.workspace.update({ where: { id: keeper }, data: { featureFlags: {} } });
  await prismaUnsafe.workspace.update({
    where: { id: pruner },
    data: { featureFlags: { auditLogRetentionDays: 90 } },
  });
});

afterAll(async () => {
  await clear();
  /**
   * The workspaces themselves go too.
   *
   * A leftover workspace is not a harmless test artefact here: more than one
   * workspace breaks `getPublicIntakeWorkspaceId()`, which is how three
   * "Provision Test" rows from an earlier test of mine took two unrelated
   * specs down with them.
   */
  await prismaUnsafe.workspace.deleteMany({
    where: { name: { in: ["Retention Keeper WS", "Retention Pruner WS"] } },
  });
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function log(workspaceId: string, at: Date, action = MARK) {
  await prismaUnsafe.auditLog.create({ data: { workspaceId, action, at } });
}

describe("the nightly audit-log sweep", () => {
  it("removes only what is older than the workspace's own period", async () => {
    await log(pruner, daysAgo(200));
    await log(pruner, daysAgo(91));
    await log(pruner, daysAgo(89));
    await log(pruner, daysAgo(1));

    const removed = await processAuditLogRetention();
    expect(removed).toBe(2);

    const left = await prismaUnsafe.auditLog.findMany({
      where: { workspaceId: pruner, action: MARK },
      orderBy: { at: "asc" },
    });
    expect(left).toHaveLength(2);
    for (const row of left) {
      expect(row.at.getTime()).toBeGreaterThan(daysAgo(90).getTime());
    }
  });

  it("leaves a workspace that keeps everything completely alone", async () => {
    await log(keeper, daysAgo(3000));
    await log(pruner, daysAgo(200));

    await processAuditLogRetention();

    expect(await prismaUnsafe.auditLog.count({ where: { workspaceId: keeper } })).toBe(1);
    expect(
      await prismaUnsafe.auditLog.count({ where: { workspaceId: pruner, action: MARK } }),
    ).toBe(0);
  });

  it("records the gap it made", async () => {
    await log(pruner, daysAgo(400));
    await processAuditLogRetention();

    const note = await prismaUnsafe.auditLog.findFirst({
      where: { workspaceId: pruner, action: "audit_log.pruned" },
    });
    expect(note).not.toBeNull();
    // No actor: this was the system, and naming a person would be a lie in the
    // one table that must not contain one.
    expect(note!.actorUserId).toBeNull();
    expect(note!.meta).toMatchObject({ rows: 1, retentionDays: 90 });
  });

  it("writes nothing when there is nothing to remove", async () => {
    await log(pruner, daysAgo(10));
    const removed = await processAuditLogRetention();
    expect(removed).toBe(0);
    // A nightly job that logs "I did nothing" 365 times a year is a job that
    // fills the table it is meant to keep small.
    expect(
      await prismaUnsafe.auditLog.count({
        where: { workspaceId: pruner, action: "audit_log.pruned" },
      }),
    ).toBe(0);
  });

  it("never prunes its own account of what it pruned", async () => {
    // An old pruning note is the explanation for an old gap. Removing it on a
    // later pass would erase the only trace that anything was ever removed.
    await prismaUnsafe.auditLog.create({
      data: {
        workspaceId: pruner,
        action: "audit_log.pruned",
        at: daysAgo(900),
        meta: { rows: 5 },
      },
    });
    await log(pruner, daysAgo(900));

    const removed = await processAuditLogRetention();
    expect(removed).toBe(1);
    const notes = await prismaUnsafe.auditLog.findMany({
      where: { workspaceId: pruner, action: "audit_log.pruned" },
      orderBy: { at: "asc" },
    });
    // The ancient one survived, and today's sweep added its own.
    expect(notes).toHaveLength(2);
    expect(notes[0]!.at.getTime()).toBeLessThan(daysAgo(800).getTime());
  });

  it("clamps a hand-edited period rather than obeying it", async () => {
    await prismaUnsafe.workspace.update({
      where: { id: pruner },
      data: { featureFlags: { auditLogRetentionDays: 1 } },
    });
    await log(pruner, daysAgo(30));
    await log(pruner, daysAgo(200));

    // 1 day would take both; the floor of 90 takes only the older one.
    expect(await processAuditLogRetention()).toBe(1);
    expect(
      await prismaUnsafe.auditLog.count({ where: { workspaceId: pruner, action: MARK } }),
    ).toBe(1);
  });
});
