import { describe, it, expect } from "vitest";
import { createCalc } from "../src/sheet/formula";
import {
  addTable,
  expandStructuredRefs,
  nextTableName,
  removeTable,
  structuredForFile,
  tableCellLook,
  tableDefs,
  validTableName,
} from "../src/sheet/tables";
import type { SheetData } from "../src/sheet/model";

const base = (): SheetData => ({
  name: "Ventes",
  rows: 10,
  cols: 5,
  cells: {
    A1: "Produit",
    B1: "Prix",
    C1: "Qté",
    D1: "Total",
    A2: "Pomme",
    B2: "2",
    C2: "10",
    A3: "Poire",
    B3: "3",
    C3: "4",
    A4: "Kiwi",
    B4: "1",
    C4: "7",
  },
});
const withTable = (): SheetData => addTable(base(), { c0: 0, r0: 0, c1: 3, r1: 3 }, [], "Tab");
const defs = (s: SheetData) => tableDefs([s]);

describe("références structurées", () => {
  const t = defs(withTable());
  const x = (f: string, row: number | null = null, sheet = "Ventes") => expandStructuredRefs(f, t, sheet, row);
  it("colonne de données, en-têtes, tout, cette ligne", () => {
    expect(x("SUM(Tab[Prix])")).toBe("SUM($B$2:$B$4)");
    expect(x("Tab[[#Headers],[Qté]]")).toBe("$C$1");
    expect(x("Tab[#All]")).toBe("$A$1:$D$4");
    expect(x("Tab[#Headers]")).toBe("$A$1:$D$1");
    expect(x("Tab[@Prix]*Tab[@Qté]", 2)).toBe("$B$3*$C$3");
    expect(x("Tab[[#This Row],[Prix]]", 3)).toBe("$B$4");
    expect(x("Tab[[Prix]:[Qté]]")).toBe("$B$2:$C$4");
    expect(x("SUM(Tab)")).toBe("SUM($A$2:$D$4)");
  });
  it("insensible à la casse, chaînes intactes, colonne inconnue → #REF!, autre feuille qualifiée", () => {
    expect(x('tab[prix]&"Tab[Prix]"')).toBe('$B$2:$B$4&"Tab[Prix]"');
    expect(x("Tab[Inconnue]")).toBe("#REF!");
    expect(x("Tab[Prix]", null, "Autre")).toBe("Ventes!$B$2:$B$4");
    expect(x("A1+B2")).toBe("A1+B2");
  });
  it("ligne de totaux exclue des données", () => {
    const s = { ...withTable(), tables: [{ ...withTable().tables![0]!, totals: true }] };
    expect(expandStructuredRefs("Tab[Prix]", defs(s), "Ventes", null)).toBe("$B$2:$B$3");
    expect(expandStructuredRefs("Tab[#Totals]", defs(s), "Ventes", null)).toBe("$A$4:$D$4");
  });
  it("écriture fichier : @ devient [#This Row]", () => {
    expect(structuredForFile("Tab[@Prix]*2")).toBe("Tab[[#This Row],[Prix]]*2");
    expect(structuredForFile("Tab[@[Prix unitaire]]")).toBe("Tab[[#This Row],[Prix unitaire]]");
  });
});

describe("calcul avec tableaux", () => {
  it("Total = Prix × Qté par ligne et SUM(Tab[Total])", () => {
    const s = withTable();
    s.cells.D2 = "=Tab[@Prix]*Tab[@Qté]";
    s.cells.D3 = "=Tab[@Prix]*Tab[@Qté]";
    s.cells.D4 = "=Tab[@Prix]*Tab[@Qté]";
    s.cells.F1 = "=SUM(Tab[Total])";
    s.cells.F2 = "=SUM(Tab[Qté])";
    const c = createCalc((r) => s.cells[r], undefined, undefined, undefined, { tables: defs(s), sheet: s.name });
    expect(c.valueOf("D2")).toBe(20);
    expect(c.valueOf("F1")).toBe(20 + 12 + 7);
    expect(c.valueOf("F2")).toBe(21);
  });
  it("tableau d'une autre feuille", () => {
    const a = withTable();
    const b: SheetData = { name: "Synthèse", rows: 5, cols: 3, cells: { A1: "=SUM(Tab[Prix])" } };
    const c = createCalc(
      (r) => b.cells[r],
      { getSheetRaw: (n, r) => (n === "Ventes" ? a.cells[r] : undefined), hasSheet: (n) => n === "Ventes" },
      undefined,
      undefined,
      {
        tables: tableDefs([a, b]),
        sheet: "Synthèse",
      },
    );
    expect(c.valueOf("A1")).toBe(6);
  });
});

describe("gestion", () => {
  it("noms valides et uniques", () => {
    expect(validTableName("Ventes_2026", [])).toBeNull();
    expect(validTableName("1abc", [])).toMatch(/commencer/);
    expect(validTableName("AB12", [])).toMatch(/référence/);
    expect(validTableName("tab", ["Tab"])).toMatch(/déjà/);
    expect(validTableName("tab", ["Tab"], "Tab")).toBeNull();
    expect(nextTableName(["Tableau1", "tableau2"])).toBe("Tableau3");
  });
  it("création : en-têtes vides/dupliqués corrigés ; suppression", () => {
    const s = addTable(
      { ...base(), cells: { ...base().cells, B1: "", C1: "Prix" } },
      { c0: 0, r0: 0, c1: 2, r1: 3 },
      [],
    );
    expect(s.cells.B1).toBe("Colonne2");
    expect(s.cells.C1).toBe("Prix");
    expect(s.tables![0]!.name).toBe("Tableau1");
    expect(removeTable(s, s.tables![0]!.id).tables).toBeUndefined();
    expect(addTable(base(), { c0: 0, r0: 0, c1: 1, r1: 0 }, [])).toEqual(base());
  });
  it("aspect : en-tête, lignes alternées, hors tableau", () => {
    const s = withTable();
    expect(tableCellLook(s, 1, 0)).toMatchObject({ header: true });
    expect(tableCellLook(s, 1, 1)).toMatchObject({ band: false });
    expect(tableCellLook(s, 1, 2)).toMatchObject({ band: true });
    expect(tableCellLook(s, 8, 8)).toBeNull();
  });
});
