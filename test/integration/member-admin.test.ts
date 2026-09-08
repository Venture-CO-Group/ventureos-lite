import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { prismaUnsafe } from "../../src/lib/db";
import { confirmEmailChangeToken } from "../../src/modules/members/email-change";

/**
 * The member administration actions that need a database (§4).
 *
 * The Owner-gated entry points go through `getActiveContext`, which needs a
 * request — and importing that module at all drags Auth.js in, which does not
 * load under vitest. So the confirm path lives in a plain store module and is
 * tested directly here; the gated paths are covered end to end in
 * `e2e/member-admin.spec.ts`.
 */
const EMAIL = "admin-target@ventureco.test";
const NEW_EMAIL = "admin-target-new@ventureco.test";
const OTHER = "admin-other@ventureco.test";
let userId = "";

function hash(t: string) {
  return createHash("sha256").update(t).digest("hex");
}

/**
 * Tokens unique to this RUN.
 *
 * `token_hash` is globally unique, and the fixture user is deleted and
 * recreated with a fresh id every run — so a cleanup scoped to `userId` left
 * the previous run's rows behind and the second run failed on the unique
 * index. The failure appeared only in the full suite, which is the most
 * expensive kind.
 */
const RUN = Date.now().toString(36);
const tok = (name: string) => `token-${name}-${RUN}-aaaaaaaaaaaa`;

beforeEach(async () => {
  for (const email of [EMAIL, OTHER]) {
    const u = await prismaUnsafe.user.upsert({
      where: { email },
      update: {},
      create: { email, name: `Admin ${email}`, passwordHash: "x" },
    });
    if (email === EMAIL) userId = u.id;
  }
  await prismaUnsafe.user.deleteMany({ where: { email: NEW_EMAIL } });
  // By address as well as by user: see the note on RUN above.
  await prismaUnsafe.emailChange.deleteMany({
    where: { OR: [{ userId }, { newEmail: { in: [NEW_EMAIL, OTHER] } }] },
  });
  await prismaUnsafe.user.update({ where: { id: userId }, data: { email: EMAIL } });
});

afterAll(async () => {
  await prismaUnsafe.emailChange.deleteMany({
    where: { OR: [{ userId }, { newEmail: { in: [NEW_EMAIL, OTHER] } }] },
  });
  await prismaUnsafe.user.deleteMany({
    where: { email: { in: [EMAIL, NEW_EMAIL, OTHER] } },
  });
});

async function stage(token: string, opts: Partial<{ expiresAt: Date; newEmail: string }> = {}) {
  return prismaUnsafe.emailChange.create({
    data: {
      userId,
      newEmail: opts.newEmail ?? NEW_EMAIL,
      tokenHash: hash(token),
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000),
    },
  });
}

describe("confirming an email change", () => {
  it("moves the address and revokes every session", async () => {
    await prismaUnsafe.session.create({
      data: {
        userId,
        token: `admin-test-${Date.now()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await stage(tok("a"));

    const res = await confirmEmailChangeToken(tok("a"));
    expect(res.ok).toBe(true);

    const user = await prismaUnsafe.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.email).toBe(NEW_EMAIL);
    /**
     * The sign-in identity changed, so a session minted against the old one is
     * a session whose subject no longer exists in the form it was issued for.
     */
    const live = await prismaUnsafe.session.count({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    expect(live).toBe(0);
  });

  it("does not touch the address until the link is clicked", async () => {
    await stage(tok("b"));
    // The whole point of staging: a typo in the new address must not lock
    // somebody out, and nobody finds a typo until they try to sign in.
    const user = await prismaUnsafe.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.email).toBe(EMAIL);
  });

  it("cannot be used twice", async () => {
    await stage(tok("c"));
    expect((await confirmEmailChangeToken(tok("c"))).ok).toBe(true);
    const again = await confirmEmailChangeToken(tok("c"));
    expect(again.ok).toBe(false);
  });

  it("refuses an expired link, and says so rather than extending it", async () => {
    await stage(tok("d"), {
      expiresAt: new Date(Date.now() - 60_000),
    });
    const res = await confirmEmailChangeToken(tok("d"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/expired/i);
    const user = await prismaUnsafe.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.email).toBe(EMAIL);
  });

  it("gives a cancelled link the same answer as one nobody issued", async () => {
    // Same reasoning as a revoked invitation: a distinguishable refusal tells
    // whoever holds it that the address is real.
    const row = await stage(tok("e"));
    await prismaUnsafe.emailChange.update({
      where: { id: row.id },
      data: { cancelledAt: new Date() },
    });
    const cancelled = await confirmEmailChangeToken(tok("e"));
    const unknown = await confirmEmailChangeToken(tok("z"));
    expect(cancelled).toEqual(unknown);
  });

  it("refuses when another account has taken the address since", async () => {
    await stage(tok("f"), { newEmail: OTHER });
    const res = await confirmEmailChangeToken(tok("f"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/taken that address/i);
  });

  it("stores only a hash of the token", async () => {
    const row = await stage(tok("g"));
    expect(row.tokenHash).not.toBe(tok("g"));
    expect(row.tokenHash).toBe(hash(tok("g")));
  });

  it("records the change on every workspace they are in", async () => {
    /**
     * The email is on the USER, so one confirmation changes their sign-in
     * identity everywhere. Each workspace's timeline gets the entry, because
     * each workspace's Owner is entitled to see it.
     */
    const ws = await prismaUnsafe.workspace.create({ data: { name: `Admin WS ${Date.now()}` } });
    await prismaUnsafe.membership.create({
      data: { userId, workspaceId: ws.id, role: "BDR", grants: [], state: "ACTIVE" },
    });
    await stage(tok("h"));
    await confirmEmailChangeToken(tok("h"));

    const events = await prismaUnsafe.membershipEvent.findMany({
      where: { workspaceId: ws.id, userId, kind: "email_changed" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.before).toMatchObject({ email: EMAIL });
    expect(events[0]!.after).toMatchObject({ email: NEW_EMAIL });

    await prismaUnsafe.membershipEvent.deleteMany({ where: { workspaceId: ws.id } });
    await prismaUnsafe.auditLog.deleteMany({ where: { workspaceId: ws.id } });
    await prismaUnsafe.membership.deleteMany({ where: { workspaceId: ws.id } });
    await prismaUnsafe.workspace.delete({ where: { id: ws.id } });
  });

  it("refuses a token that is obviously not one", async () => {
    for (const t of ["", "short", "x".repeat(15)]) {
      expect((await confirmEmailChangeToken(t)).ok).toBe(false);
    }
  });
});
