import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { assignableMembers, directoryMembers, liveOwnerCount, seatedMembers } from "../../src/modules/members/directory";

/**
 * The state, against a real database (§1).
 *
 * The bug this closes is the interesting part. Every membership check in the
 * codebase was `suspendedAt: null`, which was correct while membership was
 * binary. The moment INVITED and REMOVED existed it became a condition that
 * says YES to a pending invitation and YES to an ended membership — both have
 * a null suspension. The assignee picker in particular had no filter at all.
 */
const WS = "Member State WS";
const EMAILS = {
  active: "state-active@ventureco.test",
  invited: "state-invited@ventureco.test",
  suspended: "state-suspended@ventureco.test",
  removed: "state-removed@ventureco.test",
  client: "state-client@ventureco.test",
  owner: "state-owner@ventureco.test",
};
let workspaceId = "";
const ids: Record<string, string> = {};

beforeEach(async () => {
  const existing = await prismaUnsafe.workspace.findFirst({ where: { name: WS } });
  const ws = existing ?? (await prismaUnsafe.workspace.create({ data: { name: WS } }));
  workspaceId = ws.id;

  for (const [key, email] of Object.entries(EMAILS)) {
    const user = await prismaUnsafe.user.upsert({
      where: { email },
      update: { deletedAt: null },
      create: { email, name: `State ${key}`, passwordHash: "x" },
    });
    ids[key] = user.id;
    const state =
      key === "invited"
        ? "INVITED"
        : key === "suspended"
          ? "SUSPENDED"
          : key === "removed"
            ? "REMOVED"
            : "ACTIVE";
    await prismaUnsafe.membership.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
      update: {
        state,
        role: key === "client" ? "CLIENT" : key === "owner" ? "OWNER" : "BDR",
        suspendedAt: state === "SUSPENDED" ? new Date() : null,
      },
      create: {
        userId: user.id,
        workspaceId,
        state,
        role: key === "client" ? "CLIENT" : key === "owner" ? "OWNER" : "BDR",
        grants: [],
        suspendedAt: state === "SUSPENDED" ? new Date() : null,
      },
    });
  }
});

afterAll(async () => {
  await prismaUnsafe.membership.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
  await prismaUnsafe.workspace.deleteMany({ where: { name: WS } });
});

describe("who work can be given to", () => {
  it("is the active staff, and nobody else", async () => {
    const out = await assignableMembers(workspaceId);
    const emails = out.map((m) => m.email).sort();
    expect(emails).toEqual([EMAILS.active, EMAILS.owner].sort());
  });

  it("excludes a pending invitation", async () => {
    // Handing work to somebody who has not accepted yet is a task that never
    // gets done, and nobody notices for a week.
    const out = await assignableMembers(workspaceId);
    expect(out.map((m) => m.email)).not.toContain(EMAILS.invited);
  });

  it("excludes a suspended member", async () => {
    const out = await assignableMembers(workspaceId);
    expect(out.map((m) => m.email)).not.toContain(EMAILS.suspended);
  });

  it("excludes an ended membership", async () => {
    const out = await assignableMembers(workspaceId);
    expect(out.map((m) => m.email)).not.toContain(EMAILS.removed);
  });

  it("excludes a read-only client account", async () => {
    // A client appearing in an assignee dropdown is how somebody's customer
    // ends up owning a lead.
    const out = await assignableMembers(workspaceId);
    expect(out.map((m) => m.email)).not.toContain(EMAILS.client);
  });

  it("excludes a soft-deleted account even while its membership is active", async () => {
    await prismaUnsafe.user.update({
      where: { id: ids.active },
      data: { deletedAt: new Date(), purgeAfter: new Date(Date.now() + 30 * 86_400_000) },
    });
    const out = await assignableMembers(workspaceId);
    expect(out.map((m) => m.email)).not.toContain(EMAILS.active);
  });
});

describe("who counts as being in the workspace", () => {
  it("includes a suspended member, because they still own their records", async () => {
    const out = await seatedMembers(workspaceId);
    const emails = out.map((m) => m.email);
    expect(emails).toContain(EMAILS.suspended);
    expect(emails).toContain(EMAILS.active);
    expect(emails).toContain(EMAILS.client);
    // Not seated: an invitation is not a person in the room, and a removed
    // membership is history.
    expect(emails).not.toContain(EMAILS.invited);
    expect(emails).not.toContain(EMAILS.removed);
  });
});

describe("what the members screen lists", () => {
  it("shows pending invitations and suspensions, and hides who left", async () => {
    const out = await directoryMembers(workspaceId);
    const emails = out.map((m) => m.email);
    expect(emails).toContain(EMAILS.invited);
    expect(emails).toContain(EMAILS.suspended);
    // A list that grows for ever with people who left is a list nobody reads.
    expect(emails).not.toContain(EMAILS.removed);
  });

  it("shows who left when asked", async () => {
    const out = await directoryMembers(workspaceId, { includeRemoved: true });
    expect(out.map((m) => m.email)).toContain(EMAILS.removed);
  });
});

describe("counting the Owners who can still get in", () => {
  it("counts only an ACTIVE Owner", async () => {
    expect(await liveOwnerCount(workspaceId)).toBe(1);

    await prismaUnsafe.membership.update({
      where: { userId_workspaceId: { userId: ids.owner, workspaceId } },
      data: { state: "SUSPENDED", suspendedAt: new Date() },
    });
    /**
     * A workspace whose only Owner is suspended has no Owner who can grant a
     * role, provision anything, or restore it. Recovering one needs shell
     * access to the server — which is not a support process, it is an outage.
     */
    expect(await liveOwnerCount(workspaceId)).toBe(0);
  });

  it("can exclude the person being acted on", async () => {
    expect(await liveOwnerCount(workspaceId, ids.owner)).toBe(0);
    expect(await liveOwnerCount(workspaceId, ids.active)).toBe(1);
  });
});
