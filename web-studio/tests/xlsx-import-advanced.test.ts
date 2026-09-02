// @vitest-environment jsdom
// Import-only fidelity: files as REAL Excel writes them, not as our own
// exporter would (xlsx-export.ts never emits shared formulas or theme
// colours), so these build minimal hand-written OPC packages directly.
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { importXlsx } from "../src/sheet/xlsx-import";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = R_NS;

/** Minimal OPC package: just the parts importXlsx actually reads. */
function buildXlsx(parts: {
  workbook?: string;
  workbookRels?: string;
  sheet1: string;
  styles?: string;
  theme?: string;
  sharedStrings?: string;
}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "xl/workbook.xml": strToU8(
      parts.workbook ??
        `<workbook xmlns="${NS}" xmlns:r="${R_NS}"><sheets><sheet name="Feuille" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      parts.workbookRels ??
        `<?xml version="1.0"?><Relationships xmlns="${REL}s"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(parts.sheet1),
  };
  if (parts.styles) files["xl/styles.xml"] = strToU8(parts.styles);
  if (parts.theme) files["xl/theme/theme1.xml"] = strToU8(parts.theme);
  if (parts.sharedStrings) files["xl/sharedStrings.xml"] = strToU8(parts.sharedStrings);
  return zipSync(files, { level: 0 });
}

describe("XLSX import — shared formulas (t=\"shared\")", () => {
  it("re-derives follower formulas from the master by shifting references", () => {
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData>
      <row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2</f><v>2</v></c></row>
      <row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>4</v></c></row>
      <row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>6</v></c></row>
    </sheetData></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1 }));
    const sh = wb.sheets[0]!;
    expect(sh.cells.B1).toBe("=A1*2");
    expect(sh.cells.B2).toBe("=A2*2");
    expect(sh.cells.B3).toBe("=A3*2");
  });

  it("keeps $-anchored references fixed while shifting relative ones (Excel fill semantics)", () => {
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData>
      <row r="1"><c r="A1"><v>10</v></c><c r="C1"><f t="shared" ref="C1:C2" si="7">A1+$A$5</f><v>0</v></c></row>
      <row r="2"><c r="A2"><v>20</v></c><c r="C2"><f t="shared" si="7"/><v>0</v></c></row>
    </sheetData></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1 }));
    const sh = wb.sheets[0]!;
    expect(sh.cells.C1).toBe("=A1+$A$5");
    expect(sh.cells.C2).toBe("=A2+$A$5"); // A5 anchored: untouched; A1 relative: shifts to A2
  });

  it("a normal (non-shared) formula is unaffected", () => {
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData>
      <row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row>
    </sheetData></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1 }));
    expect(wb.sheets[0]!.cells.A1).toBe("=1+1");
  });

  // Régression critique : Excel autorise de tirer une formule vers le HAUT ou vers
  // la GAUCHE ("Remplissage > Haut"/"Remplissage > Gauche"), pas seulement vers le
  // bas/la droite. La cellule "maître" (celle qui porte le texte de la formule dans
  // le XML) peut alors être PLUS ÉLOIGNÉE de la référence que ses suiveurs, ce qui
  // rend le décalage col/row négatif. Avant le correctif, ce décalage négatif était
  // silencieusement encodé comme une référence syntaxiquement valide mais fausse
  // (ex. "=A-3*2" au lieu d'une ligne 1 tirée vers le haut) : une corruption
  // silencieuse des données, sans #REF! ni erreur visible.
  it("a shared-formula group filled UPWARD (master below its followers) turns the out-of-range ref into #REF!, not a bogus negative one", () => {
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData>
      <row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" si="0"/><v>0</v></c></row>
      <row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>0</v></c></row>
      <row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>0</v></c></row>
      <row r="4"><c r="A4"><v>4</v></c><c r="B4"><f t="shared" si="0"/><v>0</v></c></row>
      <row r="5"><c r="A5"><v>5</v></c><c r="B5"><f t="shared" ref="B1:B5" si="0">A1*2</f><v>10</v></c></row>
    </sheetData></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1 }));
    const sh = wb.sheets[0]!;
    expect(sh.cells.B5).toBe("=A1*2"); // le maître : inchangé
    // Chaque suiveur référence une ligne au-dessus de la ligne 1 : #REF!, jamais
    // "=A-3*2" / "=A-2*2" / … (des formules syntaxiquement plausibles mais fausses).
    expect(sh.cells.B1).toBe("=#REF!*2");
    expect(sh.cells.B2).toBe("=#REF!*2");
    expect(sh.cells.B3).toBe("=#REF!*2");
    expect(sh.cells.B4).toBe("=#REF!*2");
  });

  it("a shared-formula group filled LEFTWARD (master to the right of its followers) turns the out-of-range ref into #REF!", () => {
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData>
      <row r="1">
        <c r="A1"><f t="shared" si="1"/><v>0</v></c>
        <c r="B1"><f t="shared" si="1"/><v>0</v></c>
        <c r="C1"><f t="shared" si="1"/><v>0</v></c>
        <c r="D1"><f t="shared" ref="A1:D1" si="1">A2*2</f><v>10</v></c>
      </row>
      <row r="2"><c r="A2"><v>5</v></c></row>
    </sheetData></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1 }));
    const sh = wb.sheets[0]!;
    expect(sh.cells.D1).toBe("=A2*2"); // le maître : inchangé
    // Chaque suiveur référence une colonne avant la colonne A : #REF!, pas une
    // colonne négative encodée en chaîne vide (indexToCol(-1) === "").
    expect(sh.cells.A1).toBe("=#REF!*2");
    expect(sh.cells.B1).toBe("=#REF!*2");
    expect(sh.cells.C1).toBe("=#REF!*2");
  });
});

