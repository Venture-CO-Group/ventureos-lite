import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getWorkspaceClient, prismaUnsafe } from "../../src/lib/db";
import { ReadOnlyRoleError } from "../../src/lib/tenant-guard";
import { setRequestUser } from "../../src/lib/request-user";

/**
 * Read-only client access, at the database boundary (P6/6.3).
 *
 * ── WHY THIS TEST IS THE IMPORTANT ONE ──────────────────────────────────────
 *
 * A read-only role is only as good as its weakest write path. Checking the role
 * inside each server action would mean auditing several hundred mutations and
 * remembering it in every future one — a policy whose failure mode is a silent
 * hole in six months' time.
 *
 * So the refusal lives in the Prisma tenant guard, which already intercepts
 * every query on every business table. These tests assert that an action which
 * FORGETS to check still cannot write, which is the only version of the
 * guarantee worth having.
 */
const WS_NAME = "Client Role WS";
let workspaceId = "";
let companyId = "";

beforeAll(async () => {
  const existing = await prismaUnsafe.workspace.findFirst({ where: { name: WS_NAME } });
  const ws = existing ?? (await prismaUnsafe.workspace.create({ data: { name: WS_NAME } }));
  workspaceId = ws.id;
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.company.deleteMany({ where: { workspaceId } });
  const company = await prismaUnsafe.company.create({
    data: { workspaceId, name: "Portal Client Kft." },
  });
  companyId = company.id;
});

afterAll(async () => {
  // Back to "no role", or a later test file in the same process would run as a
  // client. `enterWith` is per async context, but the store outlives this file.
  setRequestUser("cleanup", null);
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.company.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.auditLog.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.workspace.deleteMany({ where: { name: WS_NAME } });
});

describe("a client account cannot write", () => {
  it("is refused a create on a business table", async () => {
    setRequestUser("client-user", "CLIENT");
    const db = getWorkspaceClient(workspaceId);
    await expect(
      db.company.create({ data: { workspaceId, name: "Should Not Exist Zrt." } }),
    ).rejects.toThrow(ReadOnlyRoleError);
    setRequestUser("client-user", null);
    expect(
      await prismaUnsafe.company.count({ where: { workspaceId, name: "Should Not Exist Zrt." } }),
    ).toBe(0);
  });

  it("is refused every other shape of write", async () => {
    setRequestUser("client-user", "CLIENT");
    const db = getWorkspaceClient(workspaceId);
    // Each one separately, because the guard branches on the operation name and
    // a missing entry in that set is a silent hole.
    await expect(db.company.update({ where: { id: companyId }, data: { name: "x" } })).rejects.toThrow(
      ReadOnlyRoleError,
    );
    await expect(db.company.updateMany({ data: { name: "x" } })).rejects.toThrow(ReadOnlyRoleError);
    await expect(db.company.delete({ where: { id: companyId } })).rejects.toThrow(ReadOnlyRoleError);
    await expect(db.company.deleteMany({})).rejects.toThrow(ReadOnlyRoleError);
    await expect(
      db.company.createMany({ data: [{ workspaceId, name: "y" }] }),
    ).rejects.toThrow(ReadOnlyRoleError);
    await expect(
      db.company.upsert({
        where: { id: companyId },
        create: { workspaceId, name: "z" },
        update: { name: "z" },
      }),
    ).rejects.toThrow(ReadOnlyRoleError);
    setRequestUser("client-user", null);
  });

  it("is refused a write to the global tables too", async () => {
    // Membership, Workspace and User are passed through the guard untouched,
    // so the read-only check has to run BEFORE that passthrough.
    setRequestUser("client-user", "CLIENT");
    const db = getWorkspaceClient(workspaceId);
    await expect(
      db.workspace.update({ where: { id: workspaceId }, data: { name: "Renamed By Client" } }),
    ).rejects.toThrow(ReadOnlyRoleError);
    setRequestUser("client-user", null);
    const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId } });
    expect(ws!.name).toBe(WS_NAME);
  });

  it("can still read", async () => {
    setRequestUser("client-user", "CLIENT");
    const db = getWorkspaceClient(workspaceId);
    const company = await db.company.findUnique({ where: { id: companyId } });
    expect(company!.name).toBe("Portal Client Kft.");
    expect(await db.company.count()).toBeGreaterThanOrEqual(1);
    setRequestUser("client-user", null);
  });

  it("can still have its own reads audit-logged", async () => {
    /**
     * The one exception, and it is deliberate.
     *
     * "The client opened the contract on the 14th" is a question worth being
     * able to answer, and a policy that could not record it would force a
     * choice between the log and the role.
     */
    setRequestUser("client-user", "CLIENT");
    const db = getWorkspaceClient(workspaceId);
    await db.auditLog.create({
      data: { workspaceId, action: "portal.document_opened", entityId: "doc-1" },
    });
    setRequestUser("client-user", null);
    expect(
      await prismaUnsafe.auditLog.count({ where: { workspaceId, action: "portal.document_opened" } }),
    ).toBe(1);
  });
});

describe("everybody else is unaffected", () => {
  it("lets a BDR write", async () => {
    setRequestUser("staff-user", "BDR");
    const db = getWorkspaceClient(workspaceId);
    const made = await db.company.create({ data: { workspaceId, name: "Staff Made Kft." } });
    expect(made.id).toBeTruthy();
    await db.company.delete({ where: { id: made.id } });
    setRequestUser("staff-user", null);
  });

  it("lets a background job write, because it has no role at all", async () => {
    // A worker is not a signed-in client. Null must not be treated as one.
    setRequestUser("worker", null);
    const db = getWorkspaceClient(workspaceId);
    const made = await db.company.create({ data: { workspaceId, name: "Worker Made Kft." } });
    expect(made.id).toBeTruthy();
    await db.company.delete({ where: { id: made.id } });
  });
});
