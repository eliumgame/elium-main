// @vitest-environment jsdom
// Import XLSX en flux (Worker) : mêmes résultats que l'import DOM, plages, plafonds.
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { importXlsx, importXlsxAsync } from "../src/sheet/xlsx-import";
import { workbookToXlsx } from "../src/sheet/xlsx-export";
import type { Workbook } from "../src/sheet/model";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const pkg = (files: Record<string, string>, level: 0 | 6 = 6): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), { level });
const WB1 = `<workbook xmlns="${NS}" xmlns:r="${R}"><sheets><sheet name="Données" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const RELS1 = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
const one = (sheet: string, extra: Record<string, string> = {}, level: 0 | 6 = 6) =>
  pkg(
    { "xl/workbook.xml": WB1, "xl/_rels/workbook.xml.rels": RELS1, "xl/worksheets/sheet1.xml": sheet, ...extra },
    level,
  );

const strip = (wb: Workbook) => JSON.parse(JSON.stringify(wb, (k, v) => (k === "id" ? undefined : v)));

describe("import en flux ≡ import DOM", () => {
  it("aller-retour de l'exporteur (styles, fusions, graphiques, validations…)", async () => {
    const wb: Workbook = {
      active: 0,
      sheets: [
        {
          name: "A",
          rows: 6,
          cols: 4,
          cells: { A1: "Nom", B1: "12.5", C1: "=B1*2", A2: "a & <b>", B2: "2026-01-02", D4: "x" },
          styles: { A1: { bold: true, fill: "#ffcc00" }, B1: { fmt: "percent" }, B2: { fmt: "date" } },
          merges: [{ c0: 0, r0: 2, c1: 1, r1: 2 }],
          colWidths: { 1: 150 },
          rowHeights: { 1: 40 },
          freeze: { rows: 1, cols: 0 },
          validations: [{ id: "v", c0: 0, r0: 1, c1: 0, r1: 3, type: "list", list: ["Oui", "Non"] }],
          charts: [{ id: "c", type: "bar", c0: 0, r0: 0, c1: 1, r1: 3 }],
          notes: { A1: "note" },
        },
        { name: "B", rows: 3, cols: 3, cells: { A1: "1", B2: "texte" } },
      ],
    };
    const bytes = workbookToXlsx(wb);
    const dom = importXlsx(bytes);
    const { workbook, sheets } = await importXlsxAsync(bytes, { inline: true });
    expect(strip(workbook)).toEqual(strip(dom));
    expect(sheets.every((s) => !s.truncated)).toBe(true);
  });

  it("fichier « à la Excel » : chaînes partagées, formules partagées, types, échappements, entités", async () => {
    const sst = `<sst xmlns="${NS}"><si><t>Nom</t></si><si><r><t>Gras</t></r><r><t xml:space="preserve"> suite</t></r></si><si><t>a_x000D_b</t><rPh><t>x</t></rPh></si><si><t>R&amp;D &lt;1&gt;</t></si></sst>`;
    const sheet = `<?xml version="1.0"?><worksheet xmlns="${NS}"><dimension ref="A1:D5"/><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>
      <row r="2"><c r="A2" t="b"><v>1</v></c><c r="B2" t="e"><v>#N/A</v></c><c r="C2"><f t="shared" ref="C2:C4" si="0">_xlfn.CONCAT(A2,$B$1)</f><v>x</v></c><c r="D2" t="inlineStr"><is><t>in&amp;line</t></is></c></row>
      <row r="3"><c r="C3"><f t="shared" si="0"/><v>0</v></c><c r="D3" t="str"><f>"a"&amp;"b"</f><v>ab</v></c></row>
      <row r="4"><c r="C4"><f t="shared" si="0"/></c><c r="A4"><v>45000</v></c><c r="B4" s="0"/></row>
      <row r="5"/>
    </sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>`;
    const bytes = one(sheet, { "xl/sharedStrings.xml": sst });
    const dom = importXlsx(bytes);
    const { workbook } = await importXlsxAsync(bytes, { inline: true });
    expect(strip(workbook)).toEqual(strip(dom));
    expect(workbook.sheets[0]!.cells.C3).toBe("=CONCAT(A3,$B$1)");
    expect(workbook.sheets[0]!.cells.C1).toBe("a\rb");
    expect(workbook.sheets[0]!.cells.D1).toBe("R&D <1>");
  });

  it("date1904 : même décalage que l'import DOM", async () => {
    const styles = `<styleSheet xmlns="${NS}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;
    const wb = `<workbook xmlns="${NS}" xmlns:r="${R}"><workbookPr date1904="1"/><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const bytes = pkg({
      "xl/workbook.xml": wb,
      "xl/_rels/workbook.xml.rels": RELS1,
      "xl/styles.xml": styles,
      "xl/worksheets/sheet1.xml": `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" s="1"><v>100</v></c></row></sheetData></worksheet>`,
    });
    const a = importXlsx(bytes).sheets[0]!.cells.A1;
    const b = (await importXlsxAsync(bytes, { inline: true })).workbook.sheets[0]!.cells.A1;
    expect(b).toBe(a);
    expect(b).toBe("1562");
  });
});

