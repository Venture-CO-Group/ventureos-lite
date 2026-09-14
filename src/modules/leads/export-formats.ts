import type { FieldDef } from "@/modules/fields/types";
import type { WorkspaceBrand } from "@/modules/workspaces/brand";
import { brandBaseCss, brandMarkHtml, brandRootStyle } from "@/modules/workspaces/letterhead";
import { buildLeadsCsv, leadsCsvBuffer, type CsvLead } from "./bulk";
import {
  EXPORT_FORMATS,
  cellText,
  exportColumns,
  isWrapped,
  pdfSubrowColumns,
  pdfTableColumns,
  type ExportFormat,
} from "./export-columns";

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
 * ── WHY NONE OF THEM DECIDES ITS OWN COLUMNS ────────────────────────────────
 *
 * All three read `export-columns.ts` and nothing else. None of them takes a
 * column list, so none of them can be given a different one: a field is added
 * to the registry and appears in all three, or in none. The formats differ only
 * in how they PRINT a cell — a date is ISO in the two machine-readable formats
 * and localised in the document, a number is a real number in the spreadsheet,
 * a URL is clickable where clicking is possible.
 */
export { EXPORT_FORMATS, type ExportFormat };

export const FORMAT_LABEL: Record<ExportFormat, string> = {
  csv: "CSV",
  xlsx: "Excel (.xlsx)",
  pdf: "Branded PDF",
};

/**
 * The most leads one export may carry.
 *
 * A ceiling exists because all three formats are built in one server pass: the
 * spreadsheet is held in memory before it is written, and the PDF is a
 * headless-Chrome render whose page count grows with the row count. Ten
 * thousand rows is far past any list a person reads and comfortably inside what
 * one request can build.
 */
export const MAX_EXPORT_ROWS = 10_000;

/**
 * The most leads a PDF may carry, which is far fewer.
 *
 * A document is for reading and for sending to somebody. Every lead takes a
 * table row plus a wrapped summary block, so a thousand leads is a couple of
 * hundred pages that nobody opens and that takes minutes to render. Past this
 * the answer is a spreadsheet, and the caller says so rather than quietly
 * producing something useless.
 */
export const MAX_PDF_ROWS = 500;

/**
 * Above this, the caller shows progress rather than pretending it is instant.
 *
 * A few hundred rows build faster than a person notices. Several thousand do
 * not, and a button that looks broken for twenty seconds gets clicked again.
 */
export const EXPORT_PROGRESS_THRESHOLD = 250;

/**
 * Above this many rows, an export is delivered as a file rather than inline.
 *
 * Well under `MAX_EXPORT_ROWS`: the point is to keep the large cases off the
 * server action's payload, not to push every export through the filesystem.
 * Lives here with the other limits rather than in `bulk-actions.ts`, which is a
 * `"use server"` module and may export nothing but functions.
 */
export const FILE_DELIVERY_THRESHOLD = 1_000;

export const FORMAT_HINT: Record<ExportFormat, string> = {
  csv: "For importing into another system. Opens in any spreadsheet.",
  xlsx: "A real spreadsheet — sized columns, frozen header, filters on.",
  pdf: `A document with your letterhead, for sending to someone. Up to ${MAX_PDF_ROWS} leads.`,
};

/** Why a PDF was refused, in words the operator can act on. */
export function pdfRowCapMessage(rows: number): string {
  return (
    `That is ${rows} leads and a PDF holds ${MAX_PDF_ROWS} — past that it is a ` +
    `few hundred pages nobody reads. Export as Excel for the whole set, or ` +
    `narrow the filter.`
  );
}

/** CSV, with the BOM Excel needs to read Hungarian accents correctly. */
export { buildLeadsCsv, leadsCsvBuffer };

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

export interface LeadsSheetMeta {
  workspaceName: string;
  exportedAt: Date;
  /** How the rows were chosen, printed on the header row's tooltip and note. */
  filterSummary?: string;
}

