import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  EXPORT_FORMATS,
  FORMAT_HINT,
  FORMAT_LABEL,
  MAX_PDF_ROWS,
  buildLeadsPdfHtml,
  buildLeadsXlsx,
  pdfRowCapMessage,
} from "../../src/modules/leads/export-formats";
import {
  EXPORT_COLUMNS,
  cellText,
  exportColumns,
  pdfSubrowColumns,
  pdfTableColumns,
} from "../../src/modules/leads/export-columns";
import { buildLeadsCsv, leadsCsvBuffer, type CsvLead } from "../../src/modules/leads/bulk";
import { brandFrom } from "../../src/modules/workspaces/brand";
import { csvCell, parseCsv } from "../helpers/csv";

/**
 * exceljs types its reader against its own bundled `Buffer` declaration, which
 * TypeScript will not unify with Node's generic `Buffer<ArrayBufferLike>`. The
 * runtime accepts exactly what we pass; the cast is the type system's problem,
 * not the code's.
 */
function asExcelBuffer(b: Buffer | Uint8Array): Parameters<ExcelJS.Xlsx["load"]>[0] {
  return b as unknown as Parameters<ExcelJS.Xlsx["load"]>[0];
}

/**
 * Thirty leads of mixed completeness.
 *
 * Mixed on purpose, and cycled rather than randomised so a failure is the same
 * failure twice: every fifth lead has no company at all, every third no email,
 * every fourth no summary, and one carries prose with all three of the
 * characters that break a CSV. A fixture where every row is fully populated
 * proves only that the happy path works, and the fields this export was
 * extended to carry are exactly the ones that are often empty.
 */
const LEADS: CsvLead[] = Array.from({ length: 30 }, (_, i) => {
  const n = i + 1;
  const hasCompany = n % 5 !== 0;
  return {
    id: `l${n}`,
    contactName: n === 7 ? "Árvíztűrő Tükörfúrógép" : `Lead ${n}`,
    title: n % 6 === 0 ? null : "Ügyvezető",
    company: hasCompany ? (n === 9 ? "Comma, Inc" : `Példa ${n} Kft.`) : null,
    email: n % 3 === 0 ? null : `lead${n}@pelda.hu`,
    phone: n % 4 === 0 ? null : `+36 1 234 ${1000 + n}`,
    linkedinUrl: n % 2 === 0 ? `https://linkedin.com/in/lead-${n}` : null,
    domain: hasCompany ? `pelda${n}.hu` : null,
    industry: hasCompany ? "Vendéglátás" : null,
    city: hasCompany ? "Budapest" : null,
    taxId: n % 7 === 0 ? `1234567${n}-2-42` : null,
    icpScore: n % 11 === 0 ? null : (n % 6),
    scoreBreakdown: n % 2 === 0 ? { segment_fit: 1, decision_maker: 0 } : null,
    stage: n % 2 === 0 ? "QUALIFIED" : "RESEARCHED",
    signals: n % 3 === 0 ? [] : ["no mobile", "outdated website"],
    source: n % 2 === 0 ? "PROSPECTOR" : "SELF_SERVE_AUDIT",
    ownerName: n % 4 === 0 ? null : "Fanni",
    auditScore: hasCompany ? 40 + n : null,
    auditAt: hasCompany ? new Date("2026-08-03T09:00:00Z") : null,
    personBrief:
      n % 4 === 0
        ? null
        : n === 13
          ? 'Runs "Comma, Inc" in Budapest.\nSecond line, with a comma.\r\nThird.'
          : `A short brief about lead ${n}.`,
    notes: n % 5 === 0 ? 'Note with "quotes", a comma\nand a newline.' : null,
    createdAt: new Date("2026-07-15T10:00:00Z"),
    lastActivityAt: n % 3 === 0 ? null : new Date("2026-08-01T10:00:00Z"),
    lastContactedAt: n % 2 === 0 ? new Date("2026-08-10T10:00:00Z") : null,
  };
});

/** The lead whose summary carries a comma, a quote and line breaks. */
const TRICKY = LEADS[12]!;

const BRAND = brandFrom(null);
const PDF_META = {
  subtitle: "30 leads",
  filterSummary: "Stage is QUALIFIED and ICP score is at least 3",
  exportedAt: new Date("2026-09-14T00:00:00Z"),
  exportedBy: "Tamás",
};

async function sheetOf(leads: CsvLead[] = LEADS) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(asExcelBuffer(await buildLeadsXlsx(leads)));
  return wb.worksheets[0]!;
}

