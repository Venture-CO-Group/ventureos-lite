import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { openLeadDetail } from "./helpers/leads";

const prisma = new PrismaClient();
const RUN = String(Date.now());
let workspaceId = "";
let leadId = "";

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  const company = await prisma.company.create({
    data: { workspaceId, name: `Pin Co ${RUN}` },
  });
  leadId = (
    await prisma.lead.create({
      data: { workspaceId, contactName: `Pin Lead ${RUN}`, companyId: company.id, icpScore: 4 },
    })
  ).id;
});

test.afterAll(async () => {
  await prisma.userPin.deleteMany({ where: { workspaceId } });
  await prisma.lead.deleteMany({ where: { id: leadId } });
  await prisma.company.deleteMany({ where: { name: `Pin Co ${RUN}` } });
  await prisma.$disconnect();
});

/**
 * Recents and favourites (playbook-v5 P17/2).
 *
 * ── WHY THIS IS A BROWSER TEST ──────────────────────────────────────────────
 *
 * The rules are covered in test/integration/pins.test.ts. What only a browser
 * shows is that the recording happens WHEN SOMEBODY OPENS SOMETHING and that
 * nothing on the page waits for it — and that the star survives a reload,
 * which is the whole point of it being a row rather than browser state.
 */
test("opening a lead records it, and starring it survives a reload", async ({ page }) => {
  // First visit to /leads in a run compiles the route; the star then waits on
  // two more round trips.
  test.setTimeout(90_000);
  await page.goto("/leads");
  await expect(page.getByTestId("skeleton")).toHaveCount(0, { timeout: 30_000 });

  await openLeadDetail(page, `Pin Lead ${RUN}`);
  const star = page.getByTestId("star-toggle");
  await expect(star).toBeVisible({ timeout: 15_000 });

  // The visit was recorded by opening it — nothing was clicked to cause that.
  await expect
    .poll(
      async () =>
        prisma.userPin.count({ where: { workspaceId, kind: "recent", entityId: leadId } }),
      { timeout: 15_000 },
    )
    .toBe(1);

  await expect(star).toHaveAttribute("data-on", "false");
  await star.click();
  await expect(star).toHaveAttribute("data-on", "true", { timeout: 15_000 });

  await expect
    .poll(
      async () =>
        prisma.userPin.count({ where: { workspaceId, kind: "favourite", entityId: leadId } }),
      { timeout: 15_000 },
    )
    .toBe(1);

  /**
   * A row, not browser state: the star is still on after a reload, and the
   * favourite is in the sidebar — which is what "follows the person rather
   * than the browser" means in practice.
   */
  await page.reload();
  await expect(page.getByTestId("skeleton")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("sidebar-favourites")).toBeVisible();
  await expect(page.getByTestId("favourite-row")).toContainText(`Pin Lead ${RUN}`);
});

/**
 * And the palette shows them on an empty query, favourites first — the reason
 * both live in one table.
 */
test("the palette offers the shortcuts on an empty query", async ({ page }) => {
  /**
   * Upserted, not created: the test above stars the same lead, so on a retry
   * (or in file order) the row is already there and a `create` would fail on
   * the unique index for a reason unrelated to what is being proved.
   */
  const userId = (
    await prisma.user.findFirst({ where: { email: "e2e-runner@ventureco.test" } })
  )!.id;
  const key = {
    userId,
    workspaceId,
    kind: "favourite",
    entityType: "lead",
    entityId: leadId,
  };
  await prisma.userPin.upsert({
    where: { userId_workspaceId_kind_entityType_entityId: key },
    update: { label: `Pin Lead ${RUN}`, href: `/leads?lead=${leadId}` },
    create: { ...key, label: `Pin Lead ${RUN}`, href: `/leads?lead=${leadId}`, position: 1024 },
  });

  await page.goto("/");
  await expect(page.getByTestId("skeleton")).toHaveCount(0, { timeout: 30_000 });
  await page.keyboard.press("ControlOrMeta+k");

  const results = page.getByTestId("palette-results");
  await expect(results).toBeVisible({ timeout: 15_000 });
  await expect(results).toContainText(`Pin Lead ${RUN}`, { timeout: 15_000 });
  await expect(results).toContainText("Favourites");
});
