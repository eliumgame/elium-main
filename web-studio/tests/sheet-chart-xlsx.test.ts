// @vitest-environment jsdom
// Graphiques riches : aller-retour XLSX (DrawingML réel) et fusion CRDT des options.
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { unzipSync, strFromU8 } from "fflate";
import { workbookToXlsx } from "../src/sheet/xlsx-export";
import { importXlsx } from "../src/sheet/xlsx-import";
import { chartSpaceXml } from "../src/sheet/chart-ooxml";
import { newYSheet, reconcileSheet, sheetSnapshot, setChart, type YSheets } from "../src/drive-cloud/collab-sheet-model";
import type { ChartSpec, Workbook } from "../src/sheet/model";

const wbWith = (chart: Omit<ChartSpec, "id">): Workbook => ({
  active: 0,
  sheets: [
    {
      name: "Données",
      rows: 8,
      cols: 4,
      cells: { A1: "Mois", B1: "Ventes", C1: "Marge", A2: "Jan", B2: "10", C2: "3", A3: "Fév", B3: "20", C3: "5", A4: "Mar", B4: "15", C4: "4" },
      charts: [{ id: "c1", ...chart }],
    },
  ],
});
const trip = (c: Omit<ChartSpec, "id">): ChartSpec => importXlsx(workbookToXlsx(wbWith(c))).sheets[0]!.charts![0]!;
const base = { c0: 0, r0: 0, c1: 2, r1: 3 };

describe("graphiques riches — XLSX (DrawingML)", () => {
  it("empilé 100 %, barres horizontales, titres d'axes, bornes, format, légende, étiquettes", () => {
    const opts = { grouping: "percent" as const, horizontal: true, xTitle: "Mois", yTitle: "Part", legend: "right" as const, dataLabels: true };
    const back = trip({ type: "bar", ...base, title: "Ventes", opts });
    expect(back.type).toBe("bar");
    expect(back.title).toBe("Ventes");
    expect(back.opts).toEqual(opts);
  });
  it("bornes et format de l'axe Y", () => {
    const back = trip({ type: "line", ...base, opts: { yMin: 0, yMax: 50, yFormat: "currency", smooth: true } });
    expect(back.opts).toEqual({ yMin: 0, yMax: 50, yFormat: "currency", smooth: true });
  });
  it("aire empilée et nuage de points", () => {
    expect(trip({ type: "area", ...base, opts: { grouping: "stacked" } })).toMatchObject({ type: "area", opts: { grouping: "stacked" } });
    const sc = trip({ type: "scatter", ...base });
    expect(sc.type).toBe("scatter");
    expect([sc.c0, sc.c1, sc.r0, sc.r1]).toEqual([0, 2, 0, 3]);
  });
  it("combiné : types par série, axe secondaire et son titre", () => {
    const opts = { seriesTypes: ["bar", "line"] as ("bar" | "line")[], secondary: [1], y2Title: "Marge %" };
    const back = trip({ type: "combo", ...base, opts });
    expect(back.type).toBe("combo");
    expect(back.opts).toEqual(opts);
  });
  it("courbes de tendance : linéaire, polynomiale, moyenne mobile", () => {
    expect(trip({ type: "line", ...base, opts: { trendline: { type: "linear" } } }).opts?.trendline).toEqual({ type: "linear" });
    expect(trip({ type: "line", ...base, opts: { trendline: { type: "poly", order: 3 } } }).opts?.trendline).toEqual({ type: "poly", order: 3 });
    expect(trip({ type: "line", ...base, opts: { trendline: { type: "avg", period: 2, series: 1 } } }).opts?.trendline).toEqual({ type: "avg", period: 2, series: 1 });
  });
  it("sans option : aucune clé opts (rendu historique inchangé)", () => {
    expect(trip({ type: "bar", ...base }).opts).toBeUndefined();
  });
  it("le XML écrit contient de vraies balises Excel (barChart, areaChart, scatterChart, trendline, valAx secondaire)", () => {
    const zip = unzipSync(workbookToXlsx(wbWith({ type: "combo", ...base, opts: { seriesTypes: ["bar", "line"], secondary: [1], trendline: { type: "linear" } } })));
    const xml = strFromU8(zip["xl/charts/chart1.xml"]!);
    expect(xml).toContain("<c:barChart>");
    expect(xml).toContain("<c:lineChart>");
    expect(xml).toContain("<c:trendline>");
    expect(xml.match(/<c:valAx>/g)).toHaveLength(2);
    expect(xml).toContain('<c:crosses val="max"/>');
  });
  it("données littérales (DOCX/PPTX) : pas de plage, valeurs en strLit/numLit", () => {
    const xml = chartSpaceXml({ type: "bar", title: "T", series: [{ name: "S", cats: ["a", "b"], vals: [1, 2] }] });
    expect(xml).toContain("<c:strLit>");
    expect(xml).toContain("<c:numLit>");
    expect(xml).not.toContain("<c:f>");
  });
});

describe("graphiques riches — CRDT", () => {
  it("les options d'un graphique survivent à setChart + snapshot, et deux auteurs fusionnent par graphique", () => {
    const ydoc = new Y.Doc();
    const sheets = ydoc.getArray("sheets") as unknown as YSheets;
    ydoc.transact(() => sheets.push([newYSheet("F")]));
    const ys = sheets.get(0);
    const spec: ChartSpec = { id: "ch", type: "combo", ...base, opts: { seriesTypes: ["bar", "line"], secondary: [1], trendline: { type: "poly", order: 2 }, yTitle: "€" } };
    setChart(ydoc, ys, spec);
    expect(sheetSnapshot(ys).charts).toEqual([spec]);
    // un second poste reconcilie vers une cible : le graphique modifié est repris tel quel
    reconcileSheet(ydoc, ys, { ...sheetSnapshot(ys), charts: [{ ...spec, opts: { ...spec.opts, legend: "top" } }] });
    expect(sheetSnapshot(ys).charts![0]!.opts!.legend).toBe("top");
  });
});
