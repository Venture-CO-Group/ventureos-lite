import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import {
  assignExistingUser,
  assignableUsersFor,
  detailsOf,
  purgeWorkspace,
  restorableFor,
  restoreWorkspace,
  softDeleteWorkspace,
  updateDetails,
  workspaceScopedModels,
} from "../../src/modules/workspaces/admin";
import { issueInvitation } from "../../src/modules/members/invitation-store";
import { provisionWorkspace } from "../../src/modules/workspaces/provision";

/**
 * Administering a workspace by id (members, details, deletion).
 *
 * The reported problems: a person could not be added to a new workspace, an
 * existing person could not be assigned to one at all, the details typed at
 * creation could never be changed, and a workspace could not be deleted.
 * Every refusal is tested as hard as every success, because each of these
 * actions names a workspace the caller is NOT necessarily standing in.
 */
const P = "ws-admin-test";
const OWNER = `${P}-owner@ventureco.test`;
const COLLEAGUE = `${P}-colleague@ventureco.test`;
const STRANGER = `${P}-stranger@ventureco.test`;
const OTHER_OWNER = `${P}-other-owner@ventureco.test`;

let home = ""; // owner's original workspace, colleague is ACTIVE here
let fresh = ""; // newly created, owner is its only member
let foreign = ""; // owned by somebody else; stranger is a member
let ownerId = "";
let colleagueId = "";
let strangerId = "";
let otherOwnerId = "";

async function user(email: string, name: string) {
  return prismaUnsafe.user.create({
    data: { email, name, passwordHash: "$2a$10$abcdefghijklmnopqrstuv" },
  });
}

async function cleanup() {
  const ws = await prismaUnsafe.workspace.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  });
  for (const w of ws) await purgeWorkspace(w.id).catch(() => undefined);
  await prismaUnsafe.user.deleteMany({ where: { email: { startsWith: P } } });
}

beforeAll(async () => {
  await cleanup();
  const [a, b, c] = await Promise.all([
    prismaUnsafe.workspace.create({ data: { name: `${P} home` } }),
    prismaUnsafe.workspace.create({
      data: {
        name: `${P} fresh`,
        brand: { color: "#111111", markBold: "keep-me" },
        mailgunConfig: { domain: "mg.old.test", from: "keep@old.test" },
      },
    }),
    prismaUnsafe.workspace.create({ data: { name: `${P} foreign` } }),
  ]);
  home = a.id;
  fresh = b.id;
  foreign = c.id;
  ownerId = (await user(OWNER, "Owner")).id;
  colleagueId = (await user(COLLEAGUE, "Colleague")).id;
  strangerId = (await user(STRANGER, "Stranger")).id;
  otherOwnerId = (await user(OTHER_OWNER, "Other Owner")).id;
  await prismaUnsafe.membership.createMany({
    data: [
      { userId: ownerId, workspaceId: home, role: "OWNER", state: "ACTIVE", grants: [] },
      { userId: ownerId, workspaceId: fresh, role: "OWNER", state: "ACTIVE", grants: [] },
      { userId: colleagueId, workspaceId: home, role: "BDR", state: "ACTIVE", grants: [] },
      { userId: otherOwnerId, workspaceId: foreign, role: "OWNER", state: "ACTIVE", grants: [] },
      { userId: strangerId, workspaceId: foreign, role: "BDR", state: "ACTIVE", grants: [] },
    ],
  });
});

afterAll(cleanup);

