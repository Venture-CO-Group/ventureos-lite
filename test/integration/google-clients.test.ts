import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { prismaUnsafe } from "../../src/lib/db";
import { encryptSecret } from "../../src/lib/crypto";
import {
  ENV_CLIENT_REF,
  GoogleClientUnavailableError,
  googleClientForRef,
  parseClientRef,
  refreshGoogleAccessToken,
  resolveGoogleClient,
  workspaceClientRef,
} from "../../src/modules/google/clients";

/**
 * Which OAuth client a Google operation uses (per-workspace clients, item 1).
 *
 * The two properties that matter: a workspace with nothing configured behaves
 * exactly as before (the env client), and a refresh always goes through the
 * client that ISSUED the token — Google refuses it from any other.
 */
const P = "gclient-test";
let plain = "";
let own = "";

beforeAll(async () => {
  process.env.CREDENTIALS_KEY ??= randomBytes(32).toString("base64");
  process.env.GOOGLE_CLIENT_ID = "env-client.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "env-secret";
  plain = (await prismaUnsafe.workspace.create({ data: { name: `${P} plain` } })).id;
  own = (await prismaUnsafe.workspace.create({ data: { name: `${P} own` } })).id;
});

beforeEach(async () => {
  await prismaUnsafe.workspaceGoogleClient.deleteMany({ where: { workspaceId: { in: [plain, own] } } });
});

afterAll(async () => {
  await prismaUnsafe.workspaceGoogleClient.deleteMany({ where: { workspaceId: { in: [plain, own] } } });
  await prismaUnsafe.workspace.deleteMany({ where: { name: { startsWith: P } } });
});

async function configure(workspaceId: string, clientId: string, secret: string) {
  return prismaUnsafe.workspaceGoogleClient.create({
    data: { workspaceId, clientId, clientSecretEnc: encryptSecret(secret), createdBy: "test" },
  });
}

/** A fetch that records what it was asked and answers like Google's token endpoint. */
function tokenEndpoint() {
  const calls: URLSearchParams[] = [];
  const doFetch = (async (_url: unknown, init?: RequestInit) => {
    calls.push(new URLSearchParams(String(init?.body ?? "")));
    return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;
  return { calls, doFetch };
}

describe("resolving the client for a new connection", () => {
  it("uses the env client when the workspace configured none — the existing setup, unchanged", async () => {
    const c = await resolveGoogleClient(plain);
    expect(c).toMatchObject({ ref: ENV_CLIENT_REF, clientId: "env-client.apps.googleusercontent.com", source: "env" });
  });

  it("uses the workspace's own client when it has one", async () => {
    const row = await configure(own, "own-client.apps.googleusercontent.com", "own-secret");
    const c = await resolveGoogleClient(own);
    expect(c).toMatchObject({
      ref: workspaceClientRef(own, row.id),
      clientId: "own-client.apps.googleusercontent.com",
      clientSecret: "own-secret",
      source: "workspace",
    });
    // And another workspace is not affected by it.
    expect((await resolveGoogleClient(plain))?.ref).toBe(ENV_CLIENT_REF);
  });
});

describe("refreshing a stored credential", () => {
  it("refreshes a legacy (env) credential with the env client", async () => {
    const { calls, doFetch } = tokenEndpoint();
    await refreshGoogleAccessToken({ refreshToken: "r", clientRef: null }, doFetch);
    await refreshGoogleAccessToken({ refreshToken: "r", clientRef: ENV_CLIENT_REF }, doFetch);
    expect(calls.map((c) => c.get("client_id"))).toEqual([
      "env-client.apps.googleusercontent.com",
      "env-client.apps.googleusercontent.com",
    ]);
  });

  it("refreshes a workspace credential through the client that issued it", async () => {
    const row = await configure(own, "own-client.apps.googleusercontent.com", "own-secret");
    const { calls, doFetch } = tokenEndpoint();
    const out = await refreshGoogleAccessToken(
      { refreshToken: "r", clientRef: workspaceClientRef(own, row.id) },
      doFetch,
    );
    expect(out.accessToken).toBe("fresh");
    expect(calls[0].get("client_id")).toBe("own-client.apps.googleusercontent.com");
    expect(calls[0].get("client_secret")).toBe("own-secret");
  });

  it("refuses — never falls back to env — when the issuing client was replaced", async () => {
    const old = await configure(own, "old-client", "old-secret");
    const oldRef = workspaceClientRef(own, old.id);
    await prismaUnsafe.workspaceGoogleClient.delete({ where: { id: old.id } });
    await configure(own, "new-client", "new-secret");

    const { calls, doFetch } = tokenEndpoint();
    await expect(
      refreshGoogleAccessToken({ refreshToken: "r", clientRef: oldRef }, doFetch),
    ).rejects.toBeInstanceOf(GoogleClientUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it("parses only well-formed refs", () => {
    expect(parseClientRef("ws:a:b")).toEqual({ workspaceId: "a", rowId: "b" });
    expect(parseClientRef("env")).toBeNull();
    expect(parseClientRef("ws:a")).toBeNull();
  });

  it("refuses an unknown ref shape", async () => {
    await expect(googleClientForRef("something-else")).rejects.toBeInstanceOf(
      GoogleClientUnavailableError,
    );
  });
});
