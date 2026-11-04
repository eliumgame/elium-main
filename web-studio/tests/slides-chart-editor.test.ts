import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { deckToPptx } from "../src/slides/pptx";
import { importPptx } from "../src/slides/pptx-import";
import { slideToY, yToSlide } from "../src/drive-cloud/collab-slides-crdt";
import {
  MAX_CHART_POINTS,
  MAX_CHART_SERIES,
  chartSeriesOf,
  type ChartData,
  type Deck,
  type Slide,
} from "../src/slides/model";
import {
  addPoint,
  addSeries,
  alignChart,
  changeKind,
  chartColumns,
  duplicateSeries,
  moveSeries,
  parseChartNumber,
  removePoint,
  removeSeries,
  renameSeries,
  setLabel,
  setStacked,
  setValue,
  usedColumns,
} from "../src/slides/chart-edit";

const base = (): ChartData => ({
  kind: "bar",
  labels: ["a", "b", "c"],
  values: [1, 2, 3],
  seriesName: "Nord",
  series: [{ name: "Sud", values: [4, 5, 6] }],
});
const slideOf = (chart: ChartData): Slide => ({
  id: "s1",
  title: "",
  body: "",
  bodyHtml: "",
  layout: "blank",
  elements: [{ id: "c", type: "chart", x: 5, y: 5, w: 60, h: 60, chart }],
});
const deckOf = (chart: ChartData): Deck => ({
  active: 0,
  theme: "light",
  transition: "fade",
  slides: [slideOf(chart)],
});
const chartOf = (d: Deck) => d.slides[0]!.elements!.find((e) => e.type === "chart")!.chart!;
const roundTrip = (chart: ChartData, warn: string[] = []) =>
  chartOf(importPptx(deckToPptx(deckOf(chart)), (w) => warn.push(w)));
const chartXml = (chart: ChartData) => strFromU8(unzipSync(deckToPptx(deckOf(chart)))["ppt/charts/chart1.xml"]!);

describe("parseChartNumber", () => {
  it("accepte virgule, espaces et signes", () => {
    expect(parseChartNumber("12,5")).toBe(12.5);
    expect(parseChartNumber(" 1 234,5 ")).toBe(1234.5);
    expect(parseChartNumber("1 000")).toBe(1000);
    expect(parseChartNumber("-3")).toBe(-3);
    expect(parseChartNumber("+4.25")).toBe(4.25);
    expect(parseChartNumber(".5")).toBe(0.5);
    expect(parseChartNumber("1e3")).toBe(1000);
  });
  it("refuse le reste", () => {
    for (const bad of ["", " ", "abc", "1,2,3", "12a", "--1", "Infinity", "NaN", "1e999"])
      expect(parseChartNumber(bad)).toBeNull();
  });
});

describe("édition de séries et de points", () => {
  it("ajoute, renomme, duplique, déplace, supprime des séries en restant aligné", () => {
    let c = addSeries(base())!;
    expect(chartColumns(c).map((x) => x.name)).toEqual(["Nord", "Sud", "Série 3"]);
    expect(c.series![1]!.values).toEqual([0, 0, 0]);
    c = renameSeries(c, 2, "Est");
    c = setValue(c, 2, 1, 9);
    c = duplicateSeries(c, 2)!;
    expect(chartColumns(c).map((x) => x.name)).toEqual(["Nord", "Sud", "Est", "Est (copie)"]);
    expect(chartColumns(c)[3]!.values).toEqual([0, 9, 0]);
    c = moveSeries(c, 2, -1)!;
    expect(chartColumns(c).map((x) => x.name)).toEqual(["Nord", "Est", "Sud", "Est (copie)"]);
    c = moveSeries(c, 1, -1)!; // Est devient la 1re série
    expect(c.seriesName).toBe("Est");
    expect(c.values).toEqual([0, 9, 0]);
    expect(moveSeries(c, 0, -1)).toBeNull();
    c = removeSeries(c, 0)!;
    expect(c.seriesName).toBe("Nord");
    expect(c.series!.length).toBe(2);
  });

  it("ne supprime jamais la dernière série ; sans extra, `series` disparaît", () => {
    const one: ChartData = { kind: "bar", labels: ["x"], values: [1] };
    expect(removeSeries(one, 0)).toBeNull();
    const c = removeSeries(base(), 1)!;
    expect(c.series).toBeUndefined();
    expect(c.seriesName).toBe("Nord");
  });

  it("respecte le plafond de séries et de points", () => {
    let c: ChartData = { kind: "bar", labels: ["x"], values: [1] };
    while (chartColumns(c).length < MAX_CHART_SERIES) c = addSeries(c)!;
    expect(addSeries(c)).toBeNull();
    expect(duplicateSeries(c, 0)).toBeNull();
    const big: ChartData = {
      kind: "line",
      labels: Array.from({ length: MAX_CHART_POINTS }, (_, i) => String(i)),
      values: Array(MAX_CHART_POINTS).fill(1),
    };
    expect(addPoint(big)).toBeNull();
  });

  it("garde toutes les séries alignées sur les points", () => {
    let c = addPoint(base(), "d")!;
    expect(c.labels).toEqual(["a", "b", "c", "d"]);
    expect(c.values).toEqual([1, 2, 3, 0]);
    expect(c.series![0]!.values).toEqual([4, 5, 6, 0]);
    c = removePoint(c, 0)!;
    expect(c.labels).toEqual(["b", "c", "d"]);
    expect(c.values).toEqual([2, 3, 0]);
    expect(c.series![0]!.values).toEqual([5, 6, 0]);
    c = setLabel(c, 1, "zz");
    expect(c.labels[1]).toBe("zz");
    expect(removePoint({ kind: "bar", labels: ["x"], values: [1] }, 0)).toBeNull();
  });

  it("réaligne un modèle désaligné et refuse les valeurs non finies", () => {
    const bad: ChartData = {
      kind: "bar",
      labels: ["a", "b"],
      values: [1],
      series: [{ name: "S", values: [1, 2, 3, 4] }],
    };
    const c = alignChart(bad);
    expect(c.values).toEqual([1, 0]);
    expect(c.series![0]!.values).toEqual([1, 2]);
    expect(setValue(base(), 0, 0, NaN)).toEqual(base());
  });

  it("ne modifie pas l'entrée (immutabilité)", () => {
    const b = base();
    const snap = JSON.stringify(b);
    setValue(b, 1, 0, 99);
    addSeries(b);
    removePoint(b, 0);
    expect(JSON.stringify(b)).toBe(snap);
  });
});