describe("adding an existing person to another workspace", () => {
  it("offers only people from workspaces the actor owns", async () => {
    const list = await assignableUsersFor(ownerId, fresh);
    const ids = list.map((u) => u.userId);
    expect(ids).toContain(colleagueId);
    expect(ids).not.toContain(strangerId);
    // Not themselves — they are already in it.
    expect(ids).not.toContain(ownerId);
  });

  it("refuses somebody the actor does not already work with", async () => {
    const res = await assignExistingUser({
      actorId: ownerId,
      workspaceId: fresh,
      userId: strangerId,
      role: "BDR",
      grants: [],
    });
    expect(res.ok).toBe(false);
    const m = await prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId: strangerId, workspaceId: fresh } },
    });
    expect(m).toBeNull();
  });

  it("refuses an actor who does not own the target workspace", async () => {
    const res = await assignExistingUser({
      actorId: otherOwnerId,
      workspaceId: fresh,
      userId: strangerId,
      role: "BDR",
      grants: [],
    });
    expect(res.ok).toBe(false);
  });

  it("adds a colleague as ACTIVE, and finishes a stuck invitation instead of leaving it open", async () => {
    // The production state: an earlier invitation left them INVITED.
    const inv = await issueInvitation({
      workspaceId: fresh,
      actorUserId: ownerId,
      email: COLLEAGUE,
      role: "BDR",
    });
    expect(inv.ok).toBe(true);

    const res = await assignExistingUser({
      actorId: ownerId,
      workspaceId: fresh,
      userId: colleagueId,
      role: "ADMIN",
      grants: ["documents.create", "not-a-real-grant"],
    });
    expect(res).toEqual({ ok: true });

    const m = await prismaUnsafe.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: colleagueId, workspaceId: fresh } },
    });
    expect(m.state).toBe("ACTIVE");
    expect(m.role).toBe("ADMIN");
    expect(m.grants).not.toContain("not-a-real-grant");

    const open = await prismaUnsafe.invitation.count({
      where: { workspaceId: fresh, email: COLLEAGUE, acceptedAt: null, revokedAt: null },
    });
    expect(open).toBe(0);

    // Now present, so no longer offered.
    const list = await assignableUsersFor(ownerId, fresh);
    expect(list.map((u) => u.userId)).not.toContain(colleagueId);
  });
});

describe("editing a workspace's details", () => {
  const input = {
    workspaceId: "",
    name: `${P} fresh renamed`,
    legalName: "Fresh Kft.",
    brandColor: "#7427C6",
    logoUrl: "",
    mailgunDomain: "mg.new.test",
    claudeBudget: 5,
    retentionDays: 400,
  };

  it("refuses anybody who is not an Owner of that workspace", async () => {
    const res = await updateDetails({ ...input, workspaceId: fresh, actorId: otherOwnerId });
    expect(res.ok).toBe(false);
    const res2 = await updateDetails({ ...input, workspaceId: fresh, actorId: colleagueId });
    expect(res2.ok).toBe(false);
  });

  it("saves every field and keeps what the form does not own", async () => {
    const res = await updateDetails({ ...input, workspaceId: fresh, actorId: ownerId });
    expect(res).toEqual({ ok: true });

    const d = await detailsOf(fresh);
    expect(d).toMatchObject({
      name: input.name,
      legalName: "Fresh Kft.",
      brandColor: "#7427C6",
      mailgunDomain: "mg.new.test",
      claudeBudget: 5,
      retentionDays: 400,
    });
    const raw = await prismaUnsafe.workspace.findUniqueOrThrow({ where: { id: fresh } });
    // The letterhead and the sender identity are merged, not wiped.
    expect((raw.brand as Record<string, unknown>).markBold).toBe("keep-me");
    expect((raw.mailgunConfig as Record<string, unknown>).from).toBe("keep@old.test");

    const log = await prismaUnsafe.auditLog.findFirst({
      where: { workspaceId: fresh, action: "workspace.update" },
    });
    expect(log).not.toBeNull();
  });
});

