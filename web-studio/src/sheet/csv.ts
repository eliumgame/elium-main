/** CSV parsing — RFC-4180-ish (quoted fields, "" escapes, , and newlines). */
import { indexToCol } from "./formula";
import type { Workbook } from "./model";

/** Guess the column delimiter from the first line (handles fr-FR `;` exports). */
function sniffDelim(text: string): string {
  const nl = text.indexOf("\n");
  const first = nl >= 0 ? text.slice(0, nl) : text;
  const count = (ch: string) => (first.split(ch).length - 1);
  const tab = count("\t"), semi = count(";"), comma = count(",");
  if (tab >= semi && tab >= comma && tab > 0) return "\t";
  return semi > comma ? ";" : ",";
}

export function parseCsv(text: string, delim = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function csvToWorkbook(text: string): Workbook {
  const rows = parseCsv(text, sniffDelim(text));
  const cells: Record<string, string> = {};
  let maxCol = 7;
  rows.forEach((r, ri) =>
    r.forEach((val, ci) => {
      if (val !== "") {
        cells[indexToCol(ci) + (ri + 1)] = val;
        maxCol = Math.max(maxCol, ci);
      }
    }),
  );
  return { sheets: [{ name: "Importé", rows: Math.max(20, rows.length), cols: maxCol + 1, cells }], active: 0 };
}
