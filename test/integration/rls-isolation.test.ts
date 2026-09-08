import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";
import { prismaUnsafe } from "../../src/lib/db";
import { appUserDatabaseUrl } from "../../src/lib/rls";

/**
 * Row-level security, proved WITHOUT the tenant guard (CLAUDE.md hard rule #1).
 *
 * The guard has its own tests and they pass. That is exactly why this file
 * exists: a second belt is only worth having if it holds when the first one is
 * removed, so every query below is made through a bare client with no guard
 * extension at all — deliberately the shape of the bug this layer defends
 * against, an application query that forgot to scope itself.
 *
 * Before this was written the policies were applied on every deploy and did
 * nothing: the app connects as the database owner, and a superuser bypasses RLS
 * whatever FORCE says. Measured against production first — as the app's own
 * role, `select count(*) from leads` returned 73; as `app_user` with no session
 * variable, 0.
 */
const NAMES = ["RLS Alpha", "RLS Bravo"];
let wsA = "";
let wsB = "";
/** A bare client on the restricted role: no tenant guard, no scoping at all. */
let bare: PrismaClient;

const isPostgres = (process.env.DB_FLAVOR ?? "postgres") === "postgres";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of ["lead", "company"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  if (!isPostgres) return;
  // Policies come from test/global-setup.ts — applied once for the whole run,
  // because two files applying them in parallel raced each other's queries.
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
  await prismaUnsafe.company.create({ data: { workspaceId: wsA, name: "Alpha Kft." } });
  await prismaUnsafe.company.create({ data: { workspaceId: wsB, name: "Bravo Kft." } });
  await prismaUnsafe.lead.create({ data: { workspaceId: wsA, contactName: "Alpha Anna" } });
  await prismaUnsafe.lead.create({ data: { workspaceId: wsB, contactName: "Bravo Bea" } });

  bare = new PrismaClient({ datasources: { db: { url: appUserDatabaseUrl() } } });
});

afterAll(async () => {
  if (!isPostgres) return;
  await bare?.$disconnect();
  await clean();
});

/** Run one query with the workspace declared, exactly as the extension does. */
async function asWorkspace<T>(
  workspaceId: string,
  run: () => Prisma.PrismaPromise<T>,
): Promise<T> {
  const [, result] = await bare.$transaction([
    bare.$executeRaw`SELECT set_config('app.current_workspace', ${workspaceId}, TRUE)`,
    run(),
  ]);
  return result;
}

describe.skipIf(!isPostgres)("row-level security", () => {
  it("shows a workspace its own rows", async () => {
    const leads = await asWorkspace(wsA, () => bare.lead.findMany({ where: {} }));
    expect(leads.map((l) => l.contactName)).toEqual(["Alpha Anna"]);
  });

  /**
   * THE ONE THAT MATTERS. An unscoped query — the bug — returns the other
   * workspace's row today, because the guard is what stops it. Under RLS the
   * database refuses on its own.
   */
  it("hides another workspace's rows from an UNSCOPED query", async () => {
    const leads = await asWorkspace(wsA, () => bare.lead.findMany({ where: {} }));
    expect(leads).toHaveLength(1);
    expect(leads.map((l) => l.contactName)).not.toContain("Bravo Bea");
  });

  it("refuses a direct read of another workspace's row by id", async () => {
    const bravo = await prismaUnsafe.lead.findFirst({ where: { workspaceId: wsB } });
    const found = await asWorkspace(wsA, () =>
      bare.lead.findUnique({ where: { id: bravo!.id } }),
    );
    expect(found).toBeNull();
  });

  it("refuses to WRITE a row into another workspace", async () => {
    await expect(
      asWorkspace(wsA, () =>
        bare.lead.create({ data: { workspaceId: wsB, contactName: "Smuggled" } }),
      ),
    ).rejects.toThrow();
    // And nothing landed.
    expect(
      await prismaUnsafe.lead.count({ where: { workspaceId: wsB, contactName: "Smuggled" } }),
    ).toBe(0);
  });

  it("refuses to update another workspace's row", async () => {
    const bravo = await prismaUnsafe.lead.findFirst({ where: { workspaceId: wsB } });
    const updated = await asWorkspace(wsA, () =>
      bare.lead.updateMany({ where: { id: bravo!.id }, data: { contactName: "Overwritten" } }),
    );
    expect(updated.count).toBe(0);
    const after = await prismaUnsafe.lead.findUnique({ where: { id: bravo!.id } });
    expect(after!.contactName).toBe("Bravo Bea");
  });

  it("refuses to delete another workspace's row", async () => {
    const bravo = await prismaUnsafe.lead.findFirst({ where: { workspaceId: wsB } });
    const deleted = await asWorkspace(wsA, () =>
      bare.lead.deleteMany({ where: { id: bravo!.id } }),
    );
    expect(deleted.count).toBe(0);
    expect(await prismaUnsafe.lead.count({ where: { id: bravo!.id } })).toBe(1);
  });

  /**
   * With no workspace declared the answer is nothing — fail closed. This is
   * what a query that escaped the guard entirely would hit.
   */
  it("shows nothing at all when no workspace is declared", async () => {
    expect(await bare.lead.findMany({ where: {} })).toHaveLength(0);
    expect(await bare.company.findMany({ where: {} })).toHaveLength(0);
  });

  /**
   * Connections are pooled: a session-level setting would leak to whichever
   * request picked the connection up next, which is the very bug this layer
   * exists to catch. `set_config(..., TRUE)` is transaction-local.
   */
  it("does not leak the workspace to the next query on the same connection", async () => {
    await asWorkspace(wsA, () => bare.lead.findMany({ where: {} }));
    expect(await bare.lead.findMany({ where: {} })).toHaveLength(0);
  });

  it("still lets the owner connection through — that is the escape hatch", async () => {
    expect(await prismaUnsafe.lead.count({ where: { workspaceId: { in: [wsA, wsB] } } })).toBe(2);
  });
});

