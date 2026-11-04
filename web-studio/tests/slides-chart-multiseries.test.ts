import { describe, it, expect } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { deckToPptx } from "../src/slides/pptx";
import { importPptx } from "../src/slides/pptx-import";
import { chartSeriesOf, MAX_CHART_SERIES, type ChartData, type Deck } from "../src/slides/model";

const deckOf = (chart: ChartData): Deck => ({
  active: 0,
  theme: "light",
  transition: "fade",
  slides: [
    {
      id: "s1",
      title: "",
      body: "",
      bodyHtml: "",
      layout: "blank",
      elements: [{ id: "c", type: "chart", x: 5, y: 5, w: 60, h: 60, chart }],
    },
  ],
});
const roundTrip = (chart: ChartData, warn: string[] = [], exportWarn: string[] = []) => {
  const d = importPptx(
    deckToPptx(deckOf(chart), (w) => exportWarn.push(w)),
    (w) => warn.push(w),
  );
  return d.slides[0]!.elements!.find((e) => e.type === "chart")!.chart!;
};

describe("multi-series charts", () => {
  it("round-trips a 3-series clustered bar chart with names", () => {
    const warn: string[] = [];
    const c = roundTrip(
      {
        kind: "bar",
        labels: ["T1", "T2"],
        values: [1, 2],
        seriesName: "Nord",
        series: [
          { name: "Sud", values: [3, 4] },
          { name: "Est", values: [5, 6] },
        ],
      },
      warn,
    );
    expect(c.seriesName).toBe("Nord");
    expect(c.values).toEqual([1, 2]);
    expect(c.series).toEqual([
      { name: "Sud", values: [3, 4] },
      { name: "Est", values: [5, 6] },
    ]);
    expect(warn).toEqual([]);
  });

  it("round-trips multiple lines and writes one c:ser each plus a legend", () => {
    const chart: ChartData = {
      kind: "line",
      labels: ["a", "b"],
      values: [1, 2],
      series: [{ name: "L2", values: [2, 1] }],
    };
    const zip = unzipSync(deckToPptx(deckOf(chart)));
    const xml = strFromU8(zip["ppt/charts/chart1.xml"]!);
    expect(xml.match(/<c:ser>/g)).toHaveLength(2);
    expect(xml).toContain("<c:legend>");
    const c = roundTrip(chart);
    expect(c.kind).toBe("line");
    expect(c.series).toEqual([{ name: "L2", values: [2, 1] }]);
  });

  it("pie exports the first series only, with an export warning", () => {
    const ew: string[] = [];
    const c = roundTrip(
      { kind: "pie", labels: ["a", "b"], values: [1, 2], series: [{ name: "x", values: [3, 4] }] },
      [],
      ew,
    );
    expect(ew).toHaveLength(1);
    expect(c.series).toBeUndefined();
    expect(c.values).toEqual([1, 2]);
  });

  it("keeps the single-series output unchanged (old deck compat)", () => {
    const c = roundTrip({ kind: "bar", labels: ["X", "Y"], values: [3, 7], title: "Ventes" });
    expect(c.series).toBeUndefined();
    expect(c.title).toBe("Ventes");
    expect(c.values).toEqual([3, 7]);
    expect(chartSeriesOf(c)).toEqual([{ label: "Série 1", values: [3, 7] }]);
  });

  it("chartSeriesOf lists extra series and survives JSON (old/new client)", () => {
    const c: ChartData = { kind: "bar", labels: ["a"], values: [1], series: [{ name: "B", values: [2] }] };
    const back = JSON.parse(JSON.stringify(c)) as ChartData;
    expect(chartSeriesOf(back).map((s) => s.label)).toEqual(["Série 1", "B"]);
    // an old client only reads kind/labels/values
    expect(back.values).toEqual([1]);
  });

  it("caps series and points on import with warnings", () => {
    const n = MAX_CHART_SERIES + 3;
    const pts = (vals: number[]) => vals.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join("");
    const mk = (i: number) =>
      `<c:ser><c:tx><c:v>S${i}</c:v></c:tx><c:cat><c:strLit>${pts([0, 1])}</c:strLit></c:cat><c:val><c:numLit>${pts([i, i])}</c:numLit></c:val></c:ser>`;
    const plot = `<c:barChart>${Array.from({ length: n }, (_, i) => mk(i)).join("")}</c:barChart>`;
    const zip = unzipSync(deckToPptx(deckOf({ kind: "bar", labels: ["a"], values: [1] })));
    zip["ppt/charts/chart1.xml"] = strToU8(
      `<c:chartSpace><c:chart><c:plotArea>${plot}</c:plotArea></c:chart></c:chartSpace>`,
    );
    const warn: string[] = [];
    const d = importPptx(zipSync(zip), (w) => warn.push(w));
    const c = d.slides[0]!.elements!.find((e) => e.type === "chart")!.chart!;
    expect(c.series).toHaveLength(MAX_CHART_SERIES - 1);
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain("séries");
  });
});
