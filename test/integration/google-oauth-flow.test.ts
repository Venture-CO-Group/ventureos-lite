import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { prismaUnsafe } from "../../src/lib/db";
import { encryptSecret } from "../../src/lib/crypto";
import { completeGoogleOAuth, startGoogleOAuth } from "../../src/modules/google/oauth-flow";
import { signState, STATE_TTL_MS } from "../../src/modules/google/oauth-state";
import { refreshGoogleAccessToken, workspaceClientRef } from "../../src/modules/google/clients";

/**
 * The OAuth round-trip with per-workspace clients (item 2), against a real
 * database and a fake Google.
 */
const P = "gflow-test";
let venture = ""; // no client of its own → env
let other = ""; // has its own client
let userId = "";
let outsiderId = "";
let ownRowId = "";

beforeAll(async () => {
  process.env.CREDENTIALS_KEY ??= randomBytes(32).toString("base64");
  process.env.NEXTAUTH_SECRET ??= "test-secret-0123456789abcdef0123456789abcdef";
  process.env.GOOGLE_CLIENT_ID = "env-client";
  process.env.GOOGLE_CLIENT_SECRET = "env-secret";
  process.env.GOOGLE_REDIRECT_URI = "https://app.example/api/google/callback";

  venture = (await prismaUnsafe.workspace.create({ data: { name: `${P} venture` } })).id;
  other = (await prismaUnsafe.workspace.create({ data: { name: `${P} other` } })).id;
  userId = (await prismaUnsafe.user.create({
    data: { email: `${P}-user@ventureco.test`, name: "Flow User", passwordHash: "x" },
  })).id;
  outsiderId = (await prismaUnsafe.user.create({
    data: { email: `${P}-outsider@ventureco.test`, name: "Outsider", passwordHash: "x" },
  })).id;
  await prismaUnsafe.membership.createMany({
    data: [
      { userId, workspaceId: venture, role: "OWNER", state: "ACTIVE", grants: [] },
      { userId, workspaceId: other, role: "OWNER", state: "ACTIVE", grants: [] },
      { userId: outsiderId, workspaceId: venture, role: "BDR", state: "ACTIVE", grants: [] },
    ],
  });
  ownRowId = (await prismaUnsafe.workspaceGoogleClient.create({
    data: { workspaceId: other, clientId: "own-client", clientSecretEnc: encryptSecret("own-secret"), createdBy: userId },
  })).id;
});

beforeEach(async () => {
  await prismaUnsafe.mailAccount.deleteMany({ where: { userId } });
  await prismaUnsafe.googleCredential.deleteMany({ where: { userId } });
});

afterAll(async () => {
  await prismaUnsafe.mailAccount.deleteMany({ where: { userId } });
  await prismaUnsafe.workspaceGoogleClient.deleteMany({ where: { workspaceId: { in: [venture, other] } } });
  await prismaUnsafe.user.deleteMany({ where: { email: { startsWith: P } } });
  await prismaUnsafe.workspace.deleteMany({ where: { name: { startsWith: P } } });
});

