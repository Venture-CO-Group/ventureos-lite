import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  buildLeadsXlsx,
  buildLeadsPdfHtml,
  PDF_MAX_COLUMNS,
  EXPORT_FORMATS,
  FORMAT_LABEL,
  FORMAT_HINT,
} from "../../src/modules/leads/export-formats";
import { buildLeadsCsv, type CsvLead } from "../../src/modules/leads/bulk";
import { brandFrom } from "../../src/modules/workspaces/brand";

/**
 * exceljs types its reader against its own bundled `Buffer` declaration, which
 * TypeScript will not unify with Node's generic `Buffer<ArrayBufferLike>`. The
 * runtime accepts exactly what we pass; the cast is the type system's problem,
 * not the code's.
 */
function asExcelBuffer(b: Buffer | Uint8Array): Parameters<ExcelJS.Xlsx["load"]>[0] {
  return b as unknown as Parameters<ExcelJS.Xlsx["load"]>[0];
}

const LEADS: CsvLead[] = [
  {
    id: "l1",
    contactName: "Árvíztűrő Tükörfúrógép",
    title: "Ügyvezető",
    email: "arvizturo@pelda.hu",
    phone: "+36 1 234 5678",
    company: "Példa Kft.",
    industry: "Vendéglátás",
    city: "Budapest",
    icpScore: 4,
    stage: "QUALIFIED",
    signals: ["no mobile", "outdated website"],
    source: "PROSPECTOR",
    ownerName: "Fanni",
    lastActivityAt: new Date("2026-08-01T10:00:00Z"),
    createdAt: new Date("2026-07-15T10:00:00Z"),
  },
  {
    id: "l2",
    contactName: 'Quote "Me", Please',
    title: null,
    email: null,
    phone: null,
    company: "Comma, Inc",
    industry: null,
    city: null,
    icpScore: 10,
    stage: "RESEARCHED",
    signals: [],
    source: null,
    ownerName: null,
    lastActivityAt: null,
    createdAt: new Date("2026-07-20T10:00:00Z"),
  },
];

const COLUMNS = ["contact", "company", "email", "icpScore", "stage", "signals"];

describe("the three export formats agree with each other", () => {
  it("offers a label and a reason to choose for every format", () => {
    for (const f of EXPORT_FORMATS) {
      expect(FORMAT_LABEL[f]).toBeTruthy();
      expect(FORMAT_HINT[f]).toBeTruthy();
    }
  });

  it("puts the same values in the CSV, the spreadsheet and the document", async () => {
    const csv = buildLeadsCsv(LEADS, COLUMNS);
    const html = buildLeadsPdfHtml(LEADS, COLUMNS, [], brandFrom(null), {
      subtitle: "2 leads",
      exportedAt: new Date("2026-09-08T00:00:00Z"),
      exportedBy: "Tamás",
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(asExcelBuffer(await buildLeadsXlsx(LEADS, COLUMNS)));
    const sheet = wb.getWorksheet("Leads")!;

    // The company name with a comma in it is the value most likely to be
    // mangled differently by three different writers.
    expect(csv).toContain('"Comma, Inc"'); // quoted, per RFC 4180
    expect(sheet.getRow(3).getCell(2).value).toBe("Comma, Inc"); // a real cell
    expect(html).toContain("Comma, Inc"); // plain text in a <td>
  });
});

describe("the spreadsheet is a spreadsheet, not a CSV with a different name", () => {
  it("round-trips through a real reader with accents intact", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(asExcelBuffer(await buildLeadsXlsx(LEADS, COLUMNS)));
    const sheet = wb.getWorksheet("Leads");
    expect(sheet).toBeDefined();

    // Header row carries the column LABELS, not the internal keys.
    expect(sheet!.getRow(1).getCell(1).value).toBe("Lead");
    expect(sheet!.getRow(1).getCell(4).value).toBe("ICP score");

    expect(sheet!.getRow(2).getCell(1).value).toBe("Árvíztűrő Tükörfúrógép");
    expect(sheet!.getRow(2).getCell(6).value).toBe("no mobile; outdated website");
  });

  it("writes the score as a number so the column sorts and sums", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(asExcelBuffer(await buildLeadsXlsx(LEADS, COLUMNS)));
    const sheet = wb.getWorksheet("Leads")!;

    // As text, "10" sorts before "4" — the kind of defect that makes people
    // stop trusting an export without ever reporting it.
    expect(sheet.getRow(2).getCell(4).value).toBe(4);
    expect(sheet.getRow(3).getCell(4).value).toBe(10);
    expect(typeof sheet.getRow(3).getCell(4).value).toBe("number");
  });

  it("freezes the header and turns on the filter", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(asExcelBuffer(await buildLeadsXlsx(LEADS, COLUMNS)));
    const sheet = wb.getWorksheet("Leads")!;
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.autoFilter).toBeTruthy();
  });

  it("sizes every column rather than leaving Excel to show ########", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(asExcelBuffer(await buildLeadsXlsx(LEADS, COLUMNS)));
    const sheet = wb.getWorksheet("Leads")!;
    for (let i = 1; i <= COLUMNS.length; i += 1) {
      expect(sheet.getColumn(i).width).toBeGreaterThanOrEqual(10);
      expect(sheet.getColumn(i).width).toBeLessThanOrEqual(48);
    }
  });

  it("produces a workbook even with no rows at all", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(asExcelBuffer(await buildLeadsXlsx([], COLUMNS)));
    const sheet = wb.getWorksheet("Leads")!;
    expect(sheet.getRow(1).getCell(1).value).toBe("Lead");
    expect(sheet.rowCount).toBe(1);
  });
});

