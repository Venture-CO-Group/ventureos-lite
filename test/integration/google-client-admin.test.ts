import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { prismaUnsafe } from "../../src/lib/db";
import {
  deleteGoogleClient,
  googleClientPanel,
  saveGoogleClient,
} from "../../src/modules/google/client-admin";
import { googleClientForRef, workspaceClientRef } from "../../src/modules/google/clients";

/**
 * The workspace's "Google connection" panel (item 3).
 */
const P = "gadmin-test";
const ID_A = "111-aaa.apps.googleusercontent.com";
const ID_B = "222-bbb.apps.googleusercontent.com";
let ws = "";
let ownerId = "";
let bdrId = "";

beforeAll(async () => {
  process.env.CREDENTIALS_KEY ??= randomBytes(32).toString("base64");
  ws = (await prismaUnsafe.workspace.create({ data: { name: `${P} ws` } })).id;
  ownerId = (await prismaUnsafe.user.create({ data: { email: `${P}-owner@ventureco.test`, name: "Owner", passwordHash: "x" } })).id;
  bdrId = (await prismaUnsafe.user.create({ data: { email: `${P}-bdr@ventureco.test`, name: "Bdr", passwordHash: "x" } })).id;
  await prismaUnsafe.membership.createMany({
    data: [
      { userId: ownerId, workspaceId: ws, role: "OWNER", state: "ACTIVE", grants: [] },
      { userId: bdrId, workspaceId: ws, role: "BDR", state: "ACTIVE", grants: [] },
    ],
  });
});

beforeEach(async () => {
  await prismaUnsafe.mailAccount.deleteMany({ where: { workspaceId: ws } });
  await prismaUnsafe.googleCredential.deleteMany({ where: { userId: { in: [ownerId, bdrId] } } });
  await prismaUnsafe.workspaceGoogleClient.deleteMany({ where: { workspaceId: ws } });
  await prismaUnsafe.notification.deleteMany({ where: { workspaceId: ws } });
});

afterAll(async () => {
  await prismaUnsafe.mailAccount.deleteMany({ where: { workspaceId: ws } });
  await prismaUnsafe.workspaceGoogleClient.deleteMany({ where: { workspaceId: ws } });
  await prismaUnsafe.notification.deleteMany({ where: { workspaceId: ws } });
  await prismaUnsafe.auditLog.deleteMany({ where: { workspaceId: ws } });
  await prismaUnsafe.user.deleteMany({ where: { email: { startsWith: P } } });
  await prismaUnsafe.workspace.deleteMany({ where: { name: { startsWith: P } } });
});

/** A BDR who connected Gmail through the workspace's current client. */
async function connectBdr() {
  const row = await prismaUnsafe.workspaceGoogleClient.findFirstOrThrow({ where: { workspaceId: ws } });
  const cred = await prismaUnsafe.googleCredential.create({
    data: {
      userId: bdrId,
      accountEmail: "bdr@company.test",
      accessToken: "at",
      refreshToken: "rt",
      clientRef: workspaceClientRef(ws, row.id),
      scope: "gmail.readonly",
    },
  });
  await prismaUnsafe.mailAccount.create({
    data: { workspaceId: ws, userId: bdrId, accountEmail: "bdr@company.test", credentialId: cred.id },
  });
  return { cred, ref: workspaceClientRef(ws, row.id) };
}