describe("changement de type", () => {
  it("barres <-> courbes conservent toutes les séries, sans avertissement", () => {
    const r = changeKind(base(), "line");
    expect(r.warning).toBeUndefined();
    expect(chartSeriesOf(r.chart).length).toBe(2);
  });
  it("camembert : avertit, ne détruit rien, ne montre que la 1re série, et on peut revenir", () => {
    const r = changeKind(base(), "pie");
    expect(r.warning).toMatch(/première série/);
    expect(r.chart.series).toEqual(base().series);
    expect(usedColumns(r.chart).length).toBe(1);
    const back = changeKind(r.chart, "bar").chart;
    expect(chartSeriesOf(back).length).toBe(2);
    expect(changeKind({ kind: "bar", labels: ["a"], values: [1] }, "pie").warning).toBeUndefined();
  });
  it("le mode empilé est mémorisé et retiré proprement", () => {
    const s = setStacked(base(), true);
    expect(s.stacked).toBe(true);
    expect("stacked" in setStacked(s, false)).toBe(false);
    expect(changeKind(s, "line").chart.stacked).toBe(true);
  });
});

describe("PPTX : séries + barres empilées", () => {
  it("round-trip empilé multi-séries", () => {
    const warn: string[] = [];
    const c = roundTrip({ ...base(), stacked: true }, warn);
    expect(c.stacked).toBe(true);
    expect(c.series).toEqual(base().series);
    expect(warn).toEqual([]);
    const xml = chartXml({ ...base(), stacked: true });
    expect(xml).toContain('<c:grouping val="stacked"/>');
    expect(xml).toContain('<c:overlap val="100"/>');
  });
  it("barres groupées : pas de stacked ni overlap", () => {
    expect(roundTrip(base()).stacked).toBeUndefined();
    const xml = chartXml(base());
    expect(xml).toContain('<c:grouping val="clustered"/>');
    expect(xml).not.toContain("c:overlap");
  });
  it("l'empilement n'est pas exporté pour une courbe", () => {
    const xml = chartXml({ ...base(), kind: "line", stacked: true });
    expect(xml).not.toContain('val="stacked"');
    expect(xml).not.toContain("c:overlap");
  });
  it("percentStacked s'importe en empilé avec avertissement", () => {
    const parts = unzipSync(deckToPptx(deckOf({ ...base(), stacked: true })));
    const key = "ppt/charts/chart1.xml";
    parts[key] = strToU8(strFromU8(parts[key]!).replace('val="stacked"', 'val="percentStacked"'));
    const warn: string[] = [];
    const c = chartOf(importPptx(zipSync(parts), (w) => warn.push(w)));
    expect(c.stacked).toBe(true);
    expect(warn).toEqual(["Graphique : pourcentage empilé approximé en empilé."]);
  });
});

describe("compat et collab", () => {
  it("un ancien deck (sans stacked/series) s'édite et s'exporte normalement", () => {
    const old: ChartData = { kind: "bar", labels: ["a", "b"], values: [3, 4] };
    expect(chartColumns(old).length).toBe(1);
    const edited = addSeries(setValue(old, 0, 1, 7))!;
    expect(edited.values).toEqual([3, 7]);
    expect(roundTrip(old)).toMatchObject({ kind: "bar", labels: ["a", "b"], values: [3, 4] });
  });
  it("séries et stacked voyagent via le CRDT collaboratif", () => {
    const chart: ChartData = { ...base(), stacked: true, title: "T" };
    const doc = new Y.Doc();
    doc.getArray<Y.Map<unknown>>("slides").push([slideToY(slideOf(chart))]);
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));
    const back = yToSlide(doc2.getArray<Y.Map<unknown>>("slides").get(0));
    expect(back.elements![0]!.chart).toEqual(chart);
  });
});
