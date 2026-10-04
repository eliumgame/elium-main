// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8, zipSync, strToU8 } from "fflate";
import { workbookToXlsx } from "../src/sheet/xlsx-export";
import { importXlsx } from "../src/sheet/xlsx-import";
import { hfFromExcel, hfToExcel } from "../src/sheet/xlsx-print";
import { normalizePrint } from "../src/sheet/print";
import type { Workbook } from "../src/sheet/model";

const wbWith = (print: Parameters<typeof normalizePrint>[0]): Workbook => ({
  active: 0,
  sheets: [{ name: "Rapport 1", rows: 40, cols: 6, cells: { A1: "Titre", B2: "x" }, print: normalizePrint(print) }],
});

describe("impression — XLSX", () => {
  const full = {
    orientation: "landscape" as const,
    paper: "A3" as const,
    margins: { top: 20, right: 10, bottom: 20, left: 10 },
    fitWidth: true,
    area: { c0: 0, r0: 0, c1: 3, r1: 29 },
    repeatRows: { r0: 0, r1: 1 },
    repeatCols: { c0: 0, c1: 0 },
    rowBreaks: [9, 19],
    colBreaks: [1],
    gridlines: true,
    headings: true,
    header: "{feuille}",
    footer: "Page {page} sur {pages}",
    order: "over" as const,
  };
  const bytes = workbookToXlsx(wbWith(full));
  it("écrit les éléments OOXML attendus", () => {
    const zip = unzipSync(bytes);
    const sheet = strFromU8(zip["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain('<pageSetUpPr fitToPage="1"/>');
    expect(sheet).toContain('<printOptions headings="1" gridLines="1"/>');
    expect(sheet).toContain(
      'paperSize="8" orientation="landscape" fitToWidth="1" fitToHeight="0" pageOrder="overThenDown"',
    );
    expect(sheet).toContain('<brk id="10" max="16383" man="1"/>');
    expect(sheet).toContain("<oddFooter>&amp;CPage &amp;P sur &amp;N</oddFooter>");
    const wb = strFromU8(zip["xl/workbook.xml"]!);
    expect(wb).toContain(
      '<definedName name="_xlnm.Print_Area" localSheetId="0">\'Rapport 1\'!$A$1:$D$30</definedName>',
    );
    expect(wb).toContain("_xlnm.Print_Titles");
    expect(wb).toContain(
      "'Rapport 1'!$A:$A,'Rapport 1'!$1:$2".replace("$A:$A,'Rapport 1'!$1:$2", "$A:$A,'Rapport 1'!$1:$2"),
    );
  });
  it("aller-retour complet", () => {
    const back = importXlsx(bytes).sheets[0]!.print!;
    expect(back).toMatchObject({
      orientation: "landscape",
      paper: "A3",
      fitWidth: true,
      area: full.area,
      repeatRows: full.repeatRows,
      repeatCols: full.repeatCols,
      rowBreaks: [9, 19],
      colBreaks: [1],
      gridlines: true,
      headings: true,
      header: "{feuille}",
      footer: "Page {page} sur {pages}",
      order: "over",
    });
    expect(Math.round(back.margins.top)).toBe(20);
    expect(Math.round(back.margins.left)).toBe(10);
  });
  it("une feuille sans réglage d'impression reste sans objet print", () => {
    const plain: Workbook = { active: 0, sheets: [{ name: "S", rows: 3, cols: 2, cells: { A1: "1" } }] };
    expect(importXlsx(workbookToXlsx(plain)).sheets[0]!.print).toBeUndefined();
  });
  it("fichier Excel réel : pageSetup, titres, zone et sections d'en-tête/pied (&L &C &R)", () => {
    const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const files: Record<string, string> = {
      "xl/workbook.xml": `<workbook xmlns="${NS}" xmlns:r="${R}"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">A!$B$2:$E$20</definedName><definedName name="_xlnm.Print_Titles" localSheetId="0">A!$1:$1</definedName></definedNames></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup paperSize="9" scale="85" orientation="portrait"/><headerFooter><oddHeader>&amp;L&amp;D&amp;CRapport mensuel&amp;RConfidentiel</oddHeader><oddFooter>&amp;C&amp;P / &amp;N</oddFooter></headerFooter></worksheet>`,
    };
    const out: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(files)) out[k] = strToU8(v);
    const p = importXlsx(zipSync(out, { level: 0 })).sheets[0]!.print!;
    expect(p.paper).toBe("A4");
    expect(p.scale).toBe(85);
    expect(p.area).toEqual({ c0: 1, r0: 1, c1: 4, r1: 19 });
    expect(p.repeatRows).toEqual({ r0: 0, r1: 0 });
    expect(p.header).toBe("Rapport mensuel");
    expect(p.footer).toBe("{page} / {pages}");
    expect(Math.round(p.margins.left)).toBe(18);
  });
  it("codes d'en-tête : & littéral doublé", () => {
    expect(hfToExcel("A & B {page}")).toBe("A && B &P");
    expect(hfFromExcel("&CA && B &P")).toBe("A & B {page}");
  });
});