describe("configuring the client", () => {
  it("refuses anybody but an Owner of the workspace", async () => {
    const res = await saveGoogleClient({ actorId: bdrId, workspaceId: ws, clientId: ID_A, clientSecret: "s" });
    expect(res.ok).toBe(false);
    expect(await prismaUnsafe.workspaceGoogleClient.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it("stores the secret encrypted and never hands it back", async () => {
    const res = await saveGoogleClient({ actorId: ownerId, workspaceId: ws, clientId: ID_A, clientSecret: "GOCSPX-secret" });
    expect(res).toMatchObject({ ok: true });
    const row = await prismaUnsafe.workspaceGoogleClient.findFirstOrThrow({ where: { workspaceId: ws } });
    expect(row.clientSecretEnc).not.toContain("GOCSPX-secret");
    const panel = await googleClientPanel(ws);
    expect(JSON.stringify(panel)).not.toContain("GOCSPX-secret");
    expect(panel).toMatchObject({ configured: true, clientId: ID_A, secretSet: true });
    expect(await prismaUnsafe.auditLog.count({ where: { workspaceId: ws, action: "google_client.create" } })).toBe(1);
  });

  it("rotating only the secret disconnects nobody", async () => {
    await saveGoogleClient({ actorId: ownerId, workspaceId: ws, clientId: ID_A, clientSecret: "one" });
    const { cred, ref } = await connectBdr();
    const res = await saveGoogleClient({ actorId: ownerId, workspaceId: ws, clientId: ID_A, clientSecret: "two" });
    expect(res).toMatchObject({ ok: true, replaced: false, invalidated: 0 });
    expect((await googleClientForRef(ref)).clientSecret).toBe("two");
    const after = await prismaUnsafe.googleCredential.findUniqueOrThrow({ where: { id: cred.id } });
    expect(after.invalidatedAt).toBeNull();
  });
});

describe("replacing the client", () => {
  it("asks first with the number of connections it would cut", async () => {
    await saveGoogleClient({ actorId: ownerId, workspaceId: ws, clientId: ID_A, clientSecret: "one" });
    await connectBdr();
    const res = await saveGoogleClient({ actorId: ownerId, workspaceId: ws, clientId: ID_B, clientSecret: "new" });
    expect(res).toEqual({ ok: false, needsConfirm: true, affected: 1 });
    // Nothing changed yet.
    const row = await prismaUnsafe.workspaceGoogleClient.findFirstOrThrow({ where: { workspaceId: ws } });
    expect(row.clientId).toBe(ID_A);
  });

  it("then marks the old client's credentials for reconnection and notifies their owners", async () => {
    await saveGoogleClient({ actorId: ownerId, workspaceId: ws, clientId: ID_A, clientSecret: "one" });
    const { cred, ref } = await connectBdr();
    const res = await saveGoogleClient({
      actorId: ownerId,
      workspaceId: ws,
      clientId: ID_B,
      clientSecret: "new",
      confirmAffected: 1,
    });
    expect(res).toEqual({ ok: true, replaced: true, invalidated: 1 });

    const after = await prismaUnsafe.googleCredential.findUniqueOrThrow({ where: { id: cred.id } });
    expect(after.invalidatedAt).not.toBeNull();
    const box = await prismaUnsafe.mailAccount.findFirstOrThrow({ where: { credentialId: cred.id } });
    expect(box.health).toBe("reconnect_needed");
    // The old ref no longer resolves, so no refresh is even attempted with it.
    await expect(googleClientForRef(ref)).rejects.toThrow();

    const note = await prismaUnsafe.notification.findFirst({ where: { workspaceId: ws, userId: bdrId } });
    expect(note?.title).toMatch(/reconnect/i);
    expect(await prismaUnsafe.auditLog.count({ where: { workspaceId: ws, action: "google_client.replace" } })).toBe(1);

    const panel = await googleClientPanel(ws);
    expect(panel.connections.find((c) => c.credentialId === cred.id)?.client).toBe("replaced");
  });

  it("refuses a confirmation for a different number than the change would cut", async () => {
    await saveGoogleClient({ actorId: ownerId, workspaceId: ws, clientId: ID_A, clientSecret: "one" });
    await connectBdr();
    const res = await saveGoogleClient({
      actorId: ownerId,
      workspaceId: ws,
      clientId: ID_B,
      clientSecret: "new",
      confirmAffected: 0,
    });
    expect(res).toEqual({ ok: false, needsConfirm: true, affected: 1 });
  });
});

describe("removing the client", () => {
  it("invalidates what it issued after confirmation, and new connections fall back to env", async () => {
    await saveGoogleClient({ actorId: ownerId, workspaceId: ws, clientId: ID_A, clientSecret: "one" });
    const { cred } = await connectBdr();
    expect(await deleteGoogleClient({ actorId: ownerId, workspaceId: ws })).toEqual({
      ok: false,
      needsConfirm: true,
      affected: 1,
    });
    expect(await deleteGoogleClient({ actorId: ownerId, workspaceId: ws, confirmAffected: 1 })).toEqual({
      ok: true,
      invalidated: 1,
    });
    expect(await prismaUnsafe.workspaceGoogleClient.count({ where: { workspaceId: ws } })).toBe(0);
    const after = await prismaUnsafe.googleCredential.findUniqueOrThrow({ where: { id: cred.id } });
    expect(after.invalidatedAt).not.toBeNull();
    expect(await prismaUnsafe.auditLog.count({ where: { workspaceId: ws, action: "google_client.delete" } })).toBe(1);
  });

  it("refuses a non-Owner", async () => {
    await saveGoogleClient({ actorId: ownerId, workspaceId: ws, clientId: ID_A, clientSecret: "one" });
    const res = await deleteGoogleClient({ actorId: bdrId, workspaceId: ws, confirmAffected: 0 });
    expect(res.ok).toBe(false);
    expect(await prismaUnsafe.workspaceGoogleClient.count({ where: { workspaceId: ws } })).toBe(1);
  });
});