/** The 1-based column index carrying `label`, from the header row. */
function colOf(sheet: ExcelJS.Worksheet, label: string): number {
  const header = sheet.getRow(1);
  for (let i = 1; i <= header.cellCount; i += 1) {
    if (header.getCell(i).text === label) return i;
  }
  throw new Error(`no column named ${label}`);
}

describe("one registry behind all three formats", () => {
  it("offers a label and a reason to choose for every format", () => {
    for (const f of EXPORT_FORMATS) {
      expect(FORMAT_LABEL[f]).toBeTruthy();
      expect(FORMAT_HINT[f]).toBeTruthy();
    }
  });

  it("carries the whole lead record, in the agreed order", () => {
    // The contract this module exists to hold. If a field is added to the
    // registry it appears here; if one is dropped, this fails rather than the
    // export quietly shipping an empty column.
    expect(EXPORT_COLUMNS.map((c) => c.label)).toEqual([
      "Name",
      "Job title",
      "Company",
      "Email",
      "Phone",
      "LinkedIn URL",
      "Website",
      "Industry",
      "City",
      "Tax number",
      "ICP score",
      "Score breakdown",
      "Signals",
      "Stage",
      "Owner",
      "Source",
      "Audit score",
      "Audit date",
      "Person summary",
      "Created",
      "Last activity",
      "Last contacted",
      "Notes",
    ]);
  });

  it("gives every column a format to appear in", () => {
    for (const c of EXPORT_COLUMNS) {
      expect(c.formats.length, `${c.key} appears in no format`).toBeGreaterThan(0);
    }
  });

  it("places every PDF column either in the table or beneath it", () => {
    for (const c of EXPORT_COLUMNS) {
      if (!c.formats.includes("pdf")) continue;
      expect(c.pdf, `${c.key} is in the PDF with nowhere to go`).toBeTruthy();
    }
    expect(pdfTableColumns().map((c) => c.key)).toEqual([
      "contact",
      "title",
      "company",
      "email",
      "phone",
      "icpScore",
      "stage",
    ]);
    expect(pdfSubrowColumns().map((c) => c.key)).toEqual(["personBrief"]);
  });

  it("puts identical column data in the CSV, the spreadsheet and the document", async () => {
    const csv = buildLeadsCsv(LEADS);
    const rows = parseCsv(csv);
    const sheet = await sheetOf();
    const html = buildLeadsPdfHtml(LEADS, [], BRAND, PDF_META);

    expect(rows).toHaveLength(LEADS.length + 1);

    for (const def of exportColumns("csv")) {
      const idx = rows[0]!.indexOf(def.label);
      expect(idx, `${def.key} missing from the CSV`).toBeGreaterThanOrEqual(0);
      const xlsxCol = colOf(sheet, def.label);

      LEADS.forEach((lead, i) => {
        const expected = cellText(def, lead);
        // CSV and XLSX are the two machine-readable formats and must agree
        // exactly, ISO dates included.
        expect(rows[i + 1]![idx], `${def.key} row ${i} in CSV`).toBe(expected);

        // A date cell holds a Date, and `.text` is that Date's toString rather
        // than the ISO the column's numFmt renders — so it is compared as what
        // it is.
        const cell = sheet.getRow(i + 2).getCell(xlsxCol);
        const actual =
          cell.value instanceof Date
            ? cell.value.toISOString().slice(0, 10)
            : (cell.text ?? "");
        expect(actual, `${def.key} row ${i} in XLSX`).toBe(expected);
      });
    }

    // The document carries fewer columns, so it is checked on the ones it has —
    // same values, read through the same resolvers, only the dates localised.
    for (const def of [...pdfTableColumns(), ...pdfSubrowColumns()]) {
      for (const lead of LEADS) {
        const text = cellText(def, lead, { iso: false });
        if (!text) continue;
        expect(html, `${def.key} for ${lead.id} missing from the PDF`).toContain(
          text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
        );
      }
    }
  });

  it("writes an empty cell for a missing value, never a word standing in for one", async () => {
    const csv = buildLeadsCsv(LEADS);
    const sheet = await sheetOf();

    // Lead 5 has no company, lead 4 no summary — both by construction.
    expect(csvCell(csv, "Company", 4)).toBe("");
    expect(csvCell(csv, "Person summary", 3)).toBe("");
    expect(sheet.getRow(6).getCell(colOf(sheet, "Company")).text).toBe("");
    expect(sheet.getRow(5).getCell(colOf(sheet, "Person summary")).text).toBe("");

    for (const word of ["null", "undefined", "N/A"]) {
      expect(csv).not.toContain(`,${word},`);
    }
  });
});

