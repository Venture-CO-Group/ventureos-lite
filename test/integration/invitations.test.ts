import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { prismaUnsafe } from "../../src/lib/db";
import {
  inspectInvitation,
  issueInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from "../../src/modules/members/invitation-store";
import { beginAccept, acceptSetPassword, acceptVerifyTotp } from "../../src/modules/members/accept";
import { codeForStep, totpStep } from "../../src/lib/auth/totp";

/**
 * The invitation flow, end to end against a real database (§2).
 *
 * Every edge case the spec lists is here, because each one is a decision that
 * is easy to get subtly wrong: what an expired link may offer, what a revoked
 * one is allowed to SAY, whether somebody who already has an account is asked
 * for a password again, and whether two tabs can spend one token.
 */
const WS = "Invite Flow WS";
const OWNER = "invite-owner@ventureco.test";
const FRESH = "invite-fresh@ventureco.test";
const EXISTING = "invite-existing@ventureco.test";
const MEMBER = "invite-member@ventureco.test";
const PASSWORD = "a-perfectly-fine-password-99";

let workspaceId = "";
let otherWorkspaceId = "";
let ownerId = "";

/** The token is only ever returned as a URL; this pulls it back out. */
function tokenFrom(url: string): string {
  return url.split("/invite/")[1]!;
}

async function ensure() {
  for (const [name, set] of [
    [WS, (id: string) => (workspaceId = id)],
    [`${WS} Other`, (id: string) => (otherWorkspaceId = id)],
  ] as const) {
    const existing = await prismaUnsafe.workspace.findFirst({ where: { name } });
    const ws = existing ?? (await prismaUnsafe.workspace.create({ data: { name } }));
    set(ws.id);
  }

  const owner = await prismaUnsafe.user.upsert({
    where: { email: OWNER },
    update: {},
    create: { email: OWNER, name: "Invite Owner", passwordHash: "x" },
  });
  ownerId = owner.id;
  await prismaUnsafe.membership.upsert({
    where: { userId_workspaceId: { userId: owner.id, workspaceId } },
    update: { role: "OWNER", state: "ACTIVE" },
    create: { userId: owner.id, workspaceId, role: "OWNER", grants: [], state: "ACTIVE" },
  });

  // Somebody with an account on ANOTHER workspace — the "skip the password
  // step" case.
  const existing = await prismaUnsafe.user.upsert({
    where: { email: EXISTING },
    update: { passwordHash: "$2a$10$abcdefghijklmnopqrstuv", totpEnabled: false },
    create: {
      email: EXISTING,
      name: "Already Has One",
      passwordHash: "$2a$10$abcdefghijklmnopqrstuv",
    },
  });
  await prismaUnsafe.membership.upsert({
    where: { userId_workspaceId: { userId: existing.id, workspaceId: otherWorkspaceId } },
    update: { state: "ACTIVE" },
    create: { userId: existing.id, workspaceId: otherWorkspaceId, role: "BDR", grants: [] },
  });

  // And somebody who is already a member HERE.
  const member = await prismaUnsafe.user.upsert({
    where: { email: MEMBER },
    update: {},
    create: { email: MEMBER, name: "Already A Member", passwordHash: "x" },
  });
  await prismaUnsafe.membership.upsert({
    where: { userId_workspaceId: { userId: member.id, workspaceId } },
    update: { state: "ACTIVE", role: "BDR" },
    create: { userId: member.id, workspaceId, role: "BDR", grants: [] },
  });
}

async function clear() {
  for (const id of [workspaceId, otherWorkspaceId].filter(Boolean)) {
    await prismaUnsafe.invitation.deleteMany({ where: { workspaceId: id } });
    await prismaUnsafe.membershipEvent.deleteMany({ where: { workspaceId: id } });
    await prismaUnsafe.auditLog.deleteMany({ where: { workspaceId: id } });
    await prismaUnsafe.notification.deleteMany({ where: { workspaceId: id } });
  }
  const fresh = await prismaUnsafe.user.findUnique({ where: { email: FRESH } });
  if (fresh) {
    await prismaUnsafe.membership.deleteMany({ where: { userId: fresh.id } });
    await prismaUnsafe.user.delete({ where: { id: fresh.id } });
  }
  /**
   * And the placeholder membership issuing an invitation leaves behind.
   *
   * `EXISTING` is the "already has an account elsewhere" fixture, and inviting
   * them creates an INVITED membership in THIS workspace. Without clearing it,
   * the second test to invite them is refused with "they already have an
   * invitation out" — a fixture leak that produced five failures in four
   * different tests and pointed at none of them.
   */
  const existing = await prismaUnsafe.user.findUnique({ where: { email: EXISTING } });
  if (existing && workspaceId) {
    await prismaUnsafe.membership.deleteMany({
      where: { userId: existing.id, workspaceId },
    });
  }
}

beforeEach(async () => {
  await ensure();
  await clear();
});

afterAll(async () => {
  await clear();
  for (const id of [workspaceId, otherWorkspaceId].filter(Boolean)) {
    await prismaUnsafe.membership.deleteMany({ where: { workspaceId: id } });
  }
  await prismaUnsafe.user.deleteMany({
    where: { email: { in: [OWNER, FRESH, EXISTING, MEMBER] } },
  });
  await prismaUnsafe.workspace.deleteMany({ where: { name: { in: [WS, `${WS} Other`] } } });
});

async function invite(email = FRESH, role = "BDR", grants: string[] = []) {
  const res = await issueInvitation({
    workspaceId,
    actorUserId: ownerId,
    email,
    role,
    grants,
  });
  if (!res.ok) throw new Error(`invite failed: ${res.error}`);
  return res;
}

describe("issuing an invitation", () => {
  it("stores only a hash of the token", async () => {
    const res = await invite();
    const token = tokenFrom(res.url);
    const row = await prismaUnsafe.invitation.findFirst({ where: { email: FRESH } });
    /**
     * The token is the credential. A database leak must not yield a working
     * invitation — the same rule a password reset link follows.
     */
    expect(row!.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row!.tokenHash).not.toBe(token);
    expect(token.length).toBeGreaterThan(30);
  });

  it("lasts seven days", async () => {
    await invite();
    const row = await prismaUnsafe.invitation.findFirst({ where: { email: FRESH } });
    const days = (row!.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it("refuses somebody who is already a member, and says which case it is", async () => {
    const res = await issueInvitation({
      workspaceId,
      actorUserId: ownerId,
      email: MEMBER,
      role: "BDR",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already a member/i);
  });

  it("points at resend rather than issuing a second live invitation", async () => {
    /**
     * Two live invitations to one address means two working tokens, and
     * revoking one would leave the other alive.
     */
    await invite();
    const second = await issueInvitation({
      workspaceId,
      actorUserId: ownerId,
      email: FRESH,
      role: "BDR",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already out/i);
  });

  it("allows a second invitation once the first is revoked", async () => {
    const first = await invite();
    const row = await prismaUnsafe.invitation.findFirstOrThrow({ where: { email: FRESH } });
    await revokeInvitation({ workspaceId, actorUserId: ownerId, invitationId: row.id });
    const second = await issueInvitation({
      workspaceId,
      actorUserId: ownerId,
      email: FRESH,
      role: "BDR",
    });
    expect(second.ok).toBe(true);
    // A new row with its own history, not an edit of the old one.
    expect(await prismaUnsafe.invitation.count({ where: { email: FRESH } })).toBe(2);
    // And the first token is dead.
    const dead = await inspectInvitation(tokenFrom(first.url));
    expect(dead.verdict.ok).toBe(false);
  });

  it("says so when the invitee already has an account elsewhere", async () => {
    const res = await issueInvitation({
      workspaceId,
      actorUserId: ownerId,
      email: EXISTING,
      role: "BDR",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.existingAccount).toBe(true);
  });

  it("creates no user row for somebody with no account", async () => {
    /**
     * Before acceptance nobody has agreed to anything. Putting a person in the
     * database because an Owner typed their address is putting a person there
     * who never asked to be.
     */
    await invite();
    expect(await prismaUnsafe.user.findUnique({ where: { email: FRESH } })).toBeNull();
  });

  it("shows an existing account as a pending member straight away", async () => {
    await issueInvitation({ workspaceId, actorUserId: ownerId, email: EXISTING, role: "ADMIN" });
    const user = await prismaUnsafe.user.findUniqueOrThrow({ where: { email: EXISTING } });
    const membership = await prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
    });
    expect(membership!.state).toBe("INVITED");
    expect(membership!.role).toBe("ADMIN");
  });

  it("writes the timeline and the audit log together", async () => {
    await issueInvitation({ workspaceId, actorUserId: ownerId, email: EXISTING, role: "BDR" });
    const events = await prismaUnsafe.membershipEvent.findMany({ where: { workspaceId } });
    expect(events.map((e) => e.kind)).toContain("invited");
    // The ground rule: a timeline entry cannot exist without an audit entry.
    const audit = await prismaUnsafe.auditLog.findMany({ where: { workspaceId } });
    expect(audit.map((a) => a.action)).toContain("member.invited");
    expect(audit[0]!.actorUserId).toBe(ownerId);
  });
});

describe("what the accept page is told", () => {
  it("lets a live token through, naming the workspace", async () => {
    const res = await invite();
    const out = await inspectInvitation(tokenFrom(res.url));
    expect(out.verdict.ok).toBe(true);
    expect(out.email).toBe(FRESH);
    expect(out.workspaceName).toBe(WS);
    expect(out.hasAccount).toBe(false);
  });

  it("gives a revoked token exactly the answer an unknown token gets", async () => {
    /**
     * The one place information could leak. "This invitation was withdrawn"
     * would tell whoever holds it that the address is a real account here and
     * that somebody decided against them.
     */
    const res = await invite();
    const row = await prismaUnsafe.invitation.findFirstOrThrow({ where: { email: FRESH } });
    await revokeInvitation({ workspaceId, actorUserId: ownerId, invitationId: row.id });

    const revoked = await inspectInvitation(tokenFrom(res.url));
    const unknown = await inspectInvitation("a".repeat(43));
    expect(revoked.verdict).toEqual(unknown.verdict);
    expect(revoked.email).toBeUndefined();
    expect(revoked.workspaceName).toBeUndefined();
  });

  it("tells an expired token the truth and offers a resend", async () => {
    const res = await invite();
    await prismaUnsafe.invitation.updateMany({
      where: { email: FRESH },
      data: { expiresAt: new Date(Date.now() - 86_400_000) },
    });
    const out = await inspectInvitation(tokenFrom(res.url));
    expect(out.verdict.ok).toBe(false);
    if (!out.verdict.ok) {
      expect(out.verdict.reason).toBe("expired");
      expect(out.verdict.canResend).toBe(true);
    }
  });

  it("skips the password step for somebody who already has one", async () => {
    const res = await issueInvitation({
      workspaceId,
      actorUserId: ownerId,
      email: EXISTING,
      role: "BDR",
    });
    if (!res.ok) throw new Error(res.error);
    const begun = await beginAccept(tokenFrom(res.url));
    expect(begun.ok).toBe(true);
    if (begun.ok) {
      // One person, one login, however many workspaces.
      expect(begun.state.hasAccount).toBe(true);
      expect(begun.state.step).toBe("totp");
    }
  });
});

describe("accepting", () => {
  it("sets a password, then requires an authenticator before the membership is real", async () => {
    const res = await invite();
    const token = tokenFrom(res.url);

    const step1 = await acceptSetPassword({ token, name: "Fresh Person", password: PASSWORD });
    expect(step1.ok).toBe(true);

    const user = await prismaUnsafe.user.findUniqueOrThrow({ where: { email: FRESH } });
    /**
     * Two-factor is not optional here, and this is the assertion that says so.
     * After the password step the secret is STAGED and not enabled, and there
     * is no active membership — so a closed tab leaves a resumable
     * interruption rather than a member who skipped 2FA.
     */
    expect(user.totpSecret).toBeTruthy();
    expect(user.totpEnabled).toBe(false);
    const before = await prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
    });
    expect(before).toBeNull();

    const code = codeForStep(user.totpSecret!, totpStep(Date.now()));
    const step2 = await acceptVerifyTotp({ token, code });
    expect(step2.ok).toBe(true);

    const after = await prismaUnsafe.user.findUniqueOrThrow({ where: { email: FRESH } });
    expect(after.totpEnabled).toBe(true);
    const membership = await prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
    });
    expect(membership!.state).toBe("ACTIVE");
    expect(membership!.role).toBe("BDR");
  });

  it("refuses a wrong code without consuming the invitation", async () => {
    const res = await invite();
    const token = tokenFrom(res.url);
    await acceptSetPassword({ token, name: "Fresh Person", password: PASSWORD });

    const bad = await acceptVerifyTotp({ token, code: "000000" });
    expect(bad.ok).toBe(false);
    const row = await prismaUnsafe.invitation.findFirstOrThrow({ where: { email: FRESH } });
    expect(row.acceptedAt).toBeNull();
  });

  it("cannot be spent twice", async () => {
    const res = await invite();
    const token = tokenFrom(res.url);
    await acceptSetPassword({ token, name: "Fresh Person", password: PASSWORD });
    const user = await prismaUnsafe.user.findUniqueOrThrow({ where: { email: FRESH } });
    const code = codeForStep(user.totpSecret!, totpStep(Date.now()));
    expect((await acceptVerifyTotp({ token, code })).ok).toBe(true);

    // Same token, again. Single-use is the contract.
    const again = await acceptVerifyTotp({ token, code });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/already been used|not valid/i);
  });

  it("carries the grant preset onto the membership", async () => {
    const res = await invite(FRESH, "BDR", ["documents.quote.create", "templates.edit"]);
    const token = tokenFrom(res.url);
    await acceptSetPassword({ token, name: "Fresh Person", password: PASSWORD });
    const user = await prismaUnsafe.user.findUniqueOrThrow({ where: { email: FRESH } });
    await acceptVerifyTotp({
      token,
      code: codeForStep(user.totpSecret!, totpStep(Date.now())),
    });
    const membership = await prismaUnsafe.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
    });
    expect(membership.grants).toEqual(["documents.quote.create", "templates.edit"]);
  });

  it("refuses a weak password with every reason at once", async () => {
    const res = await invite();
    const out = await acceptSetPassword({
      token: tokenFrom(res.url),
      name: "Fresh",
      password: "aaa",
    });
    expect(out.ok).toBe(false);
    // A form that reports one rule at a time is a form somebody submits four
    // times.
    if (!out.ok) expect(out.error).toMatch(/12 characters/);
  });

  it("tells the Owner who invited them", async () => {
    const res = await invite();
    const token = tokenFrom(res.url);
    await acceptSetPassword({ token, name: "Fresh Person", password: PASSWORD });
    const user = await prismaUnsafe.user.findUniqueOrThrow({ where: { email: FRESH } });
    await acceptVerifyTotp({
      token,
      code: codeForStep(user.totpSecret!, totpStep(Date.now())),
    });

    const notes = await prismaUnsafe.notification.findMany({ where: { workspaceId, userId: ownerId } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toContain("joined the workspace");
    // And the timeline records the acceptance.
    const events = await prismaUnsafe.membershipEvent.findMany({
      where: { workspaceId, userId: user.id },
    });
    expect(events.map((e) => e.kind)).toContain("accepted");
  });
});

