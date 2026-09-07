import type { FieldDef } from "@/modules/fields/types";
import type { WorkspaceBrand } from "@/modules/workspaces/brand";
import { brandBaseCss, brandMarkHtml, brandRootStyle } from "@/modules/workspaces/letterhead";
import { buildLeadsCsv, leadCellValue, leadColumnLabel, type CsvLead } from "./bulk";

/**
 * The three shapes a lead list leaves the product in.
 *
 * ── WHY THREE ───────────────────────────────────────────────────────────────
 *
 * CSV was the only one, and it is the right answer for exactly one audience:
 * another system. It is the wrong answer for the two audiences that actually
 * ask for a lead list. A colleague wants a spreadsheet that opens with the
 * columns already sized and the header frozen — a CSV opens as a wall of text
 * and, in Hungarian Excel, opens WRONG unless the delimiter happens to match.
 * A client or a partner wants a document with our name on it, not a data file.
 *
 * All three read the same rows through the same `leadCellValue`, so a column
 * means the same thing in all of them and none can drift from the table the
 * operator was looking at when they pressed the button.
 */
export const EXPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const FORMAT_LABEL: Record<ExportFormat, string> = {
  csv: "CSV",
  xlsx: "Excel (.xlsx)",
  pdf: "Branded PDF",
};

/**
 * The most leads one export may carry.
 *
 * A ceiling exists because all three formats are now built in one server pass:
 * the spreadsheet is held in memory before it is written, and the PDF is a
 * headless-Chrome render whose page count grows with the row count. Ten
 * thousand rows is far past any list a person reads and comfortably inside
 * what one request can build.
 */
export const MAX_EXPORT_ROWS = 10_000;

export const FORMAT_HINT: Record<ExportFormat, string> = {
  csv: "For importing into another system. Opens in any spreadsheet.",
  xlsx: "A real spreadsheet — sized columns, frozen header, filters on.",
  pdf: "A document with your letterhead, for sending to someone.",
};

