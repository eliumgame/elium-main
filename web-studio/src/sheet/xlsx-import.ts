/**
 * Minimal XLSX (SpreadsheetML) importer — no new dependency.
 * Unzips with fflate (already used by the DOCX module) and parses the XML with
 * the browser DOMParser. Reads shared strings, cell values and formulas across
 * all worksheets. Number formats/styles are not interpreted (v1).
 */
import { unzipSync, strFromU8 } from "fflate";
import { parseRef } from "./formula";
import { emptySheet, type SheetData, type Workbook } from "./model";

function parseXml(bytes: Uint8Array | undefined): Document | null {
  if (!bytes) return null;
  return new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
}

function textOf(el: Element): string {
  // Concatenate every <t> descendant (handles rich-text runs); else textContent.
  const ts = el.getElementsByTagName("t");
  if (ts.length) {
    let s = "";
    for (let i = 0; i < ts.length; i++) s += ts[i].textContent ?? "";
    return s;
  }
  return el.textContent ?? "";
}

function parseSharedStrings(zip: Record<string, Uint8Array>): string[] {
  const doc = parseXml(zip["xl/sharedStrings.xml"]);
  if (!doc) return [];
  const out: string[] = [];
  const sis = doc.getElementsByTagName("si");
  for (let i = 0; i < sis.length; i++) out.push(textOf(sis[i]));
  return out;
}

function relTargets(zip: Record<string, Uint8Array>): Record<string, string> {
  const doc = parseXml(zip["xl/_rels/workbook.xml.rels"]);
  const map: Record<string, string> = {};
  if (!doc) return map;
  const rels = doc.getElementsByTagName("Relationship");
  for (let i = 0; i < rels.length; i++) {
    const id = rels[i].getAttribute("Id");
    const target = rels[i].getAttribute("Target");
    if (id && target) map[id] = target.replace(/^\//, "");
  }
  return map;
}

function parseSheet(doc: Document | null, shared: string[], name: string): SheetData {
  const sh = emptySheet(name);
  if (!doc) return sh;
  let maxCol = 7;
  let maxRow = 19;
  const cells = doc.getElementsByTagName("c");
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const ref = c.getAttribute("r");
    if (!ref) continue;
    const pos = parseRef(ref.toUpperCase());
    if (pos) {
      maxCol = Math.max(maxCol, pos.col);
      maxRow = Math.max(maxRow, pos.row);
    }
    const f = c.getElementsByTagName("f")[0];
    if (f && f.textContent) {
      sh.cells[ref.toUpperCase()] = "=" + f.textContent;
      continue;
    }
    const v = c.getElementsByTagName("v")[0];
    if (!v || v.textContent == null) continue;
    const t = c.getAttribute("t");
    if (t === "s") {
      const idx = parseInt(v.textContent, 10);
      sh.cells[ref.toUpperCase()] = shared[idx] ?? "";
    } else if (t === "str" || t === "inlineStr") {
      sh.cells[ref.toUpperCase()] = textOf(c);
    } else {
      sh.cells[ref.toUpperCase()] = v.textContent;
    }
  }
  sh.cols = maxCol + 1;
  sh.rows = maxRow + 1;
  return sh;
}

export function importXlsx(bytes: Uint8Array): Workbook {
  const zip = unzipSync(bytes);
  const shared = parseSharedStrings(zip);
  const rels = relTargets(zip);
  const wb = parseXml(zip["xl/workbook.xml"]);

  const sheets: SheetData[] = [];
  if (wb) {
    const sheetEls = wb.getElementsByTagName("sheet");
    for (let i = 0; i < sheetEls.length; i++) {
      const name = sheetEls[i].getAttribute("name") || `Feuille ${i + 1}`;
      const rid = sheetEls[i].getAttribute("r:id") || sheetEls[i].getAttribute("id");
      const target = rid ? rels[rid] : undefined;
      const path = target ? `xl/${target}` : `xl/worksheets/sheet${i + 1}.xml`;
      sheets.push(parseSheet(parseXml(zip[path]), shared, name));
    }
  }
  // Fallback: no workbook.xml mapping — read sheet files directly.
  if (sheets.length === 0) {
    const names = Object.keys(zip)
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort();
    names.forEach((k, i) => sheets.push(parseSheet(parseXml(zip[k]), shared, `Feuille ${i + 1}`)));
  }
  if (sheets.length === 0) sheets.push(emptySheet("Feuille 1"));
  return { sheets, active: 0 };
}