/** Widths, in characters. A column narrower than this is unreadable; wider is waste. */
const MIN_COL_WIDTH = 10;
const MAX_COL_WIDTH = 48;
/** Wrapped columns get a fixed generous width — the text flows, so it need not fit. */
const WRAPPED_COL_WIDTH = 60;

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
  customFields: FieldDef[] = [],
  meta: LeadsSheetMeta = { workspaceName: "Leads", exportedAt: new Date() },
): Promise<Buffer> {
  // Imported here rather than at module scope so the client bundle and the
  // pure-CSV path never pull in a spreadsheet library.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.workspaceName;
  wb.created = meta.exportedAt;

  const defs = exportColumns("xlsx", customFields);

  // A sheet named for what is in it and when, because these files get saved and
  // re-opened weeks later. Excel forbids \ / ? * [ ] : in a sheet name and caps
  // it at 31 characters.
  const sheetName = `Leads ${meta.exportedAt.toISOString().slice(0, 10)}`
    .replace(/[\\/?*[\]:]/g, "-")
    .slice(0, 31);

  const sheet = wb.addWorksheet(sheetName, {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.addRow(defs.map((d) => d.label));

  for (const lead of leads) {
    const row = sheet.addRow(
      defs.map((d) => {
        const v = d.resolve(lead);
        // Numbers as numbers and dates as dates, so the columns sort and filter
        // as what they are. The ICP score sorting as text — "10" before "2" —
        // is the sort of defect that makes people stop trusting an export.
        if (v === null) return null;
        return v;
      }),
    );

    // Hyperlinks on the columns that hold one. A LinkedIn URL you have to copy
    // out of a cell and paste into a bar is a URL nobody follows.
    defs.forEach((d, i) => {
      if (d.kind !== "url") return;
      const text = cellText(d, lead);
      if (!text) return;
      const cell = row.getCell(i + 1);
      cell.value = { text, hyperlink: absoluteUrl(text) };
      cell.font = { color: { argb: "FF7427C6" }, underline: true };
    });

    row.alignment = { vertical: "top" };
  }

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: "middle", wrapText: false };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFEFF1F8" },
  };
  header.border = { bottom: { style: "thin", color: { argb: "FF858CAE" } } };

  // An autofilter across the header, because a list of leads is something you
  // sort and filter — that is what it is FOR.
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(1, defs.length) },
  };

  defs.forEach((d, i) => {
    const col = sheet.getColumn(i + 1);

    if (d.kind === "date") {
      // A real date cell, formatted the way the other two formats write it, so
      // the three files still read alike.
      col.numFmt = "yyyy-mm-dd";
    }

    if (isWrapped(d)) {
      // Summary and notes wrap instead of stretching the sheet sideways. Width
      // from the content here would produce a 3000-character column.
      col.width = WRAPPED_COL_WIDTH;
      col.alignment = { wrapText: true, vertical: "top" };
      return;
    }

    // Width from the widest value in the column, clamped. An unsized column
    // shows "########" for anything long, which is a spreadsheet's way of
    // saying the export did not finish the job.
    let widest = d.label.length;
    for (const lead of leads) {
      const len = cellText(d, lead).length;
      if (len > widest) widest = len;
    }
    col.width = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, widest + 2));
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * A link Excel will actually open.
 *
 * A bare domain — "pelda.hu", which is how a company domain is stored — is not
 * a URL, and a hyperlink to it resolves against the file's own location and
 * goes nowhere.
 */
