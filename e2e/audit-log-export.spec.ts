import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
let workspaceId = "";

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
});

test.afterAll(async () => {
  // Put the workspace back to keep-for-ever, so the nightly sweep does not
  // start removing rows from every later test run.
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  const flags = (ws?.featureFlags ?? {}) as Record<string, unknown>;
  delete flags.auditLogRetentionDays;
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { featureFlags: flags as never },
  });
  await prisma.$disconnect();
});

/**
 * The log was readable on screen, fifty rows at a time, and could not leave the
 * product. The first request in a data-protection incident is an extract of it,
 * and "log in and scroll" is not an answer to a regulator.
 */
test("the audit log can be taken away as a CSV, and saying so is itself logged", async ({
  page,
}) => {
  await prisma.auditLog.create({
    data: {
      workspaceId,
      action: "export.run",
      entityType: "Lead",
      entityId: "e2e-export-marker",
      meta: { note: 'a comma, a "quote" and a\nnewline' },
    },
  });

  await page.goto("/settings/admin");
  await page.getByTestId("settings-audit-log").scrollIntoViewIfNeeded();

  const before = await prisma.auditLog.count({
    where: { workspaceId, action: "audit_log.exported" },
  });

  const download = page.waitForEvent("download");
  await page.getByTestId("audit-export").click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/);

  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const csv = Buffer.concat(chunks).toString("utf-8");

  // A BOM, because this lands in Excel far more often than in a text editor.
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).toContain("at,actor,action,entity_type,entity_id,meta");
  expect(csv).toContain("e2e-export-marker");
  // An actor-less row is the system, said plainly, rather than an empty cell.
  expect(csv).toMatch(/,system,export\.run,Lead,e2e-export-marker,/);

  /**
   * The meta column here holds a comma, a double quote and a newline.
   *
   * The property that matters is not how any one of them is spelled but that
   * the row structure survives: a stray newline inside a field turns every
   * subsequent row into nonsense, and that is exactly the kind of file somebody
   * hands to a regulator without opening it first.
   */
  const marker = csv.split("\n").filter((l) => l.includes("e2e-export-marker"));
  expect(marker.length).toBeGreaterThanOrEqual(1);
  // The field is quoted, and the whole record is on one physical line.
  expect(marker[0]!).toContain(',"{');
  expect(marker[0]!.endsWith('}"')).toBe(true);

  // Reading the record of who did what is itself a recorded act.
  await expect(page.getByTestId("audit-log-note")).toContainText("letöltve");
  const after = await prisma.auditLog.count({
    where: { workspaceId, action: "audit_log.exported" },
  });
  expect(after).toBe(before + 1);

  await prisma.auditLog.deleteMany({ where: { workspaceId, entityId: "e2e-export-marker" } });
});

test("a retention period can be set, and it says what it will remove", async ({ page }) => {
  await page.goto("/settings/admin");
  await page.getByTestId("settings-audit-log").scrollIntoViewIfNeeded();

  // The default is keep-for-ever, and that is on purpose: no default should
  // ever quietly delete a workspace's audit history.
  await expect(page.getByTestId("audit-retention-state")).toContainText("indefinitely");

  await page.getByTestId("audit-retention-days").selectOption("90");
  await page.getByTestId("audit-retention-save").click();
  await expect(page.getByTestId("audit-log-note")).toContainText("mentve");

  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  expect((ws!.featureFlags as Record<string, unknown>).auditLogRetentionDays).toBe(90);

  await page.reload();
  await page.getByTestId("settings-audit-log").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("audit-retention-state")).toContainText("Kept for 90 days");
  // Changing the rule is itself an entry — a gap in the log must be explicable.
  await expect(page.getByTestId("settings-audit-log")).toContainText("napló megőrzés módosítva");
});
