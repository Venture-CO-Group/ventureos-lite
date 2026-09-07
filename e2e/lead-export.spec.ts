import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";

/**
 * exceljs types its reader against its own bundled `Buffer` declaration, which
 * TypeScript will not unify with Node's generic `Buffer<ArrayBufferLike>`. The
 * runtime accepts exactly what we pass; the cast is the type system's problem,
 * not the code's.
 */
function asExcelBuffer(b: Buffer | Uint8Array): Parameters<ExcelJS.Xlsx["load"]>[0] {
  return b as unknown as Parameters<ExcelJS.Xlsx["load"]>[0];
}

const prisma = new PrismaClient();
const MARK = "ExportSpec";

/**
 * The three ways a lead list leaves the product, driven through the real UI.
 *
 * A download is one of the few things a unit test genuinely cannot cover: the
 * server builds base64, the browser turns it into a file, and the interesting
 * failures live in that seam.
 */
test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  const company = await prisma.company.create({
    data: { workspaceId: ws!.id, name: `${MARK} Árvíztűrő Kft.`, industry: "Vendéglátás", city: "Budapest" },
  });
  await prisma.lead.create({
    data: {
      workspaceId: ws!.id,
      companyId: company.id,
      contactName: `${MARK} Tükörfúrógép`,
      email: "export@pelda.hu",
      icpScore: 4,
      stage: "RESEARCHED",
      signals: ["no mobile"],
    },
  });
});

test.afterAll(async () => {
  await prisma.lead.deleteMany({ where: { contactName: { startsWith: MARK } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.$disconnect();
});

/** Tick the first row and open the export dialog. */
async function openExport(page: import("@playwright/test").Page) {
  await page.goto("/leads");
  await page.getByPlaceholder(/search/i).first().fill(MARK);
  await page.waitForTimeout(1200);
  await page.locator('tbody input[type="checkbox"]').first().check();
  await page.getByTestId("bulk-export").click();
  await expect(page.getByTestId("export-format-csv")).toBeVisible();
}

test("CSV downloads with the BOM Hungarian Excel needs", async ({ page }) => {
  await openExport(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-format-csv").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^leads-\d{4}-\d{2}-\d{2}\.csv$/);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");

  // Without the BOM, Hungarian Excel renders these as mojibake.
  expect(text.charCodeAt(0)).toBe(0xfeff);
  expect(text).toContain("Tükörfúrógép");
});

test("XLSX downloads as a workbook a real reader can open", async ({ page }) => {
  await openExport(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-format-xlsx").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const buf = Buffer.concat(chunks);

  // The check that matters: a file Excel would refuse is a file this refuses.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(asExcelBuffer(buf));
  const sheet = wb.getWorksheet("Leads");
  expect(sheet).toBeDefined();
  expect(sheet!.getRow(1).getCell(1).value).toBe("Lead");

  const names = sheet!.getColumn(1).values.map((v) => String(v ?? ""));
  expect(names.some((n) => n.includes("Tükörfúrógép"))).toBe(true);
});

test("the branded PDF is rendered by the worker and opened", async ({ page, context }) => {
  /**
   * Watch the CONTEXT for the request, not the popup for its URL.
   *
   * The page is opened with `noopener`, so Playwright sees a fresh page whose
   * `url()` stays "" while it navigates, and Chromium then hands the PDF to its
   * built-in viewer, which fires no document lifecycle event. Both of the
   * obvious waits therefore time out on a popup that is working perfectly. The
   * request itself is unambiguous.
   */
  const requested = new Promise<string>((resolve) => {
    context.on("request", (req) => {
      if (req.url().includes("/api/files/exports/")) resolve(req.url());
    });
  });

  await openExport(page);
  await page.getByTestId("export-format-pdf").click();

  const url = await requested;
  expect(url).toMatch(/-leads-\d+\.pdf$/);

  // The route is session-authenticated; a 200 means the file exists AND the
  // workspace check passed.
  const res = await page.request.get(url);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("pdf");
  const body = await res.body();
  expect(body.subarray(0, 4).toString()).toBe("%PDF");
  // A one-page render of two leads is a few tens of KB; an empty file is not.
  expect(body.length).toBeGreaterThan(5000);
});