describe("XLSX import — theme colours (color theme=\"N\" tint=\"…\")", () => {
  const theme = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">
    <a:themeElements><a:clrScheme name="Office">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="44546A"/></a:dk2>
      <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
      <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
      <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
      <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme></a:themeElements>
  </a:theme>`;

  it("a bare theme reference (tint=0) resolves to the exact scheme colour", () => {
    const styles = `<styleSheet xmlns="${NS}">
      <fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
      <font><sz val="11"/><color theme="4"/><name val="Calibri"/></font></fonts>
      <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
      <borders count="1"><border/></borders>
      <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
      <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
    </styleSheet>`;
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" s="1"><v>1</v></c></row></sheetData></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1, styles, theme }));
    // theme index 4 = accent1 in the UI-index order = "4472C4"
    expect(wb.sheets[0]!.styles?.A1?.color).toBe("#4472c4");
  });

  it("a tinted theme reference lightens/darkens instead of being dropped", () => {
    const styles = `<styleSheet xmlns="${NS}">
      <fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font></fonts>
      <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
      <fill><patternFill patternType="solid"><fgColor theme="4" tint="0.6"/><bgColor indexed="64"/></patternFill></fill></fills>
      <borders count="1"><border/></borders>
      <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
      <xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/></cellXfs>
    </styleSheet>`;
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" s="1"><v>1</v></c></row></sheetData></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1, styles, theme }));
    const fill = wb.sheets[0]!.styles?.A1?.fill;
    expect(fill).toBeDefined();
    expect(fill).not.toBe("#4472c4"); // tint actually applied, not just the raw base colour
    expect(fill).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("a plain literal rgb colour still works exactly as before (no regression)", () => {
    const styles = `<styleSheet xmlns="${NS}">
      <fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
      <font><sz val="11"/><color rgb="FFAB1234"/><name val="Calibri"/></font></fonts>
      <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
      <borders count="1"><border/></borders>
      <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
      <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
    </styleSheet>`;
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" s="1"><v>1</v></c></row></sheetData></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1, styles }));
    expect(wb.sheets[0]!.styles?.A1?.color).toBe("#ab1234");
  });
});

describe("XLSX import — data validation list referencing a cell range", () => {
  it("resolves an unquoted range reference (formula1) against the sheet's own cells", () => {
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData>
      <row r="1"><c r="D1" t="inlineStr"><is><t>Café</t></is></c></row>
      <row r="2"><c r="D2" t="inlineStr"><is><t>Thé</t></is></c></row>
      <row r="3"><c r="D3" t="inlineStr"><is><t>Chocolat</t></is></c></row>
      <row r="5"><c r="A5"/></row>
    </sheetData>
    <dataValidations count="1">
      <dataValidation type="list" allowBlank="1" sqref="A5"><formula1>$D$1:$D$3</formula1></dataValidation>
    </dataValidations></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1 }));
    const v = wb.sheets[0]!.validations?.[0];
    expect(v?.type).toBe("list");
    expect(v?.list).toEqual(["Café", "Thé", "Chocolat"]);
  });

  it("a quoted literal list still works exactly as before (no regression)", () => {
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1"/></row></sheetData>
    <dataValidations count="1">
      <dataValidation type="list" allowBlank="1" sqref="A1"><formula1>"Oui,Non"</formula1></dataValidation>
    </dataValidations></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1 }));
    expect(wb.sheets[0]!.validations?.[0]?.list).toEqual(["Oui", "Non"]);
  });

  it("an unresolvable cross-sheet range reference is skipped, not crashed on", () => {
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1"/></row></sheetData>
    <dataValidations count="1">
      <dataValidation type="list" allowBlank="1" sqref="A1"><formula1>'Autre Feuille'!$A$1:$A$3</formula1></dataValidation>
    </dataValidations></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1 }));
    expect(wb.sheets[0]!.validations ?? []).toHaveLength(0);
  });
});

describe("XLSX import — custom number formats", () => {
  it("a format code fitting none of our fixed categories is preserved as custom, not dropped", () => {
    const styles = `<styleSheet xmlns="${NS}">
      <numFmts count="1"><numFmt numFmtId="164" formatCode="mm:ss"/></numFmts>
      <fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font></fonts>
      <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
      <borders count="1"><border/></borders>
      <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
      <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
    </styleSheet>`;
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" s="1"><v>90</v></c></row></sheetData></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1, styles }));
    const st = wb.sheets[0]!.styles?.A1;
    expect(st?.fmt).toBe("custom");
    expect(st?.customFmt).toBe("mm:ss");
  });
});

describe("XLSX import — cell comments (notes)", () => {
  it("reads xl/commentsN.xml via the worksheet's own .rels, alongside an (ignored) VML rel", () => {
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>
      <legacyDrawing r:id="rId2"/></worksheet>`;
    const sheetRels = `<?xml version="1.0"?><Relationships xmlns="${REL}s">
      <Relationship Id="rId1" Type="${REL}/comments" Target="../comments1.xml"/>
      <Relationship Id="rId2" Type="${REL}/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/>
    </Relationships>`;
    const comments1 = `<comments xmlns="${NS}"><authors><author>Auteur</author></authors>
      <commentList><comment ref="A1" authorId="0"><text><t>Vérifier ce total.</t></text></comment></commentList>
    </comments>`;
    const zip: Record<string, Uint8Array> = {
      "xl/workbook.xml": strToU8(
        `<workbook xmlns="${NS}" xmlns:r="${R_NS}"><sheets><sheet name="Feuille" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        `<?xml version="1.0"?><Relationships xmlns="${REL}s"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ),
      "xl/worksheets/sheet1.xml": strToU8(sheet1),
      "xl/worksheets/_rels/sheet1.xml.rels": strToU8(sheetRels),
      "xl/comments1.xml": strToU8(comments1),
    };
    const wb = importXlsx(zipSync(zip, { level: 0 }));
    expect(wb.sheets[0]!.notes).toEqual({ A1: "Vérifier ce total." });
  });

  it("a sheet with no comments relationship has no `notes`", () => {
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1 }));
    expect(wb.sheets[0]!.notes).toBeUndefined();
  });
});

