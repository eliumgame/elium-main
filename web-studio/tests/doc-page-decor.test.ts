import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { docToDocx, docxToDoc } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import { groupLineTops, lineNumberLabels, normalizeBackground, normalizeBorder, pgBordersXml, lnNumTypeXml } from "../src/editor/pageDecor";

describe("apparence de la page", () => {
  it("normalisation défensive", () => {
    expect(normalizeBackground("#ABCDEF")).toBe("#abcdef");
    expect(normalizeBackground("rouge")).toBeUndefined();
    expect(normalizeBorder({ style: "zigzag", widthPt: 99, color: "x", offsetMm: 0 })).toEqual({ style: "solid", widthPt: 12, color: "#1e293b", offsetMm: 2 });
    expect(normalizeBorder(null)).toBeUndefined();
  });
  it("numéros de ligne : continu, par page, pas", () => {
    const tops = [10, 30, 50, 110, 130];
    const pages = [{ top: 0, height: 100 }, { top: 100, height: 100 }];
    expect(lineNumberLabels(tops, pages, { mode: "continuous", step: 1 }).map((l) => l.n)).toEqual([1, 2, 3, 4, 5]);
    expect(lineNumberLabels(tops, pages, { mode: "page", step: 1 }).map((l) => l.n)).toEqual([1, 2, 3, 1, 2]);
    expect(lineNumberLabels(tops, null, { mode: "continuous", step: 2 }).map((l) => l.n)).toEqual([2, 4]);
  });
  it("regroupe les fragments d'une même ligne", () => {
    expect(groupLineTops([10, 11, 29, 30, 52])).toEqual([10, 29, 52]);
  });
  it("OOXML", () => {
    expect(pgBordersXml({ style: "double", widthPt: 1, color: "#112233", offsetMm: 10 })).toContain('w:val="double"');
    expect(lnNumTypeXml({ mode: "page", step: 5 })).toBe('<w:lnNumType w:countBy="5" w:restart="newPage"/>');
  });
  it("DOCX aller-retour : fond, bordure, numéros de ligne", async () => {
    const f = await createEliumFile({
      title: "P",
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] },
      page: { background: "#fff7e0", pageBorder: { style: "dashed", widthPt: 2, color: "#aa0000", offsetMm: 8 }, lineNumbers: { mode: "page", step: 5 } },
    });
    const bytes = docToDocx(f);
    const xml = strFromU8(unzipSync(bytes)["word/document.xml"]!);
    expect(xml).toContain('<w:background w:color="FFF7E0"/>');
    expect(xml).toContain("<w:pgBorders");
    expect(xml).toContain("<w:lnNumType");
    const back = docxToDoc(bytes).page!;
    expect(back.background).toBe("#fff7e0");
    expect(back.pageBorder).toMatchObject({ style: "dashed", widthPt: 2, color: "#aa0000" });
    expect(Math.round(back.pageBorder!.offsetMm)).toBe(8);
    expect(back.lineNumbers).toEqual({ mode: "page", step: 5 });
  });
});
