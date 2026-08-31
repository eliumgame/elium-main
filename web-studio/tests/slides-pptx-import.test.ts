import { describe, it, expect } from "vitest";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { deckToPptx } from "../src/slides/pptx";
import { importPptx } from "../src/slides/pptx-import";
import type { Deck, SlideElement } from "../src/slides/model";

// 1x1 transparent PNG.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQCB4+O0AAAAAElFTkSuQmCC";

function deck(): Deck {
  const els: SlideElement[] = [
    {
      id: "t1",
      type: "text",
      x: 8,
      y: 6,
      w: 80,
      h: 16,
      html: "<p><b>Titre</b> important</p>",
      fontSize: 40,
      color: "#0f172a",
      align: "center",
      valign: "top",
    },
    {
      id: "t2",
      type: "text",
      x: 10,
      y: 30,
      w: 60,
      h: 30,
      html: "<ul><li>Point A</li><li>Point <i>B</i></li></ul>",
      fontSize: 24,
    },
    {
      id: "s1",
      type: "shape",
      x: 40,
      y: 40,
      w: 20,
      h: 20,
      shape: "star",
      fill: "#bfdbfe",
      stroke: "#2563eb",
      strokeWidth: 2,
      rotation: 15,
    },
    {
      id: "s2",
      type: "shape",
      x: 5,
      y: 70,
      w: 30,
      h: 12,
      shape: "roundRect",
      fill: "#fde68a",
      stroke: "#ca8a04",
      strokeWidth: 3,
      radius: 20,
      text: "Étiquette",
    },
    {
      id: "s3",
      type: "shape",
      x: 60,
      y: 75,
      w: 35,
      h: 6,
      shape: "arrow",
      fill: "transparent",
      stroke: "#0f172a",
      strokeWidth: 4,
    },
    { id: "im", type: "image", x: 70, y: 10, w: 20, h: 20, src: PNG },
  ];
  return {
    active: 0,
    theme: "light",
    transition: "fade",
    slides: [
      { id: "sl1", title: "", body: "", bodyHtml: "", layout: "blank", elements: els, background: "#f0f9ff" },
      {
        id: "sl2",
        title: "",
        body: "",
        bodyHtml: "",
        layout: "blank",
        elements: [{ id: "x", type: "text", x: 10, y: 44, w: 80, h: 12, html: "<p>Deuxième diapo</p>", fontSize: 32 }],
      },
      {
        id: "sl3",
        title: "",
        body: "",
        bodyHtml: "",
        layout: "blank",
        elements: [
          {
            id: "tb",
            type: "table",
            x: 10,
            y: 20,
            w: 60,
            h: 30,
            fontSize: 18,
            color: "#0f172a",
            table: {
              rows: 2,
              cols: 2,
              cells: [
                ["A", "B"],
                ["1", "2"],
              ],
            },
          },
          {
            id: "ch",
            type: "chart",
            x: 10,
            y: 60,
            w: 40,
            h: 30,
            chart: { kind: "bar", labels: ["X", "Y"], values: [3, 7], title: "Ventes" },
          },
        ],
      },
    ],
  };
}

const near = (a: number, b: number, tol = 0.6) => Math.abs(a - b) <= tol;

describe("PPTX import (round-trip through the exporter)", () => {
  const d2 = importPptx(deckToPptx(deck()));

  it("recovers slide count and per-slide element count", () => {
    expect(d2.slides.length).toBe(3);
    expect(d2.slides[0]!.elements!.length).toBe(6);
    expect(d2.slides[1]!.elements!.length).toBe(1);
  });

  it("round-trips a table and a native chart (c:chart, editable)", () => {
    const e = d2.slides[2]!.elements!;
    const tbl = e.find((x) => x.type === "table");
    expect(tbl).toBeTruthy();
    expect(tbl!.table!.cells).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
    // Charts now export as a native <c:chart> part and come back as a real
    // chart element (kind, labels, values and title preserved).
    const chart = e.find((x) => x.type === "chart");
    expect(chart).toBeTruthy();
    expect(chart!.chart!.kind).toBe("bar");
    expect(chart!.chart!.labels).toEqual(["X", "Y"]);
    expect(chart!.chart!.values).toEqual([3, 7]);
    expect(chart!.chart!.title).toBe("Ventes");
  });

  it("recovers the slide background colour", () => {
    expect(d2.slides[0]!.background?.toLowerCase()).toBe("#f0f9ff");
  });

  it("recovers element types, shape kinds and geometry", () => {
    const e = d2.slides[0]!.elements!;
    // order preserved
    expect(e.map((x) => x.type)).toEqual(["text", "text", "shape", "shape", "shape", "image"]);
    const star = e[2]!,
      round = e[3]!,
      arrow = e[4]!,
      img = e[5]!;
    expect(star.shape).toBe("star");
    expect(round.shape).toBe("roundRect");
    expect(arrow.shape).toBe("arrow");
    expect(img.type).toBe("image");
    // geometry within rounding tolerance
    expect(near(star.x, 40) && near(star.y, 40) && near(star.w, 20) && near(star.h, 20)).toBe(true);
    expect(star.rotation).toBe(15);
    expect(round.radius).toBe(20);
    expect(arrow.strokeWidth).toBe(4);
  });

  it("recovers text content (bold/italic + bullets)", () => {
    const [t1, t2] = d2.slides[0]!.elements!;
    expect(t1!.type).toBe("text");
    expect(t1!.html).toContain("<b>Titre</b>");
    expect(t1!.html).toContain("important");
    expect(t1!.align).toBe("center");
    expect(Math.abs((t1!.fontSize ?? 0) - 40)).toBeLessThanOrEqual(1);
    expect(t2!.html).toContain("<li>");
    expect(t2!.html).toContain("Point A");
    expect(t2!.html).toContain("<i>B</i>");
  });

  it("recovers the shape label and embedded image", () => {
    const round = d2.slides[0]!.elements![3]!;
    expect(round.text).toBe("Étiquette");
    const img = d2.slides[0]!.elements![5]!;
    expect(img.src?.startsWith("data:image/png;base64,")).toBe(true);
  });
});