/**
 * ── THE PUBLIC-INTAKE TABLES, AND A PRODUCTION-ONLY BUG THIS PINS DOWN ──────
 *
 * Some tables have to be reachable with NO workspace declared, because the
 * request that reaches them has no session: an anonymous visitor submitting an
 * audit, reading a shared quote, booking a slot — or accepting an invitation.
 *
 * `invitations` was written as an ordinary business table, and the whole
 * invitation flow passed every test. It would have failed on the server and
 * only on the server:
 *
 *   - every business table has FORCE ROW LEVEL SECURITY, so even the table
 *     owner is subject to its policy;
 *   - production's `DATABASE_URL` connects as `app_user`, which is not a
 *     superuser;
 *   - a developer's `DATABASE_URL` is the owner role, which IS a superuser and
 *     bypasses RLS entirely.
 *
 * So the accept page read the invitation perfectly in development and would
 * have said "This invitation link is not valid" for every link in production.
 * Caught by asking what role production connects as, proved with `SET ROLE
 * app_user`, and this is the test that stops it coming back.
 */
describe.skipIf(!isPostgres)("tables an unauthenticated request must reach", () => {
  it("lets an invitation be found by its token with no workspace declared", async () => {
    const token = `rls-suite-${Date.now()}`;
    await prismaUnsafe.invitation.create({
      data: {
        workspaceId: wsA,
        email: "rls-suite@example.hu",
        tokenHash: token,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    try {
      // No `set_config` at all — exactly the public accept path.
      const found = await bare.invitation.findUnique({ where: { tokenHash: token } });
      expect(found, "app_user cannot see the invitation it was handed").not.toBeNull();
      expect(found!.email).toBe("rls-suite@example.hu");
    } finally {
      await prismaUnsafe.invitation.deleteMany({ where: { tokenHash: token } });
    }
  });

  it("still refuses it to a connection that declares the wrong workspace", async () => {
    /**
     * The other half. "Reachable anonymously" must not mean "reachable by
     * anybody who names a workspace" — once a workspace IS declared, the row
     * has to belong to it.
     */
    const token = `rls-suite-b-${Date.now()}`;
    await prismaUnsafe.invitation.create({
      data: {
        workspaceId: wsA,
        email: "rls-suite-b@example.hu",
        tokenHash: token,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    try {
      const fromB = await asWorkspace(wsB, () =>
        bare.invitation.findMany({ where: { tokenHash: token } }),
      );
      expect(fromB).toHaveLength(0);
      const fromA = await asWorkspace(wsA, () =>
        bare.invitation.findMany({ where: { tokenHash: token } }),
      );
      expect(fromA).toHaveLength(1);
    } finally {
      await prismaUnsafe.invitation.deleteMany({ where: { tokenHash: token } });
    }
  });

  it("keeps the member lifecycle's other tables workspace-scoped", async () => {
    // These are only ever read with a workspace in hand, so they stay ordinary
    // business tables — and an anonymous read of them must see nothing.
    await prismaUnsafe.membershipEvent.create({
      data: { workspaceId: wsA, userId: "rls-suite-user", kind: "invited" },
    });
    const team = await prismaUnsafe.team.create({
      data: { workspaceId: wsA, name: `RLS Suite Team ${Date.now()}` },
    });
    try {
      expect(await bare.membershipEvent.findMany({ where: { workspaceId: wsA } })).toHaveLength(0);
      expect(await bare.team.findMany({ where: { workspaceId: wsA } })).toHaveLength(0);
      // And visible once the workspace is declared.
      expect(
        await asWorkspace(wsA, () => bare.team.findMany({ where: { id: team.id } })),
      ).toHaveLength(1);
    } finally {
      await prismaUnsafe.membershipEvent.deleteMany({ where: { workspaceId: wsA } });
      await prismaUnsafe.team.deleteMany({ where: { id: team.id } });
    }
  });
});
