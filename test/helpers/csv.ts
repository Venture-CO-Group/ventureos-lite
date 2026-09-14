/**
 * A real RFC 4180 reader, for asserting that what we wrote can be read back.
 *
 * Deliberately NOT the writer's own escaping logic run backwards. A round-trip
 * test against the code that produced the string proves only that the function
 * is self-consistent — it would pass just as happily if we invented our own
 * quoting rules and no spreadsheet on earth could open the file. This parses
 * the way a reader does: quotes toggle a quoted section, a doubled quote inside
 * one is a literal quote, and a comma or a line break inside one is data.
 */
export function parseCsv(text: string): string[][] {
  // The BOM is for Excel; a parser must not hand it back as part of the first
  // header cell.
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      // CRLF is one break, not two empty rows.
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  // A file that does not end in a newline still has a last row.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** One row, for the common case of checking a header or a single lead. */
export function parseCsvRow(text: string): string[] {
  return parseCsv(text)[0] ?? [];
}

/** The cell under `label` on data row `n` (0-based, header excluded). */
export function csvCell(text: string, label: string, n = 0): string {
  const rows = parseCsv(text);
  const i = (rows[0] ?? []).indexOf(label);
  if (i < 0) throw new Error(`no column named ${label}`);
  return rows[n + 1]?.[i] ?? "";
}
