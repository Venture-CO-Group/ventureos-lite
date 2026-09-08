import { describe, it, expect, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { provisionWorkspace } from "../../src/modules/workspaces/provision";

/**
 * A workspace created through the product used to come out as a bare row.
 *
 * `prisma/seed.ts` built the ICP config, the deal pipelines, the document
 * templates and the targets for the FIRST workspace; `createWorkspace` — the
 * Owner-facing form — built none of them. Nothing crashed, which is why it
 * survived: the Deals board simply had no columns, a quote simply could not be
 * rendered, and the dashboard simply measured against nothing. From outside,
 * the only available reading was "workspace switching does not work".
 */
/** Every name this file can create, so cleanup is complete even after a crash. */
const NAMES = ["Provision Test A", "Provision Test B", "Provision Test C"];

async function freshWorkspace(name: string): Promise<string> {
  const ws = await prismaUnsafe.workspace.create({ data: { name } });
  return ws.id;
}

/**
 * Clean up EVERY workspace matching the test names, not just the first.
 *
 * The first version used `findFirst` per name, which cleared one row each. A
 * run that crashed before its own cleanup therefore left workspaces behind
 * that no later run could ever remove — and a leftover extra workspace is not
 * inert: with more than one workspace and no `PUBLIC_INTAKE_WORKSPACE_ID`,
 * `getPublicIntakeWorkspaceId()` refuses to guess, and the three public
 * subdomains stop resolving. Two unrelated e2e specs failed for days because
 * of three rows this file left on the floor.
 */
afterAll(async () => {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  for (const ws of stale) {
    await prismaUnsafe.dealStage.deleteMany({ where: { workspaceId: ws.id } });
    await prismaUnsafe.pipeline.deleteMany({ where: { workspaceId: ws.id } });
    await prismaUnsafe.template.deleteMany({ where: { workspaceId: ws.id } });
    await prismaUnsafe.target.deleteMany({ where: { workspaceId: ws.id } });
    await prismaUnsafe.membership.deleteMany({ where: { workspaceId: ws.id } });
    await prismaUnsafe.auditLog.deleteMany({ where: { workspaceId: ws.id } });
    await prismaUnsafe.workspace.delete({ where: { id: ws.id } });
  }
});

describe("a newly provisioned workspace is usable, not merely present", () => {
  it("has the scaffolding every screen assumes", async () => {
    const id = await freshWorkspace("Provision Test A");

    // The state the bug shipped: a row and nothing else.
    expect(await prismaUnsafe.pipeline.count({ where: { workspaceId: id } })).toBe(0);
    expect(await prismaUnsafe.template.count({ where: { workspaceId: id } })).toBe(0);

    const added = await provisionWorkspace(prismaUnsafe, id);

    // Deals needs columns to drop a deal into.
    expect(added.pipelines).toBeGreaterThan(0);
    const stages = await prismaUnsafe.dealStage.count({ where: { workspaceId: id } });
    expect(stages).toBeGreaterThan(0);

    // A legal document renders from a versioned template and nothing else
    // (hard rule #4), so a workspace without templates cannot produce one.
    expect(added.templates).toBeGreaterThan(0);

    // The score gate (hard rule #5) reads its threshold from the ICP config.
    expect(added.icpConfig).toBe(true);
    const ws = await prismaUnsafe.workspace.findUnique({
      where: { id },
      select: { icpConfig: true },
    });
    expect((ws!.icpConfig as { gateThreshold?: number }).gateThreshold).toBe(3);

    // The dashboard measures against these.
    expect(added.targets).toBeGreaterThan(0);
  });

  it("is idempotent, so it can repair an old workspace without damaging it", async () => {
    const id = await freshWorkspace("Provision Test B");
    await provisionWorkspace(prismaUnsafe, id);

    // Somebody tunes a stage. A repair must not undo that.
    const stage = await prismaUnsafe.dealStage.findFirst({ where: { workspaceId: id } });
    await prismaUnsafe.dealStage.update({
      where: { id: stage!.id },
      data: { name: "Renamed by a human", probability: 77 },
    });

    const second = await provisionWorkspace(prismaUnsafe, id);
    expect(second).toEqual({ pipelines: 0, templates: 0, targets: 0, icpConfig: false });

    const after = await prismaUnsafe.dealStage.findUnique({ where: { id: stage!.id } });
    expect(after?.name).toBe("Renamed by a human");
    expect(after?.probability).toBe(77);
  });

  it("adds only what is missing when a workspace is partly set up", async () => {
    const id = await freshWorkspace("Provision Test C");
    // Half-provisioned: targets exist, nothing else does.
    await prismaUnsafe.target.create({
      data: { workspaceId: id, metric: "invites_sent", period: "weekly", value: 42 },
    });

    const added = await provisionWorkspace(prismaUnsafe, id);
    expect(added.pipelines).toBeGreaterThan(0);
    // Three of the four defaults were absent; the existing one is left alone.
    expect(added.targets).toBe(3);
    const kept = await prismaUnsafe.target.findFirst({
      where: { workspaceId: id, metric: "invites_sent", period: "weekly" },
    });
    expect(kept?.value).toBe(42);
  });
});