describe("XLSX import — AutoFilter (view filter)", () => {
  it("resolves colId relative to the filtered range's first column (not assumed to start at A)", () => {
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="C1"/></row></sheetData>
    <autoFilter ref="C1:E20">
      <filterColumn colId="1"><customFilters><customFilter val="*abc*"/></customFilters></filterColumn>
    </autoFilter></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1 }));
    // colId=1 relative to C (col 2) → column D (col 3)
    expect(wb.sheets[0]!.filter).toEqual({ col: 3, query: "abc" });
  });

  it("falls back to the first value of a checkbox <filters> list", () => {
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1"/></row></sheetData>
    <autoFilter ref="A1:B20">
      <filterColumn colId="0"><filters><filter val="Oui"/><filter val="Non"/></filters></filterColumn>
    </autoFilter></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1 }));
    expect(wb.sheets[0]!.filter).toEqual({ col: 0, query: "Oui" });
  });
});

describe("XLSX import — conditional formatting top10 / duplicateValues", () => {
  it("reads a top10 rule (rank/bottom/percent attributes)", () => {
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>
    <conditionalFormatting sqref="A1:A5">
      <cfRule type="top10" rank="3" bottom="1" priority="1"/>
    </conditionalFormatting></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1 }));
    const rule = wb.sheets[0]!.condFormats?.[0];
    expect(rule?.op).toBe("top10");
    expect(rule?.rank).toBe(3);
    expect(rule?.bottom).toBe(true);
  });

  it("reads a duplicateValues rule", () => {
    const sheet1 = `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>
    <conditionalFormatting sqref="A1:A5">
      <cfRule type="duplicateValues" priority="1"/>
    </conditionalFormatting></worksheet>`;
    const wb = importXlsx(buildXlsx({ sheet1 }));
    expect(wb.sheets[0]!.condFormats?.[0]?.op).toBe("duplicate");
  });
});
