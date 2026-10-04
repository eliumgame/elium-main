import { describe, it, expect } from "vitest";
import { applyPivotResult, buildPivot, dateGroupLabel, evalCalcField, newPivotObject, pivotIsStale, readSource, sourceHeaders, type PivotObject } from "../src/sheet/pivot-object";
import type { Workbook } from "../src/sheet/model";

// 2026-01-15 = série 46037 ; calcul indépendant pour éviter une valeur magique erronée
const serial = (y: number, m: number, d: number) => String(Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000));

const wb = (): Workbook => ({
  active: 0,
  sheets: [
    {
      name: "Données",
      rows: 10,
      cols: 5,
      cells: {
        A1: "Date", B1: "Région", C1: "Ventes", D1: "Coûts",
        A2: serial(2026, 1, 15), B2: "Nord", C2: "100", D2: "40",
        A3: serial(2026, 2, 3), B3: "Sud", C3: "50", D3: "20",
        A4: serial(2026, 4, 20), B4: "Nord", C4: "70", D4: "30",
        A5: "2027-01-02", B5: "Sud", C5: "=C3*2", D5: "10",
      },
    },
  ],
});
const src = { sheet: "Données", c0: 0, r0: 0, c1: 3, r1: 4 };
const base = (over: Partial<PivotObject> = {}): PivotObject => ({ id: "p", source: src, rowField: "Région", colField: null, valueField: "Ventes", agg: "sum", ...over });

describe("regroupement de dates", () => {
  it("année, trimestre, mois, jour — séries Excel et dates ISO", () => {
    const s = Number(serial(2026, 5, 9));
    expect(dateGroupLabel(s, "year")).toBe("2026");
    expect(dateGroupLabel(s, "quarter")).toBe("2026 T2");
    expect(dateGroupLabel(s, "month")).toBe("2026-05");
    expect(dateGroupLabel(s, "day")).toBe("2026-05-09");
    expect(dateGroupLabel("2027-12-31", "quarter")).toBe("2027 T4");
    expect(dateGroupLabel("pomme", "year")).toBeNull();
    expect(dateGroupLabel("x", "none")).toBe("x");
  });
});

describe("champs calculés", () => {
  it("formule entre crochets, insensible à la casse ; champ inconnu → null", () => {
    expect(evalCalcField("[Ventes]-[Coûts]", ["Ventes", "Coûts"], [100, 40])).toBe(60);
    expect(evalCalcField("=ROUND([ventes]/[Coûts],1)", ["Ventes", "Coûts"], [100, 30])).toBe(3.3);
    expect(evalCalcField("[Inconnu]+1", ["Ventes"], [1])).toBeNull();
    expect(evalCalcField("[Ventes]/0", ["Ventes"], [1])).toBeNull();
  });
  it("en-têtes vides nommés, champs calculés ajoutés", () => {
    expect(sourceHeaders(["A", " "], [{ name: "Marge", formula: "" }])).toEqual(["A", "Colonne2", "Marge"]);
  });
});

describe("pivot persistant", () => {
  it("lit la source avec formules évaluées", () => {
    const r = readSource(wb(), src)!;
    expect(r.headers).toEqual(["Date", "Région", "Ventes", "Coûts"]);
    expect(r.rows[3]![2]).toBe(100); // =C3*2
  });
  it("somme par région", () => {
    const b = buildPivot(wb(), base(), "TCD");
    if ("error" in b) throw new Error(b.error);
    expect(b.sheet.cells).toMatchObject({ A1: "Somme de Ventes", B1: "Total", A2: "Nord", B2: "170", A3: "Sud", B3: "150", A4: "Total", B4: "320" });
  });
  it("regroupement par année en lignes et par région en colonnes", () => {
    const b = buildPivot(wb(), base({ rowField: "Date", rowDateGroup: "year", colField: "Région" }), "TCD");
    if ("error" in b) throw new Error(b.error);
    expect(b.sheet.cells).toMatchObject({ A2: "2026", A3: "2027", B1: "Nord", C1: "Sud", B2: "170", C2: "50", C3: "100" });
  });
  it("champ calculé comme valeur, tri décroissant", () => {
    const b = buildPivot(wb(), base({ valueField: "Marge", calcFields: [{ name: "Marge", formula: "[Ventes]-[Coûts]" }], sort: "desc" }), "TCD");
    if ("error" in b) throw new Error(b.error);
    expect(b.sheet.cells).toMatchObject({ A1: "Somme de Marge", A2: "Sud", B2: String(30 + 90), A3: "Nord", B3: String(60 + 40) });
  });
  it("erreurs claires : champ ou feuille introuvable", () => {
    expect(buildPivot(wb(), base({ rowField: "Zzz" }), "T")).toEqual({ error: "Champ ligne « Zzz » introuvable dans la source." });
    expect(buildPivot(wb(), base({ source: { ...src, sheet: "Nope" } }), "T")).toEqual({ error: "Feuille source « Nope » introuvable." });
  });
  it("obsolescence et actualisation après modification de la source", () => {
    const w = wb();
    const p = base();
    const built = buildPivot(w, p, "TCD");
    if ("error" in built) throw new Error();
    const pivotSheet = applyPivotResult({ name: "TCD", rows: 5, cols: 3, cells: {} }, built.sheet, p);
    const w2: Workbook = { ...w, sheets: [...w.sheets, pivotSheet] };
    expect(pivotIsStale(w2, 1)).toBe(false);
    w2.sheets[0]!.cells.C2 = "1000";
    expect(pivotIsStale(w2, 1)).toBe(true);
    const again = buildPivot(w2, p, "TCD");
    if ("error" in again) throw new Error();
    expect(again.sheet.cells.B2).toBe("1070");
    expect(pivotSheet.pivot).toBe(p);
  });
  it("création depuis une sélection", () => {
    const p = newPivotObject("Données", src, ["Date", "Région", "Ventes", "Coûts"], { rowField: 1, colField: null, valueField: 2, agg: "avg" });
    expect(p).toMatchObject({ rowField: "Région", colField: null, valueField: "Ventes", agg: "avg", source: { sheet: "Données" } });
  });
});