/** CSV, with the BOM Excel needs to read Hungarian accents correctly. */
export function buildLeadsCsvFile(
  leads: CsvLead[],
  columns: string[],
  customFields: FieldDef[] = [],
): string {
  return buildLeadsCsv(leads, columns, customFields);
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/**
 * A spreadsheet, not a text file that a spreadsheet can open.
 *
 * `exceljs` rather than a hand-rolled ZIP: the container is a picky format and
 * a file Excel silently refuses to open is worse than no feature. The output is
 * verified by reading it back in the tests, which is the only check that
 * actually means anything here.
 *
 * Server-only — this is never bundled to the client.
 */
export async function buildLeadsXlsx(
  leads: CsvLead[],
  columns: string[],
  customFields: FieldDef[] = [],
  meta: { workspaceName: string; exportedAt: Date } = {
    workspaceName: "Leads",
    exportedAt: new Date(),
  },
): Promise<Buffer> {
  // Imported here rather than at module scope so the client bundle and the
  // pure-CSV path never pull in a spreadsheet library.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.workspaceName;
  wb.created = meta.exportedAt;

  const sheet = wb.addWorksheet("Leads", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  const headers = columns.map((key) => leadColumnLabel(key, customFields));
  sheet.addRow(headers);

  for (const lead of leads) {
    sheet.addRow(
      columns.map((key) => {
        const raw = leadCellValue(lead, key, customFields);
        // Numbers go in as numbers so a column can be summed and sorted. The
        // ICP score sorting as text — "10" before "2" — is the sort of defect
        // that makes people stop trusting an export.
        if (key === "icpScore" && raw !== "") {
          const n = Number(raw);
          if (Number.isFinite(n)) return n;
        }
        return raw;
      }),
    );
  }

  // Header styling and an autofilter, because a list of leads is something you
  // sort and filter — that is what it is FOR.
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: "middle" };
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(1, columns.length) },
  };

  // Width from the widest value in the column, clamped. An unsized column shows
  // "########" for anything long, which is a spreadsheet's way of saying the
  // export did not finish the job.
  columns.forEach((key, i) => {
    const col = sheet.getColumn(i + 1);
    let widest = headers[i]?.length ?? 10;
    for (const lead of leads) {
      const v = leadCellValue(lead, key, customFields);
      if (v.length > widest) widest = v.length;
    }
    col.width = Math.min(48, Math.max(10, widest + 2));
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// Branded PDF
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * How many columns fit on a page before the table stops being readable.
 *
 * A PDF has a fixed width, and a lead list can carry twenty columns. Past this
 * the type has to shrink to a size nobody reads, so the extra columns are
 * dropped and the document SAYS SO — silently truncating an export is how you
 * get someone quoting from a document that is missing the phone number.
 */
export const PDF_MAX_COLUMNS = 8;

export interface LeadsPdfMeta {
  /** How the selection was described, e.g. "42 leads · Qualified". */
  subtitle: string;
  exportedAt: Date;
  exportedBy: string;
}

export function buildLeadsPdfHtml(
  leads: CsvLead[],
  columns: string[],
  customFields: FieldDef[],
  brand: WorkspaceBrand,
  meta: LeadsPdfMeta,
): string {
  const shown = columns.slice(0, PDF_MAX_COLUMNS);
  const dropped = columns.length - shown.length;

  const head = shown
    .map((key) => `<th${key === "icpScore" ? ' class="num"' : ""}>${esc(leadColumnLabel(key, customFields))}</th>`)
    .join("");

  const body = leads
    .map(
      (lead) =>
        `<tr>${shown
          .map(
            (key) =>
              `<td${key === "icpScore" ? ' class="num"' : ""}>${esc(
                leadCellValue(lead, key, customFields),
              )}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");

  const date = meta.exportedAt.toISOString().slice(0, 10);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  @page { size: A4 landscape; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--brand-font-body); background: var(--brand-canvas); color: var(--brand-ink); padding: 30px 32px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  ${brandBaseCss()}
  .brand { margin-bottom: 2px; }
  .brand b { font-weight: 800; } .brand span { font-weight: 300; color: var(--brand-muted); margin-left: 6px; }
  .kicker { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--brand-muted); margin-bottom: 4px; }
  h1 { font-family: var(--brand-font-display); font-size: 24px; font-weight: 800; letter-spacing: -0.02em; text-transform: lowercase; margin-bottom: 4px; }
  .sub { font-size: 11.5px; color: var(--brand-muted); margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  th { text-align: left; padding: 6px 8px 6px 0; border-bottom: 1.5px solid var(--brand-accent); color: var(--brand-accent); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; }
  td { text-align: left; padding: 5px 8px 5px 0; border-bottom: 1px solid rgba(239,241,248,0.09); color: var(--brand-ink-soft); vertical-align: top; }
  /* Right-aligned with room after it: at padding-right 0 the score sat flush
     against the next column's heading and read as one word. */
  .num { text-align: right; font-variant-numeric: tabular-nums; padding-right: 18px; width: 1%; white-space: nowrap; }
  /* Repeat the header on every printed page — a five-page table whose columns
     are only labelled on page one is a table you have to keep flipping back in. */
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .note { margin-top: 12px; font-size: 10px; color: var(--brand-muted); }
  .foot { margin-top: 18px; padding-top: 10px; border-top: 1px solid rgba(239,241,248,0.09); font-size: 9.5px; color: var(--brand-muted); }
</style></head>
<body style="${brandRootStyle(brand)}">
  <div class="brand">${brandMarkHtml(brand)}</div>
  <div class="kicker">Lead export</div>
  <h1>${esc(brand.name.toLowerCase())} — leads</h1>
  <div class="sub">${esc(meta.subtitle)} · ${date} · ${esc(meta.exportedBy)}</div>

  <table>
    <thead><tr>${head}</tr></thead>
    <tbody>${body || `<tr><td colspan="${Math.max(1, shown.length)}">No leads matched.</td></tr>`}</tbody>
  </table>

  ${
    dropped > 0
      ? `<p class="note">${dropped} further column${dropped === 1 ? "" : "s"} ${
          dropped === 1 ? "was" : "were"
        } left out — a page fits ${PDF_MAX_COLUMNS} and stays readable. Export as Excel or CSV for the complete set.</p>`
      : ""
  }

  <div class="foot">${esc(brand.footerIdentity)}</div>
</body></html>`;
}