describe("CSV", () => {
  it("leads with the BOM Excel needs for Hungarian accents", () => {
    const buf = leadsCsvBuffer(LEADS);
    expect(buf.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(buf.toString("utf8")).toContain("Árvíztűrő Tükörfúrógép");
  });

  it("round-trips a summary holding commas, quotes and line breaks", () => {
    const csv = buildLeadsCsv([TRICKY]);
    // Parsed the way a reader parses it, not by undoing our own escaping.
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    // Normalised to LF on the way out, which is what all three formats carry.
    expect(csvCell(csv, "Person summary")).toBe(
      TRICKY.personBrief!.replace(/\r\n?/g, "\n"),
    );
    expect(csvCell(csv, "Name")).toBe(TRICKY.contactName);
    // The rest of the row is still intact — an unquoted line break inside the
    // summary would have split this lead into two malformed rows and shifted
    // every cell after it.
    expect(csvCell(csv, "Company")).toBe("Példa 13 Kft.");
    expect(csvCell(csv, "Stage")).toBe("Researched");
  });

  it("round-trips notes holding the same characters", () => {
    const lead = { ...TRICKY, notes: 'Line "one", with a comma\nand a break.' };
    expect(csvCell(buildLeadsCsv([lead]), "Notes")).toBe(lead.notes);
    expect(lead.notes).toContain("\n");
  });

  it("keeps every one of thirty mixed rows on its own row", () => {
    const rows = parseCsv(buildLeadsCsv(LEADS));
    expect(rows).toHaveLength(31);
    // Every row has the same width as the header — the symptom of a broken
    // quote is a row that is short or long.
    const width = rows[0]!.length;
    for (const row of rows) expect(row).toHaveLength(width);
  });

  it("separates signals with commas, quoted so they stay one cell", () => {
    const csv = buildLeadsCsv([LEADS[0]!]);
    expect(csvCell(csv, "Signals")).toBe("no mobile, outdated website");
  });

  it("keeps a company name containing a comma in one cell", () => {
    // Lead 9, by construction.
    const csv = buildLeadsCsv([LEADS[8]!]);
    expect(csvCell(csv, "Company")).toBe("Comma, Inc");
  });
});

describe("XLSX", () => {
  it("freezes the header, styles it and filters across it", async () => {
    const sheet = await sheetOf();
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.getRow(1).font?.bold).toBe(true);
    // Round-tripped through the file, the range comes back in A1 notation and
    // must span every column.
    expect(sheet.autoFilter).toBe(`A1:${sheet.getRow(1).getCell(sheet.columnCount).address.replace(/\d+$/, "")}1`);
  });

  it("names the sheet for what is in it", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      asExcelBuffer(
        await buildLeadsXlsx(LEADS, [], {
          workspaceName: "Venture",
          exportedAt: new Date("2026-09-14T00:00:00Z"),
        }),
      ),
    );
    expect(wb.worksheets[0]!.name).toBe("Leads 2026-09-14");
    // Excel refuses a name past 31 characters or holding \ / ? * [ ] :
    expect(wb.worksheets[0]!.name.length).toBeLessThanOrEqual(31);
  });

  it("writes the ICP score as a number, so it sorts numerically", async () => {
    const sheet = await sheetOf();
    const col = colOf(sheet, "ICP score");

    const values: number[] = [];
    LEADS.forEach((lead, i) => {
      const cell = sheet.getRow(i + 2).getCell(col);
      if (lead.icpScore == null) {
        expect(cell.value).toBeNull();
        return;
      }
      expect(typeof cell.value, `row ${i} is not a number`).toBe("number");
      values.push(cell.value as number);
    });

    // The defect this guards: sorted as text, "10" lands before "2".
    const sorted = [...values].sort((a, b) => a - b);
    expect(sorted[0]).toBeLessThanOrEqual(sorted[sorted.length - 1]!);
    expect(values.some((v) => v > 1)).toBe(true);
  });

  it("writes the audit score as a number too", async () => {
    const sheet = await sheetOf();
    const cell = sheet.getRow(2).getCell(colOf(sheet, "Audit score"));
    expect(typeof cell.value).toBe("number");
  });

  it("writes dates as real date cells, formatted ISO", async () => {
    const sheet = await sheetOf();
    for (const label of ["Created", "Audit date", "Last activity", "Last contacted"]) {
      const col = colOf(sheet, label);
      expect(sheet.getColumn(col).numFmt, `${label} is not date-formatted`).toBe("yyyy-mm-dd");
      const cell = sheet.getRow(2).getCell(col);
      if (cell.value !== null) {
        expect(cell.value, `${label} is not a date cell`).toBeInstanceOf(Date);
      }
    }
  });

  it("makes the LinkedIn URL and the website clickable", async () => {
    const sheet = await sheetOf();
    // Lead 2 has a LinkedIn URL and a domain, both by construction.
    const li = sheet.getRow(3).getCell(colOf(sheet, "LinkedIn URL"));
    expect(li.value).toMatchObject({ hyperlink: "https://linkedin.com/in/lead-2" });

    const site = sheet.getRow(3).getCell(colOf(sheet, "Website"));
    // A bare domain is not a URL; without a scheme the link resolves relative
    // to the file and goes nowhere.
    expect(site.value).toMatchObject({ text: "pelda2.hu", hyperlink: "https://pelda2.hu" });
  });

  it("wraps the summary and notes rather than stretching the sheet", async () => {
    const sheet = await sheetOf();
    for (const label of ["Person summary", "Notes"]) {
      const col = sheet.getColumn(colOf(sheet, label));
      expect(col.alignment?.wrapText, `${label} does not wrap`).toBe(true);
    }
  });

  it("sizes the other columns to their content, within bounds", async () => {
    const sheet = await sheetOf();
    for (const label of ["Name", "Email", "Stage"]) {
      const w = sheet.getColumn(colOf(sheet, label)).width ?? 0;
      expect(w).toBeGreaterThanOrEqual(10);
      expect(w).toBeLessThanOrEqual(48);
    }
  });

  it("writes a header-only sheet for an empty selection", async () => {
    const sheet = await sheetOf([]);
    expect(sheet.rowCount).toBe(1);
    expect(sheet.getRow(1).getCell(1).text).toBe("Name");
  });
});