function bigSheet(rows: number, cols = 3): string {
  let body = "";
  for (let r = 1; r <= rows; r++) {
    let cells = "";
    for (let c = 0; c < cols; c++) cells += `<c r="${String.fromCharCode(65 + c)}${r}"><v>${r * 10 + c}</v></c>`;
    body += `<row r="${r}"${r === 7 ? ' ht="30" customHeight="1"' : ""}>${cells}</row>`;
  }
  return `<worksheet xmlns="${NS}"><dimension ref="A1:C${rows}"/><sheetData>${body}</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>`;
}

describe("feuilles volumineuses", () => {
  const bytes = one(bigSheet(2000));

  it("plage de lignes + en-tête conservé", async () => {
    const { workbook, sheets } = await importXlsxAsync(bytes, {
      inline: true,
      windows: { "xl/worksheets/sheet1.xml": { rowStart: 1000, rowEnd: 1009, keepHeader: true } },
    });
    const c = workbook.sheets[0]!.cells;
    expect(c.A1).toBe("10"); // en-tête (ligne 1)
    expect(c.A2).toBe("10000"); // ligne 1000
    expect(c.C11).toBe("10092"); // ligne 1009
    expect(c.A12).toBeUndefined();
    expect(workbook.sheets[0]!.rows).toBe(20); // plancher de 20 lignes, comme l'import DOM
    expect(c.A11).toBe("10090");
    expect(sheets[0]).toMatchObject({ truncated: true, firstRow: 1000, lastRow: 1009, totalRows: 2000 });
  });

  it("hauteur de ligne et plage sans en-tête", async () => {
    const { workbook } = await importXlsxAsync(bytes, {
      inline: true,
      windows: { "xl/worksheets/sheet1.xml": { rowStart: 5, rowEnd: 8 } },
    });
    expect(workbook.sheets[0]!.cells.A1).toBe("50");
    expect(workbook.sheets[0]!.rowHeights).toEqual({ 2: 40 }); // ligne 7 → index 2
  });

  it("feuille ignorée : présente mais vide", async () => {
    const { workbook, sheets } = await importXlsxAsync(bytes, {
      inline: true,
      windows: { "xl/worksheets/sheet1.xml": { skip: true } },
    });
    expect(workbook.sheets[0]!.cells).toEqual({});
    expect(sheets[0]!.skipped).toBe(true);
  });

  it("plafond atteint sur une grosse feuille : tronquée, tail ignorée", async () => {
    const big = one(bigSheet(30_000, 4)); // 120 000 cellules > 50 000
    const { workbook, sheets } = await importXlsxAsync(big, {
      inline: true,
      maxCellsPerSheet: 50_000,
      maxCellsTotal: 50_000,
    });
    expect(sheets[0]!.truncated).toBe(true);
    expect(Object.keys(workbook.sheets[0]!.cells).length).toBeLessThanOrEqual(50_000 + 8);
    expect(sheets[0]!.lastRow).toBeLessThan(30_000);
    expect(workbook.sheets[0]!.merges).toBeUndefined();
  });

  it("annulation avant démarrage", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(importXlsxAsync(bytes, { inline: true, signal: ctl.signal })).rejects.toThrow();
  });

  it("flux découpé en blocs minuscules (balises à cheval sur les blocs)", async () => {
    const stored = one(bigSheet(300), {}, 0);
    const { workbook } = await importXlsxAsync(stored, { inline: true });
    expect(workbook.sheets[0]!.cells.C300).toBe("3002");
    expect(workbook.sheets[0]!.merges).toEqual([{ c0: 0, c1: 1, r0: 0, r1: 0 }]);
  });
});
