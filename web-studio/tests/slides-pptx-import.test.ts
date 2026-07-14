import { describe, it, expect } from "vitest";
import { deckToPptx } from "../src/slides/pptx";
import { importPptx } from "../src/slides/pptx-import";
import type { Deck, SlideElement } from "../src/slides/model";

// 1x1 transparent PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQCB4+O0AAAAAElFTkSuQmCC";

function deck(): Deck {
  const els: SlideElement[] = [
    { id: "t1", type: "text", x: 8, y: 6, w: 80, h: 16, html: "<p><b>Titre</b> important</p>", fontSize: 40, color: "#0f172a", align: "center", valign: "top" },
    { id: "t2", type: "text", x: 10, y: 30, w: 60, h: 30, html: "<ul><li>Point A</li><li>Point <i>B</i></li></ul>", fontSize: 24 },
    { id: "s1", type: "shape", x: 40, y: 40, w: 20, h: 20, shape: "star", fill: "#bfdbfe", stroke: "#2563eb", strokeWidth: 2, rotation: 15 },
    { id: "s2", type: "shape", x: 5, y: 70, w: 30, h: 12, shape: "roundRect", fill: "#fde68a", stroke: "#ca8a04", strokeWidth: 3, radius: 20, text: "Étiquette" },
    { id: "s3", type: "shape", x: 60, y: 75, w: 35, h: 6, shape: "arrow", fill: "transparent", stroke: "#0f172a", strokeWidth: 4 },
    { id: "im", type: "image", x: 70, y: 10, w: 20, h: 20, src: PNG },
  ];
  return {
    active: 0, theme: "light", transition: "fade",
    slides: [
      { id: "sl1", title: "", body: "", bodyHtml: "", layout: "blank", elements: els, background: "#f0f9ff" },
      { id: "sl2", title: "", body: "", bodyHtml: "", layout: "blank", elements: [
        { id: "x", type: "text", x: 10, y: 44, w: 80, h: 12, html: "<p>Deuxième diapo</p>", fontSize: 32 },
      ] },
      { id: "sl3", title: "", body: "", bodyHtml: "", layout: "blank", elements: [
        { id: "tb", type: "table", x: 10, y: 20, w: 60, h: 30, fontSize: 18, color: "#0f172a", table: { rows: 2, cols: 2, cells: [["A", "B"], ["1", "2"]] } },
        { id: "ch", type: "chart", x: 10, y: 60, w: 40, h: 30, chart: { kind: "bar", labels: ["X", "Y"], values: [3, 7], title: "Ventes" } },
      ] },
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

  it("round-trips a table and degrades a chart to a placeholder shape", () => {
    const e = d2.slides[2]!.elements!;
    const tbl = e.find((x) => x.type === "table");
    expect(tbl).toBeTruthy();
    expect(tbl!.table!.cells).toEqual([["A", "B"], ["1", "2"]]);
    // charts export as a titled placeholder (native c:chart is out of scope) →
    // they come back as a rounded-rectangle shape carrying the title.
    const deg = e.find((x) => x.type === "shape" && x.shape === "roundRect");
    expect(deg).toBeTruthy();
    expect(deg!.text).toBe("Ventes");
  });

  it("recovers the slide background colour", () => {
    expect(d2.slides[0]!.background?.toLowerCase()).toBe("#f0f9ff");
  });

  it("recovers element types, shape kinds and geometry", () => {
    const e = d2.slides[0]!.elements!;
    // order preserved
    expect(e.map((x) => x.type)).toEqual(["text", "text", "shape", "shape", "shape", "image"]);
    const star = e[2]!, round = e[3]!, arrow = e[4]!, img = e[5]!;
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