describe("the branded PDF", () => {
  it("prints landscape", () => {
    const html = buildLeadsPdfHtml(LEADS, [], BRAND, PDF_META);
    expect(html).toContain("size: A4 landscape");
  });

  it("states the export date, the filters and the row count", () => {
    const html = buildLeadsPdfHtml(LEADS, [], BRAND, { ...PDF_META, totalRows: 42 });
    expect(html).toContain("2026-09-14");
    expect(html).toContain("Stage is QUALIFIED and ICP score is at least 3");
    expect(html).toContain("42");
    expect(html).toContain("Tamás");
  });

  it("puts the summary in a wrapped sub-row rather than a truncated cell", () => {
    const html = buildLeadsPdfHtml([TRICKY], [], BRAND, PDF_META);
    expect(html).toContain('class="brief"');
    expect(html).toContain("Person summary");
    // The whole brief, not an ellipsis.
    expect(html).toContain("Second line, with a comma.");
    expect(html).not.toContain("…");
    // And it spans the table rather than sitting in one column.
    expect(html).toContain(`colspan="${pdfTableColumns().length}"`);
  });

  it("gives a lead with no summary no sub-row at all", () => {
    const bare = { ...LEADS[3]!, personBrief: null };
    const html = buildLeadsPdfHtml([bare], [], BRAND, PDF_META);
    expect(html).not.toContain('class="brief"');
  });

  it("escapes markup rather than rendering it", () => {
    const html = buildLeadsPdfHtml(
      [{ ...LEADS[0]!, contactName: "<script>alert(1)</script>" }],
      [],
      BRAND,
      PDF_META,
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("localises its dates, where the other two formats stay ISO", () => {
    // The table carries no date column, so this is checked on the resolver the
    // document uses — day-month-year for a reader, ISO for a sort.
    const created = EXPORT_COLUMNS.find((c) => c.key === "created")!;
    expect(cellText(created, LEADS[0]!)).toBe("2026-07-15");
    expect(cellText(created, LEADS[0]!, { iso: false })).toBe("15/07/2026");
  });

  it("says nothing matched rather than printing an empty table", () => {
    const html = buildLeadsPdfHtml([], [], BRAND, PDF_META);
    expect(html).toContain("No leads matched.");
  });

  it("names the spreadsheet when the row count is past what a document holds", () => {
    const msg = pdfRowCapMessage(MAX_PDF_ROWS + 1);
    expect(msg).toContain(String(MAX_PDF_ROWS));
    expect(msg).toContain("Excel");
  });
});