/** A fake Google: records token requests, answers token + userinfo. */
function google(email = "person@company.test") {
  const tokenCalls: URLSearchParams[] = [];
  const doFetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("userinfo")) {
      return new Response(JSON.stringify({ email }), { status: 200 });
    }
    tokenCalls.push(new URLSearchParams(String(init?.body ?? "")));
    return new Response(
      JSON.stringify({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.readonly",
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { tokenCalls, doFetch };
}

function params(state: string, extra: Record<string, string> = { code: "the-code" }) {
  return new URLSearchParams({ state, ...extra });
}

describe("with no workspace client configured", () => {
  it("runs exactly as before, through the env client", async () => {
    const start = await startGoogleOAuth({ workspaceId: venture, userId, purpose: "connect" });
    if (!start.ok) throw new Error("start failed");
    const url = new URL(start.url);
    expect(url.searchParams.get("client_id")).toBe("env-client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/api/google/callback");

    const g = google();
    const out = await completeGoogleOAuth({
      params: params(url.searchParams.get("state")!),
      cookieNonce: start.nonce,
      session: { userId, workspaceId: venture },
      doFetch: g.doFetch,
    });
    expect(out).toMatchObject({ ok: true, clientRef: "env" });
    expect(g.tokenCalls[0].get("client_id")).toBe("env-client");
    const cred = await prismaUnsafe.googleCredential.findFirstOrThrow({ where: { userId } });
    expect(cred.clientRef).toBe("env");
  });
});

describe("with the workspace's own client", () => {
  it("completes the round-trip, and the credential refreshes through that client", async () => {
    const start = await startGoogleOAuth({ workspaceId: other, userId, purpose: "connect" });
    if (!start.ok) throw new Error("start failed");
    const url = new URL(start.url);
    expect(url.searchParams.get("client_id")).toBe("own-client");
    // One redirect URI for every client.
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/api/google/callback");

    const g = google();
    const out = await completeGoogleOAuth({
      params: params(url.searchParams.get("state")!),
      cookieNonce: start.nonce,
      session: { userId, workspaceId: other },
      doFetch: g.doFetch,
    });
    expect(out.ok).toBe(true);
    expect(g.tokenCalls[0].get("client_id")).toBe("own-client");
    expect(g.tokenCalls[0].get("client_secret")).toBe("own-secret");

    const cred = await prismaUnsafe.googleCredential.findFirstOrThrow({ where: { userId } });
    expect(cred.clientRef).toBe(workspaceClientRef(other, ownRowId));
    const box = await prismaUnsafe.mailAccount.findFirstOrThrow({ where: { userId } });
    expect(box.workspaceId).toBe(other);

    const refresh = google();
    await refreshGoogleAccessToken({ refreshToken: cred.refreshToken!, clientRef: cred.clientRef }, refresh.doFetch);
    expect(refresh.tokenCalls[0].get("client_id")).toBe("own-client");
  });

  it("a test round-trip stores nothing and marks the client tested", async () => {
    const start = await startGoogleOAuth({ workspaceId: other, userId, purpose: "test" });
    if (!start.ok) throw new Error("start failed");
    const out = await completeGoogleOAuth({
      params: params(new URL(start.url).searchParams.get("state")!),
      cookieNonce: start.nonce,
      session: { userId, workspaceId: other },
      doFetch: google().doFetch,
    });
    expect(out).toMatchObject({ ok: true, purpose: "test" });
    expect(await prismaUnsafe.googleCredential.count({ where: { userId } })).toBe(0);
    const row = await prismaUnsafe.workspaceGoogleClient.findUniqueOrThrow({ where: { id: ownRowId } });
    expect(row.status).toBe("ok");
    expect(row.lastTestedAt).not.toBeNull();
  });
});

describe("rejections — nothing reaches Google", () => {
  async function attempt(state: string, nonce: string, session: { userId: string; workspaceId: string } | null) {
    const g = google();
    const out = await completeGoogleOAuth({ params: params(state), cookieNonce: nonce, session, doFetch: g.doFetch });
    return { out, calls: g.tokenCalls.length };
  }

  it("rejects a forged state", async () => {
    const { state, nonce } = signState({ workspaceId: venture, userId, purpose: "connect" });
    // Re-point the payload at another workspace, keep the old signature.
    const [payload, sig] = state.split(".");
    const body = JSON.parse(Buffer.from(payload, "base64url").toString());
    body.workspaceId = other;
    const forged = `${Buffer.from(JSON.stringify(body)).toString("base64url")}.${sig}`;
    const { out, calls } = await attempt(forged, nonce, { userId, workspaceId: other });
    expect(out).toMatchObject({ ok: false, failure: { code: "state", reason: "signature" } });
    expect(calls).toBe(0);
  });

  it("rejects an expired state", async () => {
    const { state, nonce } = signState({
      workspaceId: venture,
      userId,
      purpose: "connect",
      iat: Date.now() - STATE_TTL_MS - 1000,
    });
    const { out, calls } = await attempt(state, nonce, { userId, workspaceId: venture });
    expect(out).toMatchObject({ ok: false, failure: { code: "state", reason: "expired" } });
    expect(calls).toBe(0);
  });

  it("rejects a valid state replayed in a browser that did not start the flow", async () => {
    const { state } = signState({ workspaceId: venture, userId, purpose: "connect" });
    const { out } = await attempt(state, "some-other-nonce", { userId, workspaceId: venture });
    expect(out).toMatchObject({ ok: false, failure: { code: "state", reason: "nonce" } });
  });

  it("refuses to connect through another workspace's client", async () => {
    // Started while acting in `other`, finished while acting in `venture`.
    const { state, nonce } = signState({ workspaceId: other, userId, purpose: "connect" });
    const { out, calls } = await attempt(state, nonce, { userId, workspaceId: venture });
    expect(out).toMatchObject({ ok: false, failure: { code: "wrong_workspace" } });
    expect(calls).toBe(0);
  });

  it("refuses a state minted for somebody else", async () => {
    const { state, nonce } = signState({ workspaceId: venture, userId, purpose: "connect" });
    const { out } = await attempt(state, nonce, { userId: outsiderId, workspaceId: venture });
    expect(out).toMatchObject({ ok: false, failure: { code: "wrong_user" } });
  });

  it("refuses a workspace the user is not an active member of", async () => {
    const { state, nonce } = signState({ workspaceId: other, userId: outsiderId, purpose: "connect" });
    const { out, calls } = await attempt(state, nonce, { userId: outsiderId, workspaceId: other });
    expect(out).toMatchObject({ ok: false, failure: { code: "not_member" } });
    expect(calls).toBe(0);
  });
});

describe("Google's own refusals come back as mapped codes", () => {
  it("org_internal from the callback maps to the actionable message", async () => {
    const { failureCode, googleErrorMessage } = await import("../../src/modules/google/errors");
    const { state, nonce } = signState({ workspaceId: venture, userId, purpose: "connect" });
    const out = await completeGoogleOAuth({
      params: new URLSearchParams({ state, error: "org_internal" }),
      cookieNonce: nonce,
      session: { userId, workspaceId: venture },
      doFetch: google().doFetch,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(failureCode(out.failure)).toBe("org_internal");
      expect(googleErrorMessage(failureCode(out.failure)).message).toMatch(/not part of the organisation/);
    }
  });

  it("an invalid_client from the token exchange is mapped, not shown raw", async () => {
    const { failureCode, googleErrorMessage } = await import("../../src/modules/google/errors");
    const { state, nonce } = signState({ workspaceId: other, userId, purpose: "connect" });
    const bad = (async () =>
      new Response(JSON.stringify({ error: "invalid_client", error_description: "The OAuth client was not found." }), {
        status: 401,
      })) as typeof fetch;
    const out = await completeGoogleOAuth({
      params: new URLSearchParams({ state, code: "c" }),
      cookieNonce: nonce,
      session: { userId, workspaceId: other },
      doFetch: bad,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(failureCode(out.failure)).toBe("invalid_client");
      expect(googleErrorMessage("invalid_client").field).toBe("clientId");
    }
  });
});
