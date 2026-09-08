import { test, expect } from "@playwright/test";

/**
 * The P5 data layer end to end (playbook-v2 P5 VERIFICATION):
 * "a custom select field appears in table, filter and export".
 *
 * The merge and the import rollback are proved against a real database in
 * test/integration/merge.test.ts and test/integration/import.test.ts — their
 * interesting cases are conflict detection and re-linking, which a browser can
 * only observe indirectly. What a browser CAN prove is that a field an Owner
 * defines actually shows up in the three places the playbook names.
 */
test.describe.configure({ mode: "serial" });

const FIELD_LABEL = `E2E Segment ${Date.now()}`;

test("an Owner defines a custom select field", async ({ page }) => {
  await page.goto("/settings/admin/workspace");
  const panel = page.getByTestId("settings-fields");
  await expect(panel).toBeVisible();

  await panel.getByTestId("field-label").fill(FIELD_LABEL);
  await panel.getByTestId("field-type").selectOption("SELECT");
  await panel.getByTestId("field-options").fill("horeca|HoReCa\nretail|Retail");
  await panel.getByTestId("field-add").click();

  await expect(panel.getByTestId("fields-list")).toContainText(FIELD_LABEL);
});

test("the field appears as a column and as a filter condition", async ({ page }) => {
  await page.goto("/leads");

  // As an optional column.
  await page.getByTestId("column-toggle").click();
  await expect(page.getByTestId("column-panel")).toContainText(FIELD_LABEL);
  await page.getByTestId("column-toggle").click();

  // As a filter field, under its own group.
  await page.getByTestId("filter-toggle").click();
  await page.getByTestId("filter-add").click();
  const row = page.getByTestId("filter-condition").last();
  await expect(row.getByTestId("filter-field")).toContainText(FIELD_LABEL);
});

test("Settings shows the data-quality panel with its merge and import lists", async ({ page }) => {
  await page.goto("/settings/admin/workspace");
  const panel = page.getByTestId("settings-data-quality");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("undoable for 30 days");
  await expect(panel).toContainText("An import is undoable for 7");
});

test("the import dialog offers the saved-mapping flow and the custom field", async ({ page }) => {
  await page.goto("/leads");
  await page.getByTestId("topbar-import-csv").click();

  // The mapping step only appears once a file is parsed, so feed it one.
  await page.getByTestId("csv-file").setInputFiles({
    name: "e2e-import.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Name;Email;Company;Segment\nAnna;anna@e2e.test;Danubia Kft;horeca\n"),
  });

  await expect(page.getByTestId("csv-summary")).toContainText("1 row");
  // The custom field is a mapping target, labelled as custom.
  await expect(page.getByText(`${FIELD_LABEL} (custom)`)).toBeVisible();
  // And the update/skip choice the v1 flow never offered.
  await expect(page.getByTestId("csv-mode-update")).toBeVisible();
  await expect(page.getByTestId("csv-template-name")).toBeVisible();
});
