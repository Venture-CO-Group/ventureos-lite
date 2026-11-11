/**
 * Writing a Company Finder export (item 6): CSV (UTF-8 with BOM, RFC 4180
 * quoting, CRLF) and XLSX (typed cells, hyperlinks, frozen header,
 * autofilter). Pure apart from the spreadsheet library, so the round-trip
 * tests read exactly what a person would download.
 */
import { CSV_BOM } from "@/modules/leads/bulk";
import type { FinderColumn } from "./export-columns";
import type { FinderRow } from "./row";

/**
 * Quote when a cell contains a delimiter, a quote or a line break — and also
 * a semicolon, because Hungarian Excel splits on it, and a leading or
 * trailing space, which some readers trim. Doubled quotes inside.
 */
export function csvCell(v: string): string {
  return /[",;\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function text(c: FinderColumn, r: FinderRow): string {
  const v = c.get(r);
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

export function buildFinderCsv(rows: readonly FinderRow[], cols: readonly FinderColumn[]): Buffer {
  const lines = [cols.map((c) => csvCell(c.label)).join(","), ...rows.map((r) => cols.map((c) => csvCell(text(c, r))).join(","))];
  return Buffer.from(CSV_BOM + lines.join("\r\n") + "\r\n", "utf8");
}

/** A minimal RFC 4180 reader — for the round-trip tests and nothing else. */
export function parseCsv(input: string): string[][] {
  const s = input.startsWith(CSV_BOM) ? input.slice(1) : input;
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && s[i + 1] === "\n") {
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

const absolute = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

/** "2019", "2019-09", "2019-09-16" → a UTC date, or null. */
function toDate(v: string): Date | null {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(v);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2] ?? 1) - 1, Number(m[3] ?? 1)));
}

export async function buildFinderXlsx(
  rows: readonly FinderRow[],
  cols: readonly FinderColumn[],
  meta: { listName: string; exportedAt: Date; workspaceName: string },
): Promise<Buffer> {
  // Imported here so the client bundle and the CSV path never pull it in.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.workspaceName;
  wb.created = meta.exportedAt;
  const name = `${meta.listName} ${meta.exportedAt.toISOString().slice(0, 10)}`.replace(/[\\/?*[\]:]/g, "-").slice(0, 31);
  const sheet = wb.addWorksheet(name || "Companies", { views: [{ state: "frozen", ySplit: 1 }] });

  sheet.columns = cols.map((c) => ({
    header: c.label,
    key: c.key,
    width: c.kind === "number" ? 16 : c.kind === "date" ? 12 : c.kind === "bool" ? 10 : Math.min(48, Math.max(12, c.label.length + 4)),
    style:
      c.kind === "number"
        ? { numFmt: "#,##0" }
        : c.kind === "date"
          ? { numFmt: "yyyy-mm-dd" }
          : {},
  }));

  for (const r of rows) {
    const row = sheet.addRow(
      cols.map((c) => {
        const v = c.get(r);
        if (v === null || v === undefined || v === "") return null;
        if (c.kind === "date") return typeof v === "string" ? (toDate(v) ?? v) : v;
        return v;
      }),
    );
    cols.forEach((c, i) => {
      const v = c.get(r);
      if (typeof v !== "string" || !v) return;
      if (c.kind === "url" || c.kind === "email") {
        const cell = row.getCell(i + 1);
        cell.value = { text: v, hyperlink: c.kind === "email" ? `mailto:${v}` : absolute(v) };
        cell.font = { color: { argb: "FF7427C6" }, underline: true };
      }
    });
  }

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF1F8" } };
  if (cols.length > 0) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: cols.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
