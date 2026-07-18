/**
 * XLSX export — the inverse of xlsx-import.ts. Produces a valid SpreadsheetML
 * (OPC) package: a workbook, one worksheet per sheet, and a styles part.
 *
 * - numbers        → numeric cells (`<v>`)
 * - text           → inline strings (`t="inlineStr"`) so no shared-strings part
 *                    is needed
 * - formulas (`=`) → `<f>` without a cached value; `fullCalcOnLoad` makes Excel
 *                    and LibreOffice recompute on open (keeps us decoupled from
 *                    the formula engine)
 * - cell styles    → a deduplicated numFmt/font/fill/xf table (number format,
 *                    bold/italic, text colour, fill, horizontal alignment)
 */
import { zipSync, strToU8 } from "fflate";
import type { Workbook, SheetData, CellStyle, NumFmt } from "./model";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"; // rel types base

const xe = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 0-based column index → spreadsheet letters (0→"A", 26→"AA"). */
export function colLetters(n: number): string {
  let s = "";
  let x = n + 1;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function parseKey(key: string): { col: number; row: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(key);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2]!, 10) };
}

const isNumeric = (s: string): boolean => /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim());

function hex6(c: string | undefined): string | null {
  if (!c) return null;
  let h = c.replace(/^#/, "").trim();
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((x) => x + x).join("");
  return /^[0-9a-fA-F]{6}$/.test(h) ? h.toUpperCase() : null;
}

// Custom number-format codes (built-in id 0 = "General" needs no numFmt entry).
const NUMFMT_CODE: Record<Exclude<NumFmt, "general">, string> = {
  number: "0.00",
  int: "0",
  currency: "#,##0.00\\ €",
  percent: "0%",
  date: "yyyy\\-mm\\-dd",
  datetime: "yyyy\\-mm\\-dd\\ hh:mm",
};

/** Accumulates the numFmt/font/fill/xf tables while cells are serialized. */
function createStyleTable() {
  const numFmts = new Map<string, number>(); // code → id (≥164)
  let nextFmtId = 164;
  const fmtId = (fmt?: NumFmt): number => {
    if (!fmt || fmt === "general") return 0;
    const code = NUMFMT_CODE[fmt];
    if (!numFmts.has(code)) numFmts.set(code, nextFmtId++);
    return numFmts.get(code)!;
  };

  const fonts: string[] = ['<font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>'];
  const fontKey = new Map<string, number>();
  const fontId = (st?: CellStyle): number => {
    if (!st || (!st.bold && !st.italic && !st.color && !st.fontFamily && !st.fontSize)) return 0;
    const name = st.fontFamily?.split(",")[0]!.replace(/['"]/g, "").trim() || "Calibri";
    const sz = st.fontSize ? Math.max(1, Math.round(st.fontSize * 0.75)) : 11; // px → pt
    const col = hex6(st.color);
    const key = `${st.bold ? 1 : 0}|${st.italic ? 1 : 0}|${col ?? ""}|${name}|${sz}`;
    const found = fontKey.get(key);
    if (found !== undefined) return found;
    const parts = [`<sz val="${sz}"/>`];
    if (st.bold) parts.push("<b/>");
    if (st.italic) parts.push("<i/>");
    parts.push(col ? `<color rgb="FF${col}"/>` : '<color theme="1"/>');
    parts.push(`<name val="${xe(name)}"/>`);
    fonts.push(`<font>${parts.join("")}</font>`);
    const id = fonts.length - 1;
    fontKey.set(key, id);
    return id;
  };

  // Index 0 = none and 1 = gray125 are RESERVED by the spec; solids start at 2.
  const fills: string[] = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
  ];
  const fillKey = new Map<string, number>();
  const fillId = (st?: CellStyle): number => {
    const c = hex6(st?.fill);
    if (!c) return 0;
    const found = fillKey.get(c);
    if (found !== undefined) return found;
    fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`);
    const id = fills.length - 1;
    fillKey.set(c, id);
    return id;
  };

  const xfs: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const xfKey = new Map<string, number>();
  const xfIndexOf = (st?: CellStyle): number => {
    if (!st) return 0;
    const nf = fmtId(st.fmt);
    const fo = fontId(st);
    const fi = fillId(st);
    const al = st.align && st.align !== "left" ? st.align : undefined;
    if (!nf && !fo && !fi && !al) return 0;
    const key = `${nf}|${fo}|${fi}|${al ?? ""}`;
    const found = xfKey.get(key);
    if (found !== undefined) return found;
    const attrs =
      `numFmtId="${nf}" fontId="${fo}" fillId="${fi}" borderId="0" xfId="0"` +
      (nf ? ' applyNumberFormat="1"' : "") +
      (fo ? ' applyFont="1"' : "") +
      (fi ? ' applyFill="1"' : "") +
      (al ? ' applyAlignment="1"' : "");
    xfs.push(al ? `<xf ${attrs}><alignment horizontal="${al}"/></xf>` : `<xf ${attrs}/>`);
    const id = xfs.length - 1;
    xfKey.set(key, id);
    return id;
  };

  const toXml = (): string => {
    const numFmtEls = [...numFmts.entries()].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${xe(code)}"/>`);
    const numFmtsBlock = numFmtEls.length ? `<numFmts count="${numFmtEls.length}">${numFmtEls.join("")}</numFmts>` : "";
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<styleSheet xmlns="${NS}">` +
      numFmtsBlock +
      `<fonts count="${fonts.length}">${fonts.join("")}</fonts>` +
      `<fills count="${fills.length}">${fills.join("")}</fills>` +
      `<borders count="1"><border/></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`
    );
  };

  return { xfIndexOf, toXml };
}

function cellXml(key: string, raw: string, s: number): string {
  const sAttr = s ? ` s="${s}"` : "";
  if (raw.startsWith("=")) {
    return `<c r="${key}"${sAttr}><f>${xe(raw.slice(1))}</f></c>`;
  }
  if (isNumeric(raw)) {
    return `<c r="${key}"${sAttr}><v>${xe(raw.trim())}</v></c>`;
  }
  return `<c r="${key}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xe(raw)}</t></is></c>`;
}

function sheetXml(sheet: SheetData, styles: ReturnType<typeof createStyleTable>): string {
  // Group non-empty cells by row.
  const byRow = new Map<number, { key: string; col: number; raw: string; s: number }[]>();
  let maxCol = Math.max(0, sheet.cols - 1);
  let maxRow = Math.max(1, sheet.rows);
  for (const [key, raw] of Object.entries(sheet.cells)) {
    if (raw === "" || raw == null) continue;
    const pos = parseKey(key);
    if (!pos) continue;
    const s = styles.xfIndexOf(sheet.styles?.[key]);
    if (!byRow.has(pos.row)) byRow.set(pos.row, []);
    byRow.get(pos.row)!.push({ key, col: pos.col, raw, s });
    maxCol = Math.max(maxCol, pos.col);
    maxRow = Math.max(maxRow, pos.row);
  }
  const rows = [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([r, list]) => {
      const cells = list.sort((a, b) => a.col - b.col).map((c) => cellXml(c.key, c.raw, c.s)).join("");
      return `<row r="${r}">${cells}</row>`;
    })
    .join("");
  const dim = `A1:${colLetters(maxCol)}${maxRow}`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="${NS}" xmlns:r="${R_NS}">` +
    `<dimension ref="${dim}"/>` +
    `<sheetData>${rows}</sheetData>` +
    `</worksheet>`
  );
}

/** Excel sheet-name rules: ≤31 chars, none of []:*?/\, non-empty, unique. */
function sanitizeNames(sheets: SheetData[]): string[] {
  const seen = new Set<string>();
  return sheets.map((sh, i) => {
    const name = (sh.name || `Feuille ${i + 1}`).replace(/[[\]:*?/\\]/g, " ").slice(0, 31).trim() || `Feuille ${i + 1}`;
    let n = name;
    let k = 2;
    while (seen.has(n.toLowerCase())) n = `${name.slice(0, 28)} ${k++}`;
    seen.add(n.toLowerCase());
    return n;
  });
}

export function workbookToXlsx(wb: Workbook): Uint8Array {
  const styles = createStyleTable();
  const names = sanitizeNames(wb.sheets);
  const files: Record<string, Uint8Array> = {};

  // Worksheets (serialize first so the style table is fully populated).
  wb.sheets.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sheet, styles));
  });
  files["xl/styles.xml"] = strToU8(styles.toXml());

  // Workbook + its relationships.
  const sheetTags = names.map((name, i) => `<sheet name="${xe(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  files["xl/workbook.xml"] =
    strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="${NS}" xmlns:r="${R_NS}">` +
        `<sheets>${sheetTags}</sheets>` +
        `<calcPr fullCalcOnLoad="1"/>` +
        `</workbook>`,
    );
  const n = wb.sheets.length;
  const wbRels =
    names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${n + 1}" Type="${REL}/styles" Target="styles.xml"/>`;
  files["xl/_rels/workbook.xml.rels"] =
    strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}s">${wbRels}</Relationships>`);

  // Package relationships + content types.
  files["_rels/.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}s">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  );
  const overrides =
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    wb.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`;
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${CT_NS}">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      overrides +
      `</Types>`,
  );

  return zipSync(files, { level: 6 });
}
