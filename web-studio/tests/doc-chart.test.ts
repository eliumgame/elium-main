// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { docToDocx, docxToDoc } from "../src/format/docx";
import { createEliumFile, createDocumentModel } from "../src/format/document";
import { docToHtml, docToMarkdown, docToText } from "../src/export/exporters";
import { chartDataOf, chartSvg } from "../src/editor/chartData";
import type { ProseMirrorNode } from "../src/format/types";

const chart = (attrs: Record<string, unknown> = {}): ProseMirrorNode => ({
  type: "docChart",
  attrs: {
    chartType: "bar",
    title: "Ventes 2026",
    labels: ["T1", "T2", "T3"],
    series: [
      { label: "Nord", values: [10, 20, 15] },
      { label: "Sud", values: [5, 8, 12] },
    ],
    opts: { grouping: "stacked", yTitle: "k€", legend: "top" },
    widthMm: 140,
    heightMm: 80,
    ...attrs,
  },
});
const docOf = (...c: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content: c });
const find = (n: ProseMirrorNode, type: string): ProseMirrorNode | undefined =>
  n.type === type ? n : (n.content ?? []).map((c) => find(c, type)).find(Boolean);

describe("graphique de document", () => {
  it("rendu SVG statique avec titre, séries et options", () => {
    const svg = chartSvg(chartDataOf(chart().attrs));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Ventes 2026");
    expect(svg).toContain("k€");
    expect(svg).toContain("Nord");
  });
  it("exports HTML (SVG), Markdown et texte (tableau de données)", () => {
    const model = createDocumentModel(docOf(chart()));
    expect(docToHtml(model)).toContain('<figure class="elium-doc-chart"><svg');
    const md = docToMarkdown(model);
    expect(md).toContain("**Ventes 2026**");
    expect(md).toContain("| Nord | Sud |");
    expect(md).toContain("| T2 | 20 | 8 |");
    expect(docToText(model)).toContain("T3\t15\t12");
  });
  it("DOCX : vrai graphique Word (partie c:chart, relation, type de contenu)", async () => {
    const f = await createEliumFile({ title: "G", doc: docOf(chart()) });
    const zip = unzipSync(docToDocx(f));
    expect(zip["word/charts/chart1.xml"]).toBeTruthy();
    const xml = strFromU8(zip["word/charts/chart1.xml"]!);
    expect(xml).toContain("<c:barChart>");
    expect(xml).toContain('<c:grouping val="stacked"/>');
    expect(xml).toContain("<c:strLit>");
    expect(strFromU8(zip["[Content_Types].xml"]!)).toContain("/word/charts/chart1.xml");
    expect(strFromU8(zip["word/_rels/document.xml.rels"]!)).toContain("charts/chart1.xml");
    expect(strFromU8(zip["word/document.xml"]!)).toContain("<c:chart ");
  });
  it("DOCX aller-retour : données, type, titre, options et taille conservés", async () => {
    const f = await createEliumFile({ title: "G", doc: docOf(chart({ chartType: "combo", opts: { seriesTypes: ["bar", "line"], secondary: [1], y2Title: "%" } })) });
    const back = find(docxToDoc(docToDocx(f)).doc, "docChart")!;
    expect(back).toBeTruthy();
    const d = chartDataOf(back.attrs);
    expect(d.chartType).toBe("combo");
    expect(d.title).toBe("Ventes 2026");
    expect(d.labels).toEqual(["T1", "T2", "T3"]);
    expect(d.series).toEqual([
      { label: "Nord", values: [10, 20, 15] },
      { label: "Sud", values: [5, 8, 12] },
    ]);
    expect(d.opts).toEqual({ seriesTypes: ["bar", "line"], secondary: [1], y2Title: "%" });
    expect(d.widthMm).toBe(140);
    expect(d.heightMm).toBe(80);
  });
  it("nuage de points avec abscisses numériques", async () => {
    const f = await createEliumFile({
      title: "G",
      doc: docOf(chart({ chartType: "scatter", opts: null, labels: ["1", "2", "4"], series: [{ label: "y", values: [1, 4, 16] }] })),
    });
    const xml = strFromU8(unzipSync(docToDocx(f))["word/charts/chart1.xml"]!);
    expect(xml).toContain("<c:scatterChart>");
    expect(xml).toContain("<c:xVal>");
  });
});
