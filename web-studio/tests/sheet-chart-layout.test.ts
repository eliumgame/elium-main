import { describe, it, expect } from "vitest";
import { layoutChart, linearFit, niceTicks, polyFit, stackBounds, trendPoints, formatAxis } from "../src/sheet/chart-layout";

const S = [
  { label: "A", values: [1, 2, 3, 4] },
  { label: "B", values: [2, 2, 2, 2] },
];
const L = ["a", "b", "c", "d"];
const count = (p: ReturnType<typeof layoutChart>, k: string) => p.prims.filter((x) => x.k === k).length;

describe("graduations et mise en forme", () => {
  it("niceTicks arrondit sur 1/2/5 × 10^n", () => {
    const t = niceTicks(0, 87);
    expect(t.step).toBe(20);
    expect(t.min).toBe(0);
    expect(t.max).toBe(100);
    expect(niceTicks(0, 1).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(5, 5).ticks.length).toBeGreaterThan(1);
  });
  it("formatAxis", () => {
    expect(formatAxis(0.256, "percent")).toBe("25,6 %");
    expect(formatAxis(3.14159, "decimal")).toBe("3,14");
    expect(formatAxis(12, "currency")).toBe("12 €");
  });
});

describe("tendances", () => {
  it("régression linéaire exacte", () => {
    const f = linearFit([0, 1, 2, 3], [1, 3, 5, 7]);
    expect(f.a).toBeCloseTo(1);
    expect(f.b).toBeCloseTo(2);
    const pts = trendPoints([0, 1, 2, 3], [1, 3, 5, 7], { type: "linear" });
    expect(pts[3]![1]).toBeCloseTo(7);
  });
  it("régression polynomiale d'ordre 2 retrouve y = x²", () => {
    const xs = [0, 1, 2, 3, 4];
    const c = polyFit(xs, xs.map((x) => x * x), 2);
    expect(c[0]).toBeCloseTo(0, 5);
    expect(c[1]).toBeCloseTo(0, 5);
    expect(c[2]).toBeCloseTo(1, 5);
    expect(trendPoints(xs, xs.map((x) => x * x), { type: "poly", order: 2 })[4]![1]).toBeCloseTo(16);
    expect(trendPoints([0, 1], [1, 2], { type: "poly", order: 3 })).toEqual([]);
  });
  it("moyenne mobile", () => {
    const pts = trendPoints([0, 1, 2, 3], [2, 4, 6, 8], { type: "avg", period: 2 });
    expect(pts.map((p) => p[1])).toEqual([3, 5, 7]);
  });
});

describe("empilement", () => {
  it("empilé et 100 %", () => {
    const b = stackBounds(S, false);
    expect(b[1]![0]).toEqual({ lo: 1, hi: 3 });
    const p = stackBounds(S, true);
    expect(p[0]![0]!.hi + (p[1]![0]!.hi - p[1]![0]!.lo)).toBeCloseTo(1);
    expect(p[1]![3]!.hi).toBeCloseTo(1);
  });
});

describe("mise en page", () => {
  it("barres groupées : une barre par valeur et par série", () => {
    expect(count(layoutChart({ type: "bar", labels: L, series: S }), "rect") - 2 /* légende */).toBe(8);
  });
  it("plage vide", () => {
    expect(layoutChart({ type: "bar", labels: [], series: [{ label: "x", values: [] }] }).empty).toBe(true);
  });
  it("secteurs : une part par valeur non nulle ; étiquettes en %", () => {
    const l = layoutChart({ type: "pie", labels: L, series: [{ label: "s", values: [1, 1, 0, 2] }], opts: { dataLabels: true } });
    expect(count(l, "path")).toBe(3);
    expect(l.prims.filter((p) => p.k === "text" && p.cls === "value").map((p) => (p as { text: string }).text)).toEqual(["25 %", "25 %", "50 %"]);
  });
  it("aire empilée : un tracé par série, borne haute = somme", () => {
    const l = layoutChart({ type: "area", labels: L, series: S, opts: { grouping: "stacked" } });
    expect(count(l, "path")).toBe(2);
  });
  it("nuage de points : un cercle par point, abscisses numériques", () => {
    const l = layoutChart({ type: "scatter", labels: ["1", "2", "4", "8"], series: [{ label: "y", values: [1, 4, 9, 20] }] });
    expect(count(l, "circle")).toBe(4);
    const xs = l.prims.filter((p) => p.k === "circle").map((p) => (p as { cx: number }).cx);
    expect(xs[1]! - xs[0]!).toBeLessThan(xs[3]! - xs[2]!); // 1→2 plus court que 4→8
  });
  it("combiné : barres + courbe sur axe secondaire (graduations à droite)", () => {
    const l = layoutChart({
      type: "combo",
      labels: L,
      series: [S[0]!, { label: "Taux", values: [10, 20, 30, 40] }],
      opts: { seriesTypes: ["bar", "line"], secondary: [1], y2Title: "%" },
    });
    expect(count(l, "poly")).toBe(1);
    expect(l.prims.some((p) => p.k === "text" && p.anchor === "start" && p.cls === "label")).toBe(true);
    expect(l.prims.some((p) => p.k === "text" && p.cls === "axis-title" && p.rotate === 90)).toBe(true);
  });
  it("titres d'axes, légende à droite, étiquettes de données, bornes imposées", () => {
    const l = layoutChart({
      type: "line",
      labels: L,
      series: S,
      title: "Ventes",
      opts: { xTitle: "Mois", yTitle: "Montant", legend: "right", dataLabels: true, yMin: 0, yMax: 10 },
    });
    const texts = l.prims.filter((p) => p.k === "text").map((p) => (p as { text: string }).text);
    expect(texts).toEqual(expect.arrayContaining(["Ventes", "Mois", "Montant", "A", "B"]));
    expect(l.prims.filter((p) => p.k === "text" && p.cls === "value")).toHaveLength(8);
    expect(texts).toContain("10");
  });
  it("tendance : polyligne en pointillés supplémentaire", () => {
    const base = layoutChart({ type: "line", labels: L, series: [S[0]!] });
    const t = layoutChart({ type: "line", labels: L, series: [S[0]!], opts: { trendline: { type: "linear" } } });
    expect(count(t, "poly")).toBe(count(base, "poly") + 1);
    expect(t.prims.some((p) => p.k === "poly" && p.dash)).toBe(true);
  });
  it("barres horizontales", () => {
    const l = layoutChart({ type: "bar", labels: L, series: [S[0]!], opts: { horizontal: true } });
    const rects = l.prims.filter((p) => p.k === "rect") as { w: number; h: number }[];
    expect(rects[3]!.w).toBeGreaterThan(rects[0]!.w);
  });
});