describe("PPTX import — chart type detection", () => {
  // Single-slide deck with one bar chart, used as a vehicle to get a real
  // ppt/charts/chart1.xml part inside a real .pptx zip; the tests below then
  // swap that part's raw XML to simulate chart types PowerPoint can produce
  // that pptx.ts itself never exports (bar/line/pie only).
  const chartDeck = (): Deck => ({
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
        elements: [
          {
            id: "ch",
            type: "chart",
            x: 10,
            y: 10,
            w: 40,
            h: 30,
            chart: { kind: "bar", labels: ["X", "Y"], values: [3, 7], title: "Ventes" },
          },
        ],
      },
    ],
  });

  function withChartXml(xml: string): Uint8Array {
    const zip = unzipSync(deckToPptx(chartDeck()));
    zip["ppt/charts/chart1.xml"] = strToU8(xml);
    return zipSync(zip);
  }

  const ser = (tag: string) =>
    `<${tag}><c:ser><c:cat><c:strLit><c:pt idx="0"><c:v>X</c:v></c:pt><c:pt idx="1"><c:v>Y</c:v></c:pt></c:strLit></c:cat>` +
    `<c:val><c:numLit><c:pt idx="0"><c:v>3</c:v></c:pt><c:pt idx="1"><c:v>7</c:v></c:pt></c:numLit></c:val></c:ser></${tag}>`;
  const chartSpace = (plot: string) => `<c:chartSpace><c:chart><c:plotArea>${plot}</c:plotArea></c:chart></c:chartSpace>`;

  it("maps a doughnut chart onto the supported pie kind (real equivalent, not a mislabel)", () => {
    const bytes = withChartXml(chartSpace(ser("c:doughnutChart")));
    const warnings: string[] = [];
    const d = importPptx(bytes, (w) => warnings.push(w));
    const chart = d.slides[0]!.elements!.find((e) => e.type === "chart");
    expect(chart?.chart?.kind).toBe("pie");
    expect(chart?.chart?.values).toEqual([3, 7]);
    expect(warnings).toEqual([]);
  });

  it("warns instead of mislabeling an area chart as bar, and drops the element", () => {
    const bytes = withChartXml(chartSpace(ser("c:areaChart")));
    const warnings: string[] = [];
    const d = importPptx(bytes, (w) => warnings.push(w));
    expect(d.slides[0]!.elements!.some((e) => e.type === "chart")).toBe(false);
    expect(warnings).toEqual(["aire"]);
  });

  it("warns for a scatter chart", () => {
    const bytes = withChartXml(chartSpace(ser("c:scatterChart")));
    const warnings: string[] = [];
    const d = importPptx(bytes, (w) => warnings.push(w));
    expect(d.slides[0]!.elements!.some((e) => e.type === "chart")).toBe(false);
    expect(warnings).toEqual(["nuage de points"]);
  });

  it("warns 'combiné' for a combo chart mixing two plotted types", () => {
    const bytes = withChartXml(chartSpace(ser("c:barChart") + ser("c:lineChart")));
    const warnings: string[] = [];
    const d = importPptx(bytes, (w) => warnings.push(w));
    expect(d.slides[0]!.elements!.some((e) => e.type === "chart")).toBe(false);
    expect(warnings).toEqual(["combiné"]);
  });

  it("never calls onWarning for a normal bar/line/pie import", () => {
    const warnings: string[] = [];
    importPptx(deckToPptx(chartDeck()), (w) => warnings.push(w));
    expect(warnings).toEqual([]);
  });
});

describe("PPTX import — extended shape preset catalogue", () => {
  // A single rect shape exported for real, then its <a:prstGeom prst="rect">
  // is swapped for other PowerPoint preset names to exercise PRST_TO_KIND
  // entries pptx.ts itself never emits (bar/line/pie-style round-trips can't
  // reach them, since Élium only ever exports its own closed ShapeKind set).
  const shapeDeck = (): Deck => ({
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
        elements: [
          { id: "sh", type: "shape", x: 10, y: 10, w: 20, h: 20, shape: "rect", fill: "#fff", stroke: "#000" },
        ],
      },
    ],
  });

  function withPrst(prst: string): Uint8Array {
    const zip = unzipSync(deckToPptx(shapeDeck()));
    const slide = new TextDecoder().decode(zip["ppt/slides/slide1.xml"]!);
    zip["ppt/slides/slide1.xml"] = strToU8(slide.replace('prst="rect"', `prst="${prst}"`));
    return zipSync(zip);
  }

  it.each([
    ["rtTriangle", "triangle"],
    ["round2SameRect", "roundRect"],
    ["plaque", "roundRect"],
    ["rightArrow", "arrow"],
    ["star8", "star"],
    ["sun", "star"],
  ] as const)("maps prst=%s onto ShapeKind %s", (prst, kind) => {
    const d = importPptx(withPrst(prst));
    expect(d.slides[0]!.elements![0]!.shape).toBe(kind);
  });

  it("still degrades a wholly unknown/custom preset to rect", () => {
    const d = importPptx(withPrst("someFuturePptxPreset"));
    expect(d.slides[0]!.elements![0]!.shape).toBe("rect");
  });
});
