import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { astCacheSize, clearAstCache, createCalc } from "../src/sheet/formula";
import { maxOf, minOf } from "../src/sheet/numeric";
import { evalCalcField, pivotIsStale, applyPivotResult, buildPivot, newPivotObject } from "../src/sheet/pivot-object";
import { COND_RANGE_MAX_CELLS, buildCondFormatter, oversizedCondRules, type CondRule } from "../src/sheet/condformat";
import { hiddenRowsCooperative } from "../src/sheet/coop-rows";
import { csvToWorkbook, csvToWorkbookAsync, parseCsv, parseCsvAsync } from "../src/sheet/csv";
import { workbookToXlsx, workbookToXlsxAsync } from "../src/sheet/xlsx-export";
import { parseJsonCooperative, stringifyWorkbookCooperative } from "../src/sheet/coop-json";
import type { Workbook } from "../src/sheet/model";

describe("min/max sans dépliage d'arguments", () => {
  it("supporte des centaines de milliers de valeurs", () => {
    const big = Array.from({ length: 400_000 }, (_, i) => i - 5);
    expect(() => Math.min(...big)).toThrow(RangeError);
    expect(minOf(big)).toBe(-5);
    expect(maxOf(big)).toBe(399_994);
  });
  it("garde la sémantique de Math.min/max", () => {
    expect(minOf([])).toBe(Infinity);
    expect(maxOf([])).toBe(-Infinity);
    expect(minOf([3, NaN, 1])).toBeNaN();
    expect(maxOf([3, NaN, 1])).toBeNaN();
    expect(minOf([2, 1, 3])).toBe(1);
  });
  it("MIN/MAX de formule sur 150 000 cellules", () => {
    const cells: Record<string, string> = { B1: "=MIN(A1:A150000)", B2: "=MAX(A1:A150000)" };
    for (let i = 1; i <= 150_000; i++) cells[`A${i}`] = String(i);
    const calc = createCalc((r) => cells[r]);
    expect(calc.valueOf("B1")).toBe(1);
    expect(calc.valueOf("B2")).toBe(150_000);
  });
});

describe("cache d'AST partagé entre les moteurs", () => {
  it("n'analyse pas deux fois la même formule d'un moteur à l'autre", () => {
    clearAstCache();
    const cells: Record<string, string> = { A1: "1", A2: "2", B1: "=A1+A2", B2: "=SUM(A1:A2)*2" };
    const a = createCalc((r) => cells[r]);
    expect(a.valueOf("B1")).toBe(3);
    expect(a.valueOf("B2")).toBe(6);
    const size = astCacheSize();
    expect(size).toBeGreaterThanOrEqual(2);
    cells.A1 = "10";
    const b = createCalc((r) => cells[r]);
    expect(b.valueOf("B1")).toBe(12);
    expect(astCacheSize()).toBe(size);
  });
  it("le débordement (spill) fonctionne toujours et suit les modifications", () => {
    const cells: Record<string, string> = { A1: "1", A2: "2", A3: "3", C1: "=A1:A3*2" };
    const mk = () =>
      createCalc(
        (r) => cells[r],
        undefined,
        undefined,
        () => Object.keys(cells),
      );
    const a = mk();
    expect(a.valueOf("C3")).toBe(6);
    expect(a.spillAnchor("C2")).toBe("C1");
    cells.A3 = "5";
    expect(mk().valueOf("C3")).toBe(10);
  });
});

describe("champs calculés du pivot", () => {
  it("évalue [champ] sans re-parser par ligne", () => {
    const headers = ["Prix", "Qté"];
    expect(evalCalcField("=[Prix]*[Qté]", headers, [4, 3])).toBe(12);
    expect(evalCalcField("[Prix]-[Qté]", headers, [4, 10])).toBe(-6);
    expect(evalCalcField("[Prix]*2", headers, ["abc", 3])).toBe(0);
    expect(evalCalcField("[Inconnu]*2", headers, [1, 1])).toBeNull();
    expect(evalCalcField("[Prix]/[Qté]", headers, [1, 0])).toBeNull();
  });
  it("pivotIsStale : faux après actualisation, vrai si la source change", () => {
    const cells: Record<string, string> = { A1: "k", B1: "v", A2: "x", B2: "1", A3: "y", B3: "2", A4: "x", B4: "3" };
    const wb: Workbook = { active: 0, sheets: [{ name: "S", rows: 20, cols: 8, cells }] };
    const p = newPivotObject("S", { c0: 0, r0: 0, c1: 1, r1: 3 }, ["k", "v"], {
      rowField: 0,
      colField: null,
      valueField: 1,
      agg: "sum",
    });
    const built = buildPivot(wb, p, "Pivot");
    if ("error" in built) throw new Error(built.error);
    const piv = applyPivotResult({ name: "Pivot", rows: 20, cols: 8, cells: {} }, built.sheet, p);
    const wb2: Workbook = { active: 0, sheets: [wb.sheets[0]!, piv] };
    expect(pivotIsStale(wb2, 1)).toBe(false);
    wb2.sheets[0] = { ...wb.sheets[0]!, cells: { ...cells, B2: "100" } };
    expect(pivotIsStale(wb2, 1)).toBe(true);
  });
});

