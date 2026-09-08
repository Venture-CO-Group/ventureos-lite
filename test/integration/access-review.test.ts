import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import {
  DORMANT_DAYS,
  accessReview,
  employeeExport,
} from "../../src/modules/members/access-review";

/**
 * The access review and the employee data export (§7).
 *
 * The export's boundary is the interesting part: what the system holds about
 * somebody AS A USER, and deliberately not the leads they worked — those are
 * other people's personal data.
 */
const WS = "Review WS";
const ACTIVE = "review-active@ventureco.test";
const DORMANT = "review-dormant@ventureco.test";
const NEVER = "review-never@ventureco.test";
const ADMIN = "review-admin@ventureco.test";
let workspaceId = "";
const ids: Record<string, string> = {};

beforeEach(async () => {
  const existing = await prismaUnsafe.workspace.findFirst({ where: { name: WS } });
  const ws = existing ?? (await prismaUnsafe.workspace.create({ data: { name: WS } }));
  workspaceId = ws.id;
  await prismaUnsafe.invitation.deleteMany({ where: { workspaceId } });

  const now = Date.now();
  for (const [email, lastLoginAt, role] of [
    [ACTIVE, new Date(now - 2 * 86_400_000), "BDR"],
    [DORMANT, new Date(now - (DORMANT_DAYS + 10) * 86_400_000), "BDR"],
    [NEVER, null, "BDR"],
    [ADMIN, new Date(now - 86_400_000), "ADMIN"],
  ] as const) {
    const u = await prismaUnsafe.user.upsert({
      where: { email },
      update: { lastLoginAt },
      create: { email, name: `Review ${email.split("@")[0]}`, passwordHash: "x", lastLoginAt },
    });
    ids[email] = u.id;
    await prismaUnsafe.membership.upsert({
      where: { userId_workspaceId: { userId: u.id, workspaceId } },
      update: { role, state: "ACTIVE", grants: [] },
      create: { userId: u.id, workspaceId, role, grants: [], state: "ACTIVE" },
    });
  }
});

afterAll(async () => {
  await prismaUnsafe.invitation.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.membershipEvent.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.membership.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.user.deleteMany({
    where: { email: { in: [ACTIVE, DORMANT, NEVER, ADMIN] } },
  });
  await prismaUnsafe.workspace.deleteMany({ where: { name: WS } });
});

describe("who is not using their access", () => {
  it("lists the dormant and the never-used, and says which is which", async () => {
    const review = await accessReview(workspaceId);
    const byEmail = new Map(review.dormant.map((r) => [r.email, r]));
    expect(byEmail.get(DORMANT)!.detail).toMatch(/last signed in \d+ days ago/);
    // Different from dormant, and worth saying: an account nobody has ever
    // used is usually one nobody needed.
    expect(byEmail.get(NEVER)!.detail).toBe("has never signed in");
    expect(byEmail.has(ACTIVE)).toBe(false);
  });

  it("does not list somebody who has left", async () => {
    await prismaUnsafe.membership.update({
      where: { userId_workspaceId: { userId: ids[DORMANT]!, workspaceId } },
      data: { state: "REMOVED", removedAt: new Date() },
    });
    const review = await accessReview(workspaceId);
    expect(review.dormant.map((r) => r.email)).not.toContain(DORMANT);
  });
});

describe("who holds the capabilities that bind the company", () => {
  it("includes an Admin, who holds them implicitly", async () => {
    /**
     * Resolved through `grantAllowed`, not by reading the grants array. A list
     * of explicit grants would miss every Admin — which is exactly the set an
     * auditor is asking about.
     */
    const review = await accessReview(workspaceId);
    const admin = review.documentHolders.find((r) => r.email === ADMIN);
    expect(admin).toBeDefined();
    expect(admin!.detail).toBe("all document capabilities");
  });

  it("includes a BDR only once something is handed to them", async () => {
    let review = await accessReview(workspaceId);
    expect(review.documentHolders.map((r) => r.email)).not.toContain(ACTIVE);

    await prismaUnsafe.membership.update({
      where: { userId_workspaceId: { userId: ids[ACTIVE]!, workspaceId } },
      data: { grants: ["documents.send"] },
    });
    review = await accessReview(workspaceId);
    const row = review.documentHolders.find((r) => r.email === ACTIVE);
    expect(row!.detail).toBe("documents.send");
  });
});