describe("deleting a workspace", () => {
  it("refuses a wrong confirmation name", async () => {
    const res = await softDeleteWorkspace({ actorId: ownerId, workspaceId: fresh, confirmName: "nope" });
    expect(res.ok).toBe(false);
  });

  it("refuses an actor who is not its Owner", async () => {
    const ws = await prismaUnsafe.workspace.findUniqueOrThrow({ where: { id: fresh } });
    const res = await softDeleteWorkspace({
      actorId: colleagueId,
      workspaceId: fresh,
      confirmName: ws.name,
    });
    expect(res.ok).toBe(false);
  });

  it("refuses to delete somebody's last workspace", async () => {
    const res = await softDeleteWorkspace({
      actorId: otherOwnerId,
      workspaceId: foreign,
      confirmName: `${P} foreign`,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/only workspace/i);
  });

  it("hides it at once, keeps a trace elsewhere, and can be restored", async () => {
    const ws = await prismaUnsafe.workspace.findUniqueOrThrow({ where: { id: fresh } });
    const res = await softDeleteWorkspace({ actorId: ownerId, workspaceId: fresh, confirmName: ws.name });
    expect(res.ok).toBe(true);

    // Out of every membership lookup the shell, session and login use.
    const live = await prismaUnsafe.membership.findMany({
      where: { userId: colleagueId, state: "ACTIVE", workspace: { deletedAt: null } },
      select: { workspaceId: true },
    });
    expect(live.map((l) => l.workspaceId)).toEqual([home]);
    // And out of every background sweep.
    const swept = await prismaUnsafe.workspace.findMany({
      where: { deletedAt: null, name: { startsWith: P } },
      select: { id: true },
    });
    expect(swept.map((s) => s.id)).not.toContain(fresh);

    // The fact of the deletion outlives the workspace's own log.
    const trace = await prismaUnsafe.auditLog.findFirst({
      where: { workspaceId: home, action: "workspace.delete", entityId: fresh },
    });
    expect(trace).not.toBeNull();

    const restorable = await restorableFor(ownerId);
    expect(restorable.map((r) => r.id)).toContain(fresh);
    expect(await restorableFor(colleagueId)).toEqual([]);

    expect((await restoreWorkspace({ actorId: colleagueId, workspaceId: fresh })).ok).toBe(false);
    expect(await restoreWorkspace({ actorId: ownerId, workspaceId: fresh })).toEqual({ ok: true });
    const back = await prismaUnsafe.workspace.findUniqueOrThrow({ where: { id: fresh } });
    expect(back.deletedAt).toBeNull();
  });

  it("purges every scoped row and re-points sessions instead of signing people out", async () => {
    const victim = await prismaUnsafe.workspace.create({ data: { name: `${P} purge` } });
    await prismaUnsafe.membership.create({
      data: { userId: ownerId, workspaceId: victim.id, role: "OWNER", state: "ACTIVE", grants: [] },
    });
    // Real foreign-key chains, not a single table: pipelines own stages,
    // templates and targets come with them, and a lead hangs a task off it.
    await provisionWorkspace(prismaUnsafe, victim.id);
    const lead = await prismaUnsafe.lead.create({ data: { workspaceId: victim.id } });
    await prismaUnsafe.activity.create({
      data: { workspaceId: victim.id, leadId: lead.id, type: "note", payload: {} } as never,
    });
    await prismaUnsafe.auditLog.create({
      data: { workspaceId: victim.id, action: "x", entityType: "Workspace", entityId: victim.id },
    });
    const session = await prismaUnsafe.session.create({
      data: {
        userId: ownerId,
        workspaceId: victim.id,
        token: `${P}-${Date.now()}`,
        expiresAt: new Date(Date.now() + 3_600_000),
        lastSeenAt: new Date(),
      },
    });

    const out = await purgeWorkspace(victim.id);
    expect(out.rows).toBeGreaterThan(0);

    expect(await prismaUnsafe.workspace.findUnique({ where: { id: victim.id } })).toBeNull();
    for (const model of workspaceScopedModels()) {
      const key = model.charAt(0).toLowerCase() + model.slice(1);
      const delegate = (prismaUnsafe as unknown as Record<string, { count: (a: unknown) => Promise<number> }>)[key];
      expect(await delegate.count({ where: { workspaceId: victim.id } }), model).toBe(0);
    }
    const s = await prismaUnsafe.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(s.workspaceId).toBeNull();
    await prismaUnsafe.session.delete({ where: { id: session.id } });
  });
});