describe("the branded PDF is the workspace's document, not ours", () => {
  const brand = brandFrom({
    name: "Studio Kft.",
    markBold: "studio",
    markLight: "kft",
    footerIdentity: "Studio Kft. · 1052 Budapest",
  });

  it("carries the workspace's letterhead and footer", () => {
    const html = buildLeadsPdfHtml(LEADS, COLUMNS, [], brand, {
      subtitle: "2 leads",
      exportedAt: new Date("2026-09-08T00:00:00Z"),
      exportedBy: "Tamás",
    });
    expect(html).toContain("studio");
    expect(html).toContain("Studio Kft. · 1052 Budapest");
    // No hardcoded Venture anywhere — that was the whole point of P2/6.
    expect(html.toLowerCase()).not.toContain("venture");
  });

  it("escapes values rather than letting a lead name close a tag", () => {
    const nasty: CsvLead[] = [
      { ...LEADS[0], contactName: '<script>alert(1)</script>', company: "A & B" },
    ];
    const html = buildLeadsPdfHtml(nasty, ["contact", "company"], [], brand, {
      subtitle: "1 lead",
      exportedAt: new Date(),
      exportedBy: "T",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; B");
  });

  it("says so when it drops columns rather than truncating in silence", () => {
    const many = [
      "contact", "company", "title", "email", "phone",
      "industry", "city", "icpScore", "stage", "signals",
    ];
    expect(many.length).toBeGreaterThan(PDF_MAX_COLUMNS);

    const html = buildLeadsPdfHtml(LEADS, many, [], brand, {
      subtitle: "2 leads",
      exportedAt: new Date(),
      exportedBy: "T",
    });
    // A document that quietly lacks the phone number is how somebody ends up
    // ringing nobody.
    expect(html).toContain("were left out");
    expect(html).toContain("Export as Excel or CSV");
  });

  it("repeats the header on every printed page", () => {
    const html = buildLeadsPdfHtml(LEADS, COLUMNS, [], brand, {
      subtitle: "2 leads",
      exportedAt: new Date(),
      exportedBy: "T",
    });
    expect(html).toContain("thead { display: table-header-group; }");
  });

  it("renders an honest empty state instead of a headed table with no body", () => {
    const html = buildLeadsPdfHtml([], COLUMNS, [], brand, {
      subtitle: "0 leads",
      exportedAt: new Date(),
      exportedBy: "T",
    });
    expect(html).toContain("No leads matched.");
  });
});
