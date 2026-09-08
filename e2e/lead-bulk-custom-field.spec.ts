import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const MARK = "BulkField";
let workspaceId = "";
const leadIds: string[] = [];

/**
 * The bulk bar could move a stage, edit signals and assign an owner — but not
 * touch a custom field. An Owner-defined "Contract type" had to be set fifty
 * times on fifty leads by hand, which is the exact work the bar exists to
 * remove.
 */
test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;

  await prisma.customFieldDef.deleteMany({
    where: { workspaceId, key: { in: ["contract_type", "priority_client"] } },
  });
  await prisma.customFieldDef.create({
    data: {
      workspaceId,
      entity: "lead",
      key: "contract_type",
      label: "Contract type",
      type: "SELECT",
      options: [
        { value: "retainer", label: "Retainer" },
        { value: "project", label: "Project" },
      ],
      required: false,
      position: 1,
    },
  });

  for (let i = 0; i < 3; i += 1) {
    const company = await prisma.company.create({
      data: { workspaceId, name: `${MARK} Co ${i}` },
    });
    const lead = await prisma.lead.create({
      data: {
        workspaceId,
        companyId: company.id,
        contactName: `${MARK} Lead ${i}`,
        stage: "RESEARCHED",
        // Something already in the column, to prove a bulk set MERGES rather
        // than replacing — the failure that would lose every other value.
        customFields: { existing_note: `keep-${i}` },
      },
    });
    leadIds.push(lead.id);
  }
});

test.afterAll(async () => {
  await prisma.lead.deleteMany({ where: { contactName: { startsWith: MARK } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.customFieldDef.deleteMany({
    where: { workspaceId, key: { in: ["contract_type", "priority_client"] } },
  });
  await prisma.$disconnect();
});

/**
 * Tick exactly this spec's own rows.
 *
 * Not "every checkbox on the page": the leads table also holds whatever else
 * the workspace has, so a blanket select would set a field on unrelated leads
 * and the assertions would then be measuring the wrong rows.
 */
async function selectMine(page: import("@playwright/test").Page): Promise<number> {
  await page.goto("/leads");
  const rows = page.locator("tbody tr").filter({ hasText: MARK });
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  const n = await rows.count();
  for (let i = 0; i < n; i += 1) {
    await rows.nth(i).locator('input[type="checkbox"]').check();
  }
  return n;
}

test("one custom field is set across the selection, and the other values survive", async ({
  page,
}) => {
  const n = await selectMine(page);
  expect(n).toBe(3);

  await page.getByTestId("bulk-field").click();
  await page.getByTestId("field-select").selectOption("contract_type");
  await page.getByTestId("field-value").selectOption("retainer");
  await page.getByTestId("bulk-confirm").click();
  await page.waitForTimeout(2500);

  const leads = await prisma.lead.findMany({ where: { id: { in: leadIds } } });
  expect(leads).toHaveLength(3);
  for (const l of leads) {
    const cf = l.customFields as Record<string, unknown>;
    expect(cf.contract_type).toBe("retainer");
    // The merge, not a replace: `updateMany` would have dropped this.
    expect(String(cf.existing_note)).toMatch(/^keep-\d$/);
  }
});

test("leaving the value empty clears the field rather than writing an empty string", async ({
  page,
}) => {
  await selectMine(page);
  await page.getByTestId("bulk-field").click();
  await page.getByTestId("field-select").selectOption("contract_type");
  await page.getByTestId("field-value").selectOption("");
  await page.getByTestId("bulk-confirm").click();
  await page.waitForTimeout(2500);

  for (const l of await prisma.lead.findMany({ where: { id: { in: leadIds } } })) {
    const cf = l.customFields as Record<string, unknown>;
    // Absent, not "" — a blank string would satisfy a required-field check and
    // show as an empty cell that looks filled in.
    expect(cf.contract_type).toBeUndefined();
    expect(String(cf.existing_note)).toMatch(/^keep-\d$/);
  }
});

test("a required field cannot be cleared in bulk", async ({ page }) => {
  await prisma.customFieldDef.create({
    data: {
      workspaceId,
      entity: "lead",
      key: "priority_client",
      label: "Priority client",
      type: "TEXT",
      options: [],
      required: true,
      position: 2,
    },
  });

  await selectMine(page);
  await page.getByTestId("bulk-field").click();
  await page.getByTestId("field-select").selectOption("priority_client");
  await expect(page.getByText(/cannot be cleared in bulk/i)).toBeVisible();
  // The forms would refuse to save a row this bar had just emptied.
  await expect(page.getByTestId("bulk-confirm")).toBeDisabled();

  await page.getByTestId("field-value").fill("yes");
  await expect(page.getByTestId("bulk-confirm")).toBeEnabled();
});

test("the button is not offered when the workspace has defined no fields", async ({ page }) => {
  const defs = await prisma.customFieldDef.findMany({ where: { workspaceId, entity: "lead" } });
  await prisma.customFieldDef.deleteMany({ where: { workspaceId, entity: "lead" } });
  try {
    await selectMine(page);
    // A button that opens an empty picker teaches people not to press it.
    await expect(page.getByTestId("bulk-field")).toHaveCount(0);
    // The rest of the bar is unaffected.
    await expect(page.getByTestId("bulk-export")).toBeVisible();
  } finally {
    for (const d of defs) {
      await prisma.customFieldDef.create({
        data: {
          workspaceId: d.workspaceId,
          entity: d.entity,
          key: d.key,
          label: d.label,
          type: d.type,
          options: d.options as never,
          required: d.required,
          position: d.position,
        },
      });
    }
  }
});
