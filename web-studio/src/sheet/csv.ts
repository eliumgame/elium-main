import { parseCellNumber } from "./numeric";
/** CSV parsing — RFC-4180-ish (quoted fields, "" escapes, , and newlines). */
import { indexToCol } from "./formula";
import type { Workbook } from "./model";

/** Guess the column delimiter from the first line (handles fr-FR `;` exports). */
function sniffDelim(text: string): string {
  const nl = text.indexOf("\n");
  const first = nl >= 0 ? text.slice(0, nl) : text;
  const count = (ch: string) => first.split(ch).length - 1;
  const tab = count("\t"),
    semi = count(";"),
    comma = count(",");
  if (tab >= semi && tab >= comma && tab > 0) return "\t";
  return semi > comma ? ";" : ",";
}

const SLICE_MS = 10;
const nextTurn = () => new Promise<void>((r) => setTimeout(r, 0));

export async function parseCsvAsync(text: string, delim = ","): Promise<string[][]> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let last = performance.now();
  for (let i = 0; i < text.length; i++) {
    if ((i & 0x3fff) === 0 && performance.now() - last >= SLICE_MS) {
      await nextTurn();
      last = performance.now();
    }
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

/**
 * Valeur importée d'une cellule CSV. Les nombres valides (« 12 », « -3 », « +5 », « 12,5 », « 1 234,5 »)
 * restent tels quels, donc des nombres sommables. Seul le texte qui commencerait comme une formule
 * (= + - @, tabulation, retour chariot) sans être un nombre est neutralisé par une apostrophe
 * (texte littéral : « =SUM(A1:A2) » ne s'exécute pas).
 */
export function csvImportCell(text: string): string {
  if (parseCellNumber(text) !== null) return text;
  return /^[=+\-@\t\r']/.test(text) ? "'" + text : text;
}

export function csvToWorkbook(text: string): Workbook {
  const rows = parseCsv(text, sniffDelim(text));
  const cells: Record<string, string> = {};
  let maxCol = 7;
  rows.forEach((r, ri) =>
    r.forEach((val, ci) => {
      if (val !== "") {
        cells[indexToCol(ci) + (ri + 1)] = csvImportCell(val);
        maxCol = Math.max(maxCol, ci);
      }
    }),
  );
  return { sheets: [{ name: "Importé", rows: Math.max(20, rows.length), cols: maxCol + 1, cells }], active: 0 };
}

/** Variante coopérative de {@link csvToWorkbook} : rend la main au navigateur par tranches (gros fichiers). */
export async function csvToWorkbookAsync(text: string): Promise<Workbook> {
  const rows = await parseCsvAsync(text, sniffDelim(text));
  const cells: Record<string, string> = {};
  let maxCol = 7;
  let last = performance.now();
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri]!;
    for (let ci = 0; ci < r.length; ci++) {
      const val = r[ci]!;
      if (val !== "") {
        cells[indexToCol(ci) + (ri + 1)] = csvImportCell(val);
        if (ci > maxCol) maxCol = ci;
      }
    }
    if ((ri & 0x3ff) === 0 && performance.now() - last >= SLICE_MS) {
      await nextTurn();
      last = performance.now();
    }
  }
  return { sheets: [{ name: "Importé", rows: Math.max(20, rows.length), cols: maxCol + 1, cells }], active: 0 };
}

/** RFC 4180 escaping plus spreadsheet formula neutralisation. */
export function csvSafeCell(value: string): string {
  const numeric = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?$/.test(value);
  const safe = /^[\t\r\n]/.test(value) || (/^\s*[=+@-]/.test(value) && !numeric) ? "'" + value : value;
  return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}