describe("mise en forme conditionnelle : plafond des règles d'étendue", () => {
  const rule = (over: Partial<CondRule>): CondRule =>
    ({ id: "r", op: "duplicate", c0: 0, r0: 0, c1: 0, r1: 9, ...over }) as CondRule;
  it("ignore les règles d'étendue sur une plage énorme et le signale", () => {
    const big = rule({ id: "big", op: "top10", r1: COND_RANGE_MAX_CELLS });
    const small = rule({ id: "small", op: "duplicate", fill: "#f00" });
    expect(oversizedCondRules([big, small]).map((r) => r.id)).toEqual(["big"]);
    let reads = 0;
    const f = buildCondFormatter(
      [big],
      () => {
        reads++;
        return 1;
      },
      () => "x",
    );
    expect(f(0, 0)).toEqual({});
    expect(reads).toBe(0);
  });
  it("applique toujours les règles raisonnables", () => {
    const f = buildCondFormatter(
      [rule({ fill: "#0f0" })],
      () => "",
      (_c, r) => (r < 2 ? "a" : `u${r}`),
    );
    expect(f(0, 0).background).toBe("#0f0");
    expect(f(0, 5).background).toBeUndefined();
  });
});

describe("masque de lignes coopératif", () => {
  it("donne le même masque qu'un calcul direct", async () => {
    const visible = (r: number) => r % 3 !== 0;
    const m = await hiddenRowsCooperative(5000, visible, () => false);
    expect(m).not.toBeNull();
    for (let r = 0; r < 5000; r++) expect(m![r]).toBe(visible(r) ? 0 : 1);
  });
  it("s'annule quand un calcul plus récent prend le relais", async () => {
    let dead = false;
    const m = await hiddenRowsCooperative(
      200_000,
      (r) => {
        if (r === 10) dead = true;
        for (let k = 0; k < 200; k++) Math.sqrt(k);
        return true;
      },
      () => dead,
    );
    expect(m).toBeNull();
  });
});

describe("CSV coopératif", () => {
  const csv = Array.from({ length: 3000 }, (_, i) => `${i};"a ""q"" ${i}";x\n`).join("") + "dernier;ligne";
  it("même résultat que le parseur synchrone", async () => {
    expect(await parseCsvAsync(csv, ";")).toEqual(parseCsv(csv, ";"));
    expect(await csvToWorkbookAsync(csv)).toEqual(csvToWorkbook(csv));
  });
});

describe("export XLSX coopératif", () => {
  it("produit les mêmes fichiers que l'export synchrone", async () => {
    const cells: Record<string, string> = {};
    for (let i = 1; i <= 6000; i++) {
      cells[`A${i}`] = `t${i}`;
      cells[`B${i}`] = String(i);
      if (i % 50 === 0) cells[`C${i}`] = `=B${i}*2`;
    }
    const wb: Workbook = {
      active: 0,
      sheets: [
        { name: "Grande", rows: 6000, cols: 8, cells, rowHeights: { 3: 30 } },
        { name: "Vide", rows: 3, cols: 3, cells: {} },
      ],
    };
    const sync = unzipSync(workbookToXlsx(wb));
    const asynchrone = unzipSync(await workbookToXlsxAsync(wb));
    expect(Object.keys(asynchrone).sort()).toEqual(Object.keys(sync).sort());
    for (const k of Object.keys(sync)) expect(strFromU8(asynchrone[k]!)).toBe(strFromU8(sync[k]!));
  });
});

describe("relecture coopérative d'un gros classeur", () => {
  it("aller-retour identique, au-delà du seuil de parse direct", async () => {
    const cells: Record<string, string> = {};
    const styles: Record<string, { bold: boolean }> = {};
    for (let i = 1; i <= 40_000; i++) {
      cells[`A${i}`] = `valeur "${i}" ligne\nsuivante ${"x".repeat(20)}`;
      if (i % 4 === 0) styles[`A${i}`] = { bold: true };
    }
    const wb: Workbook = {
      active: 0,
      names: [{ name: "N", ref: "A1" }],
      sheets: [
        { name: "G", rows: 40_000, cols: 60, cells, styles, notes: { A1: "note" } },
        { name: "Vide", rows: 3, cols: 3, cells: {} },
      ],
    };
    const blob = await stringifyWorkbookCooperative(wb);
    const text = await blob!.text();
    expect(text.length).toBeGreaterThan(1_000_000);
    expect(JSON.parse(text)).toEqual(wb);
    expect(await parseJsonCooperative<Workbook>(text)).toEqual(wb);
  });
  it("laisse l'ancien format et les petits textes au JSON.parse", async () => {
    expect(await parseJsonCooperative<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
});
