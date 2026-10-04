// @vitest-environment jsdom
// Fidélité XLSX sur des fichiers « tels qu'Excel les écrit » (et non tels que
// notre exporteur les produit) : préfixes _xlfn., booléens/erreurs typés,
// échappements _xHHHH_, texte phonétique, noms définis locaux, date1904…
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { importXlsx } from "../src/sheet/xlsx-import";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function pkg(files: Record<string, string>): Uint8Array {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) out[k] = strToU8(v);
  return zipSync(out, { level: 0 });
}
const WB = (extra = "", pr = "") =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${R}">${pr}<sheets><sheet name="Données" sheetId="1" r:id="rId1"/><sheet name="Calc" sheetId="2" r:id="rId2"/></sheets>${extra}</workbook>`;
const RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;

describe("XLSX réel — typage des cellules", () => {
  const sst = `<sst xmlns="${NS}" count="4" uniqueCount="4">
    <si><t>Nom</t></si>
    <si><r><rPr><b/></rPr><t>Gras</t></r><r><t xml:space="preserve"> suite</t></r></si>
    <si><t>ligne_x000D_fin</t><rPh sb="0" eb="1"><t>ふりがな</t></rPh></si>
    <si><t>_x005F_x000D_ littéral</t></si>
  </sst>`;
  const s1 = `<worksheet xmlns="${NS}"><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>
    <row r="2"><c r="A2" t="b"><v>1</v></c><c r="B2" t="b"><v>0</v></c><c r="C2" t="e"><v>#N/A</v></c><c r="D2"><f>_xlfn.CONCAT(A1,"x")</f><v>Nomx</v></c></row>
    <row r="3"><c r="A3"><f>_xlfn._xlws.FILTER(A1:A2,A1:A2&lt;&gt;"")</f></c><c r="B3"><f>_xlfn.IFS(A2,1,TRUE,2)</f><v>1</v></c><c r="C3"><f>_xlfn.XLOOKUP(1,A1:A2,B1:B2)</f><v>0</v></c></row>
    <row r="4"><c r="A4" t="inlineStr"><is><t>inline</t></is></c><c r="B4" t="str"><f>"a"&amp;"b"</f><v>ab</v></c></row>
  </sheetData></worksheet>`;
  const s2 = `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1"><v>5</v></c></row></sheetData></worksheet>`;
  const wb = importXlsx(
    pkg({
      "xl/workbook.xml": WB(),
      "xl/_rels/workbook.xml.rels": RELS,
      "xl/sharedStrings.xml": sst,
      "xl/worksheets/sheet1.xml": s1,
      "xl/worksheets/sheet2.xml": s2,
    }),
  );
  const c = wb.sheets[0]!.cells;
  it("texte riche : concatène les runs sans le texte phonétique", () => {
    expect(c.B1).toBe("Gras suite");
    expect(c.C1).toBe("ligne\rfin");
  });
  it("décode les échappements _xHHHH_ (et _x005F_)", () => {
    expect(c.D1).toBe("_x000D_ littéral");
  });
  it("booléens et erreurs typés", () => {
    expect(c.A2).toBe("TRUE");
    expect(c.B2).toBe("FALSE");
    expect(c.C2).toBe("#N/A");
  });
  it("retire les préfixes _xlfn. / _xlws. des fonctions", () => {
    expect(c.D2).toBe('=CONCAT(A1,"x")');
    expect(c.A3).toBe('=FILTER(A1:A2,A1:A2<>"")');
    expect(c.B3).toBe("=IFS(A2,1,TRUE,2)");
    expect(c.C3).toBe("=XLOOKUP(1,A1:A2,B1:B2)");
  });
  it("chaînes en ligne et formules de type str", () => {
    expect(c.A4).toBe("inline");
    expect(c.B4).toBe('="a"&"b"');
  });
});

describe("XLSX réel — classeur", () => {
  const s = `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1"><v>44927</v></c></row></sheetData></worksheet>`;
  it("noms définis : ignore les noms locaux qui feraient doublon, garde les globaux", () => {
    const extra = `<definedNames>
      <definedName name="_xlnm.Print_Area" localSheetId="0">Données!$A$1:$C$5</definedName>
      <definedName name="Taux" localSheetId="1">Calc!$A$1</definedName>
      <definedName name="Taux">Données!$A$1</definedName>
      <definedName name="Plage">Données!$A$1:$B$2</definedName>
      <definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Données!$A$1:$B$2</definedName>
    </definedNames>`;
    const wb = importXlsx(
      pkg({
        "xl/workbook.xml": WB(extra),
        "xl/_rels/workbook.xml.rels": RELS,
        "xl/worksheets/sheet1.xml": s,
        "xl/worksheets/sheet2.xml": s,
      }),
    );
    const names = wb.names ?? [];
    expect(names.filter((n) => n.name === "Taux")).toEqual([{ name: "Taux", ref: "Données!$A$1" }]);
    expect(names.some((n) => n.name === "Plage")).toBe(true);
    expect(names.some((n) => n.name.startsWith("_xlnm"))).toBe(false);
  });
  it("date1904 : décale les séries de date vers la base 1900", () => {
    const styles = `<styleSheet xmlns="${NS}"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`;
    const sh = `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" s="1"><v>0</v></c><c r="B1"><v>5</v></c></row></sheetData></worksheet>`;
    const wb = importXlsx(
      pkg({
        "xl/workbook.xml": WB("", `<workbookPr date1904="1"/>`),
        "xl/_rels/workbook.xml.rels": RELS,
        "xl/styles.xml": styles,
        "xl/worksheets/sheet1.xml": sh,
        "xl/worksheets/sheet2.xml": s,
      }),
    );
    // base 1904 : 0 = 1904-01-01 = série 1462 en base 1900 ; les non-dates restent intactes
    expect(wb.sheets[0]!.cells.A1).toBe("1462");
    expect(wb.sheets[0]!.cells.B1).toBe("5");
  });
});