function absoluteUrl(v: string): string {
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

// ---------------------------------------------------------------------------
// Branded PDF
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface LeadsPdfMeta {
  /** How the selection was described, e.g. "42 leads · Qualified". */
  subtitle: string;
  /** The filters that produced these rows, spelled out. */
  filterSummary?: string;
  exportedAt: Date;
  exportedBy: string;
  /** The true row count, which may exceed what the document carries. */
  totalRows?: number;
}

/**
 * The footer Chrome prints on every page.
 *
 * Page numbers live here rather than in the document body because only the
 * print engine knows how many pages there turned out to be.
 */
export const PDF_FOOTER_TEMPLATE = `
<div style="width:100%;padding:0 14mm;font-family:Inter,Helvetica,Arial,sans-serif;font-size:7.5pt;color:#858CAE;display:flex;justify-content:flex-end;">
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`;

/** Margins that leave the footer somewhere to print. */
export const PDF_MARGIN = { top: "10mm", bottom: "12mm", left: "0", right: "0" };

/**
 * A branded document, landscape.
 *
 * ── WHY LANDSCAPE, AND WHY A SUB-ROW ────────────────────────────────────────
 *
 * The full record is over twenty columns. Portrait fits perhaps six before the
 * type shrinks below reading size, and the old behaviour — take the first eight
 * columns and print a note admitting the rest were dropped — meant the document
 * silently lacked the phone number depending on what the table was showing.
 *
 * Landscape fits the seven that identify and qualify a lead. The person summary
 * is prose, and prose in a table cell is prose truncated with an ellipsis, so it
 * gets a full-width wrapped row of its own beneath each lead. Nothing is
 * dropped: the columns a document cannot carry are what the spreadsheet is for,
 * and the header says so.
 */
export function buildLeadsPdfHtml(
  leads: CsvLead[],
  customFields: FieldDef[],
  brand: WorkspaceBrand,
  meta: LeadsPdfMeta,
): string {
  const table = pdfTableColumns();
  const subrow = pdfSubrowColumns();
  const span = Math.max(1, table.length);

  const head = table
    .map(
      (d) =>
        `<th${d.kind === "number" ? ' class="num"' : ""}>${esc(d.label)}</th>`,
    )
    .join("");

  const body = leads
    .map((lead) => {
      const cells = table
        .map(
          (d) =>
            `<td${d.kind === "number" ? ' class="num"' : ""}>${esc(
              // Localised dates: this one is read by a person, not a sort.
              cellText(d, lead, { iso: false }),
            )}</td>`,
        )
        .join("");

      const notes = subrow
        .map((d) => {
          const text = cellText(d, lead, { iso: false });
          // A lead with no summary gets no sub-row at all — an empty labelled
          // block on every second lead is noise, not information.
          if (!text) return "";
          return `<tr class="brief"><td colspan="${span}"><span class="lbl">${esc(
            d.label,
          )}</span>${esc(text)}</td></tr>`;
        })
        .join("");

      return `<tr class="lead">${cells}</tr>${notes}`;
    })
    .join("");

  const date = meta.exportedAt.toISOString().slice(0, 10);
  const rows = meta.totalRows ?? leads.length;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  @page { size: A4 landscape; margin: 10mm 0 12mm 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--brand-font-body); background: var(--brand-canvas); color: var(--brand-ink); padding: 8px 14mm; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  ${brandBaseCss()}
  .brand { margin-bottom: 2px; }
  .brand b { font-weight: 800; } .brand span { font-weight: 300; color: var(--brand-muted); margin-left: 6px; }
  .kicker { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--brand-muted); margin-bottom: 4px; }
  h1 { font-family: var(--brand-font-display); font-size: 24px; font-weight: 800; letter-spacing: -0.02em; text-transform: lowercase; margin-bottom: 4px; }
  .sub { font-size: 11.5px; color: var(--brand-muted); margin-bottom: 4px; }
  /* The filters that produced this list, on the document itself. A lead list
     with no statement of what it is a list OF is a list you cannot check. */
  .filters { font-size: 10.5px; color: var(--brand-ink-soft); margin-bottom: 14px; }
  .filters b { color: var(--brand-muted); font-weight: 400; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  th { text-align: left; padding: 6px 8px 6px 0; border-bottom: 1.5px solid var(--brand-accent); color: var(--brand-accent); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; }
  td { text-align: left; padding: 5px 8px 5px 0; color: var(--brand-ink-soft); vertical-align: top; }
  tr.lead td { border-bottom: 1px solid rgba(239,241,248,0.09); }
  /* The summary block. Wrapped, full width, and visually attached to the lead
     above it rather than reading as another row of the table. */
  tr.brief td { border-bottom: 1px solid rgba(239,241,248,0.09); padding: 0 0 7px 0; font-size: 9.5px; line-height: 1.45; color: var(--brand-muted); white-space: pre-wrap; }
  tr.brief .lbl { display: block; font-size: 8px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--brand-accent); margin-bottom: 2px; }
  /* Right-aligned with room after it: at padding-right 0 the score sat flush
     against the next column's heading and read as one word. */
  .num { text-align: right; font-variant-numeric: tabular-nums; padding-right: 18px; width: 1%; white-space: nowrap; }
  /* Repeat the header on every printed page — a five-page table whose columns
     are only labelled on page one is a table you have to keep flipping back in. */
  thead { display: table-header-group; }
  /* A lead and its summary stay together; breaking between them orphans a
     paragraph of prose under someone else's name. */
  tr { page-break-inside: avoid; }
  .note { margin-top: 12px; font-size: 10px; color: var(--brand-muted); }
  .foot { margin-top: 18px; padding-top: 10px; border-top: 1px solid rgba(239,241,248,0.09); font-size: 9.5px; color: var(--brand-muted); }
</style></head>
<body style="${brandRootStyle(brand)}">
  <div class="brand">${brandMarkHtml(brand)}</div>
  <div class="kicker">Lead export</div>
  <h1>${esc(brand.name.toLowerCase())} — leads</h1>
  <div class="sub">${esc(meta.subtitle)} · ${date} · ${esc(meta.exportedBy)}</div>
  <div class="filters">
    <b>Rows:</b> ${rows}${
      meta.filterSummary ? ` &nbsp;·&nbsp; <b>Filters:</b> ${esc(meta.filterSummary)}` : ""
    }
  </div>

  <table>
    <thead><tr>${head}</tr></thead>
    <tbody>${body || `<tr><td colspan="${span}">No leads matched.</td></tr>`}</tbody>
  </table>

  <p class="note">A document carries the columns that identify and qualify a lead. Export as Excel or CSV for the complete record.</p>

  <div class="foot">${esc(brand.footerIdentity)}</div>
</body></html>`;
}