describe("resending and revoking", () => {
  it("issues a NEW token and kills the old one", async () => {
    /**
     * Not the same string re-sent: an expired invitation cannot be revived by
     * mailing a dead token, and one that has sat in an inbox for a fortnight
     * has had a fortnight of exposure.
     */
    const first = await invite();
    const row = await prismaUnsafe.invitation.findFirstOrThrow({ where: { email: FRESH } });
    await prismaUnsafe.invitation.update({
      where: { id: row.id },
      data: { lastSentAt: new Date(Date.now() - 3_600_000) },
    });

    const res = await resendInvitation({ workspaceId, actorUserId: ownerId, invitationId: row.id });
    expect(res.ok).toBe(true);

    const dead = await inspectInvitation(tokenFrom(first.url));
    expect(dead.verdict.ok).toBe(false);
    const after = await prismaUnsafe.invitation.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.resendCount).toBe(1);
    expect(after.expiresAt.getTime()).toBeGreaterThan(row.expiresAt.getTime());
  });

  it("refuses a resend inside the cooldown", async () => {
    await invite();
    const row = await prismaUnsafe.invitation.findFirstOrThrow({ where: { email: FRESH } });
    const res = await resendInvitation({ workspaceId, actorUserId: ownerId, invitationId: row.id });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/minute/);
  });

  it("resends an EXPIRED one, which is what the accept page offers", async () => {
    await invite();
    const row = await prismaUnsafe.invitation.findFirstOrThrow({ where: { email: FRESH } });
    await prismaUnsafe.invitation.update({
      where: { id: row.id },
      data: {
        expiresAt: new Date(Date.now() - 86_400_000),
        lastSentAt: new Date(Date.now() - 3_600_000),
      },
    });
    expect(
      (await resendInvitation({ workspaceId, actorUserId: ownerId, invitationId: row.id })).ok,
    ).toBe(true);
  });

  it("refuses to revoke one that was already accepted", async () => {
    await invite();
    const row = await prismaUnsafe.invitation.findFirstOrThrow({ where: { email: FRESH } });
    await prismaUnsafe.invitation.update({
      where: { id: row.id },
      data: { acceptedAt: new Date() },
    });
    const res = await revokeInvitation({ workspaceId, actorUserId: ownerId, invitationId: row.id });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/suspend or remove/i);
  });

  it("takes the placeholder membership down with a revocation", async () => {
    await issueInvitation({ workspaceId, actorUserId: ownerId, email: EXISTING, role: "BDR" });
    const row = await prismaUnsafe.invitation.findFirstOrThrow({ where: { email: EXISTING } });
    await revokeInvitation({ workspaceId, actorUserId: ownerId, invitationId: row.id });

    const user = await prismaUnsafe.user.findUniqueOrThrow({ where: { email: EXISTING } });
    const membership = await prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
    });
    // Otherwise the members screen shows a pending person whose invitation is
    // dead.
    expect(membership!.state).toBe("REMOVED");
  });
});

describe("the outstanding list", () => {
  it("reports each invitation's state", async () => {
    await invite();
    await issueInvitation({ workspaceId, actorUserId: ownerId, email: EXISTING, role: "BDR" });
    const second = await prismaUnsafe.invitation.findFirstOrThrow({ where: { email: EXISTING } });
    await revokeInvitation({ workspaceId, actorUserId: ownerId, invitationId: second.id });

    const list = await listInvitations(workspaceId);
    const byEmail = new Map(list.map((i) => [i.email, i]));
    expect(byEmail.get(FRESH)!.state).toBe("pending");
    expect(byEmail.get(EXISTING)!.state).toBe("revoked");
    expect(byEmail.get(FRESH)!.invitedByName).toBe("Invite Owner");
  });

  it("drops one that has been accepted", async () => {
    // An accepted invitation is a member; it belongs in the members table.
    await invite();
    await prismaUnsafe.invitation.updateMany({
      where: { email: FRESH },
      data: { acceptedAt: new Date() },
    });
    expect(await listInvitations(workspaceId)).toHaveLength(0);
  });
});
