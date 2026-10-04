// @vitest-environment jsdom
// Tableaux nommés dans XLSX : fichier « tel qu'Excel l'écrit » (xl/tables, [#This Row]) et aller-retour.
import { describe, it, expect } from "vitest";
import { zipSync, strToU8, unzipSync, strFromU8 } from "fflate";
import { importXlsx } from "../src/sheet/xlsx-import";
import { workbookToXlsx } from "../src/sheet/xlsx-export";
import { createCalc } from "../src/sheet/formula";
import { tableDefs } from "../src/sheet/tables";
import { prefixNewFunctions } from "../src/sheet/xlsx-formula";
import type { Workbook } from "../src/sheet/model";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function excelFile(): Uint8Array {
  const f: Record<string, string> = {
    "xl/workbook.xml": `<workbook xmlns="${NS}" xmlns:r="${R}"><sheets><sheet name="Ventes" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="${NS}" xmlns:r="${R}"><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Produit</t></is></c><c r="B1" t="inlineStr"><is><t>Prix</t></is></c><c r="C1" t="inlineStr"><is><t>Qté</t></is></c><c r="D1" t="inlineStr"><is><t>Total</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>Pomme</t></is></c><c r="B2"><v>2</v></c><c r="C2"><v>10</v></c><c r="D2"><f>Tableau1[[#This Row],[Prix]]*Tableau1[[#This Row],[Qté]]</f><v>20</v></c></row>
      <row r="3"><c r="A3" t="inlineStr"><is><t>Poire</t></is></c><c r="B3"><v>3</v></c><c r="C3"><v>4</v></c><c r="D3"><f>Tableau1[[#This Row],[Prix]]*Tableau1[[#This Row],[Qté]]</f><v>12</v></c></row>
      <row r="4"><c r="A4" t="inlineStr"><is><t>Total</t></is></c><c r="D4"><f>SUBTOTAL(109,Tableau1[Total])</f><v>32</v></c></row>
    </sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>`,
    "xl/worksheets/_rels/sheet1.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/table" Target="../tables/table1.xml"/></Relationships>`,
    "xl/tables/table1.xml": `<table xmlns="${NS}" id="1" name="Tableau1" displayName="Tableau1" ref="A1:D4" totalsRowCount="1"><autoFilter ref="A1:D3"/><tableColumns count="4"><tableColumn id="1" name="Produit"/><tableColumn id="2" name="Prix"/><tableColumn id="3" name="Qté"/><tableColumn id="4" name="Total"/></tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`,
  };
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(f)) out[k] = strToU8(v);
  return zipSync(out, { level: 0 });
}

describe("XLSX réel — tableaux nommés", () => {
  const wb = importXlsx(excelFile());
  const sh = wb.sheets[0]!;
  it("lit le tableau (nom, plage, totaux, bandes)", () => {
    expect(sh.tables).toHaveLength(1);
    expect(sh.tables![0]).toMatchObject({ name: "Tableau1", c0: 0, r0: 0, c1: 3, r1: 3, totals: true, banded: true });
  });
  it("les références structurées [#This Row] se calculent", () => {
    const c = createCalc((r) => sh.cells[r], undefined, undefined, undefined, {
      tables: tableDefs(wb.sheets),
      sheet: sh.name,
    });
    expect(c.valueOf("D2")).toBe(20);
    expect(c.valueOf("D3")).toBe(12);
  });
});

describe("XLSX — aller-retour des tableaux et formules récentes", () => {
  const wb: Workbook = {
    active: 0,
    sheets: [
      {
        name: "S",
        rows: 6,
        cols: 4,
        cells: {
          A1: "Nom",
          B1: "Prix",
          A2: "x",
          B2: "5",
          A3: "y",
          B3: "7",
          D1: "=Tab[@Prix]",
          D2: "=SUM(Tab[Prix])",
          D3: "=XLOOKUP(1,A1:A2,B1:B2)",
          D4: "=FILTER(A2:B3,B2:B3>5)",
        },
        tables: [{ id: "t1", name: "Tab", c0: 0, r0: 0, c1: 1, r1: 2, banded: false }],
      },
    ],
  };
  const bytes = workbookToXlsx(wb);
  it("écrit une vraie partie de tableau, relation et type de contenu", () => {
    const zip = unzipSync(bytes);
    const t = strFromU8(zip["xl/tables/table1.xml"]!);
    expect(t).toContain('name="Tab"');
    expect(t).toContain('ref="A1:B3"');
    expect(t).toContain('showRowStripes="0"');
    expect(strFromU8(zip["xl/worksheets/_rels/sheet1.xml.rels"]!)).toContain("../tables/table1.xml");
    expect(strFromU8(zip["[Content_Types].xml"]!)).toContain("/xl/tables/table1.xml");
    expect(strFromU8(zip["xl/worksheets/sheet1.xml"]!)).toContain("<tablePart ");
  });
  it("[@Col] est écrit [#This Row] et les fonctions récentes sont préfixées", () => {
    const xml = strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]!);
    expect(xml).toContain("Tab[[#This Row],[Prix]]");
    expect(xml).toContain("_xlfn.XLOOKUP(");
    expect(xml).toContain("_xlfn._xlws.FILTER(");
  });
  it("réimport : tableau conservé, formules rendues sans préfixe", () => {
    const back = importXlsx(bytes).sheets[0]!;
    expect(back.tables![0]).toMatchObject({ name: "Tab", c0: 0, r1: 2, banded: false });
    expect(back.cells.D3).toBe("=XLOOKUP(1,A1:A2,B1:B2)");
    expect(back.cells.D4).toBe("=FILTER(A2:B3,B2:B3>5)");
    expect(back.cells.D1).toBe("=Tab[[#This Row],[Prix]]"); // forme fichier, évaluée de la même façon
  });
  it("préfixage : chaînes intactes, fonctions déjà courantes inchangées", () => {
    expect(prefixNewFunctions('=CONCAT("XLOOKUP(",A1)'.slice(1))).toBe('_xlfn.CONCAT("XLOOKUP(",A1)');
    expect(prefixNewFunctions("SUM(A1:A3)")).toBe("SUM(A1:A3)");
    expect(prefixNewFunctions("MYXLOOKUP(1)")).toBe("MYXLOOKUP(1)");
  });
});
