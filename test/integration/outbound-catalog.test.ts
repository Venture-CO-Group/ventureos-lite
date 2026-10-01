import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { ensureSegments, loadSegments } from "../../src/modules/outbound/segments";
import { toProductView } from "../../src/modules/outbound/catalog";
import { nameableReferences } from "../../src/modules/outbound/references";

/**
 * Products, profiles and segments against the real database (playbook-v6 F1).
 *
 * What matters here is what a row can REACH: a second workspace sees none of
 * the first's catalogue, the taxonomy seeds once per workspace and never
 * overwrites a tuned segment, and two profiles on one product keep their own
 * quotas.
 */
const NAMES = ["Outbound Catalog A", "Outbound Catalog B"];
let wsA = "";
let wsB = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({ where: { name: { in: NAMES } }, select: { id: true } });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of ["icpProfile", "productReference", "product", "segment", "auditLog"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
});
afterAll(clean);

describe("segment taxonomy", () => {
  it("seeds all 19 with non-empty fragments, once per workspace", async () => {
    const segs = await loadSegments(getWorkspaceClient(wsA), wsA);
    expect(segs).toHaveLength(19);
    expect(segs.every((s) => s.fragments.length > 0)).toBe(true);
    await ensureSegments(getWorkspaceClient(wsA), wsA);
    expect(await prismaUnsafe.segment.count({ where: { workspaceId: wsA } })).toBe(19);
  });

  it("never overwrites a tuned segment when seeding again", async () => {
    const db = getWorkspaceClient(wsA);
    const clinics = await db.segment.findFirst({ where: { key: "private_clinics" } });
    await db.segment.update({ where: { id: clinics!.id }, data: { fragments: ["fogászat"] } });
    await ensureSegments(db, wsA);
    const after = await db.segment.findFirst({ where: { key: "private_clinics" } });
    expect(after!.fragments).toEqual(["fogászat"]);
  });
});

describe("products and profiles", () => {
  it("keeps one workspace's catalogue invisible to another", async () => {
    const dbA = getWorkspaceClient(wsA);
    const p = await dbA.product.create({
      data: { workspaceId: wsA, name: "Web", slug: "web", problemSolved: "Slow sites." },
    });
    expect(await getWorkspaceClient(wsB).product.findUnique({ where: { id: p.id } })).toBeNull();
    expect(await getWorkspaceClient(wsB).product.count()).toBe(0);
  });

  it("renders two profiles with their own quotas, and only client references as nameable", async () => {
    const db = getWorkspaceClient(wsA);
    const p = await db.product.create({
      data: { workspaceId: wsA, name: "Health", slug: "health", problemSolved: "Paper charts." },
    });
    await db.productReference.createMany({
      data: [
        { workspaceId: wsA, productId: p.id, companyName: "Medicover Kft.", isClient: true, position: 0 },
        { workspaceId: wsA, productId: p.id, companyName: "PwC Magyarország Kft.", isClient: false, position: 1 },
      ],
    });
    await db.icpProfile.create({
      data: { workspaceId: wsA, productId: p.id, name: "Clinics", segmentKeys: ["private_clinics"], dailyQuota: 8 },
    });
    await db.icpProfile.create({
      data: { workspaceId: wsA, productId: p.id, name: "Insurers", segmentKeys: ["insurers"], dailyQuota: 2, sizeBands: ["LARGE"] },
    });
    const row = await db.product.findUnique({ where: { id: p.id }, include: { references: true, profiles: true } });
    const view = toProductView(row!);
    expect(view.profiles.map((x) => [x.name, x.dailyQuota]).sort()).toEqual([
      ["Clinics", 8],
      ["Insurers", 2],
    ]);
    expect(nameableReferences(view.references).map((r) => r.companyName)).toEqual(["Medicover Kft."]);
  });
});