describe("invitations that have been out too long", () => {
  it("lists one older than the window and leaves a fresh one alone", async () => {
    const old = new Date(Date.now() - 30 * 86_400_000);
    await prismaUnsafe.invitation.create({
      data: {
        workspaceId,
        email: "stale@example.hu",
        tokenHash: `stale-${Date.now()}`,
        expiresAt: old,
        createdAt: old,
      },
    });
    await prismaUnsafe.invitation.create({
      data: {
        workspaceId,
        email: "fresh@example.hu",
        tokenHash: `fresh-${Date.now()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const review = await accessReview(workspaceId);
    expect(review.staleInvitations.map((i) => i.email)).toEqual(["stale@example.hu"]);
    expect(review.staleInvitations[0]!.detail).toMatch(/expired, sent \d+ days ago/);
  });
});

describe("the employee data export", () => {
  it("gives what we hold about them as a person", async () => {
    await prismaUnsafe.membershipEvent.create({
      data: { workspaceId, userId: ids[ACTIVE]!, kind: "role_changed", reason: "promoted" },
    });

    const data = await employeeExport(workspaceId, ids[ACTIVE]!);
    expect(data!.user).toMatchObject({ email: ACTIVE });
    expect(data!.memberships).toHaveLength(1);
    expect(data!.timeline).toHaveLength(1);
    expect(data!.timeline[0]).toMatchObject({ reason: "promoted" });
    expect(data!.generatedAt).toMatch(/^\d{4}-/);
  });

  it("carries no session token, not even a hash", async () => {
    /**
     * An export somebody can be handed must not contain a credential, and a
     * hash is still a credential's shadow.
     */
    // A value that cannot collide with anything else in the fixture — my
    // first attempt used a `review-` prefix, which the fixture EMAILS also
    // start with, so the assertion failed on correct output.
    const secret = `ZZTOKENZZ-${Date.now()}`;
    await prismaUnsafe.session.create({
      data: {
        userId: ids[ACTIVE]!,
        workspaceId,
        token: secret,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const data = await employeeExport(workspaceId, ids[ACTIVE]!);
    expect(data!.sessions).toHaveLength(1);
    const json = JSON.stringify(data);
    expect(json).not.toContain(secret);
    expect(json).not.toContain("ZZTOKENZZ");
    expect(Object.keys(data!.sessions[0]!)).not.toContain("token");
  });

  it("gives counts of the work they owned, never the records", async () => {
    /**
     * The boundary that matters. Handing an employee a file containing four
     * hundred prospects' names because they asked what we hold about THEM
     * would be a breach dressed as a subject-access response.
     */
    const company = await prismaUnsafe.company.create({
      data: { workspaceId, name: "Review Client Kft." },
    });
    await prismaUnsafe.lead.create({
      data: {
        workspaceId,
        companyId: company.id,
        contactName: "A Prospect Nobody Should See",
        ownerId: ids[ACTIVE]!,
      },
    });

    const data = await employeeExport(workspaceId, ids[ACTIVE]!);
    expect(data!.workCounts.leadsOwned).toBe(1);
    const json = JSON.stringify(data);
    expect(json).not.toContain("A Prospect Nobody Should See");
    expect(json).not.toContain("Review Client Kft.");

    await prismaUnsafe.lead.deleteMany({ where: { workspaceId } });
    await prismaUnsafe.company.deleteMany({ where: { workspaceId } });
  });

  it("returns nothing for a user who does not exist", async () => {
    expect(await employeeExport(workspaceId, "no-such-user")).toBeNull();
  });
});
