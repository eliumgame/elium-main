// @vitest-environment jsdom
// Must be the very first import — see pdfjs-node-shim.ts for why. jsdom: the
// HTML sanitiser and the xlsx importer use the browser's DOMParser.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, PDFName, PDFArray, PDFDict } from "pdf-lib";
import { docToDocx } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import type { ProseMirrorNode } from "../src/format/types";
import { workbookToXlsx } from "../src/sheet/xlsx-export";
import { importXlsx } from "../src/sheet/xlsx-import";
import type { Workbook } from "../src/sheet/model";
import {
  A4_PT,
  assemblePdf,
  createSourceKind,
  decodeText,
  docxSource,
  eliumSource,
  markdownSource,
  planPageSlices,
  sanitiseCss,
  sanitiseHtml,
  textToPdfDocument,
  wordsToLines,
  workbookSource,
  type WordBox,
} from "../src/pdf/ops/create-from-file";

/** « Créer un PDF depuis un fichier »: the parts that need no browser layout. */

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

// A 1×1 white PNG.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC"),
  (c) => c.charCodeAt(0),
);

interface TextItem {
  str: string;
  transform: number[];
  width: number;
}

async function pageTexts(bytes: Uint8Array): Promise<TextItem[][]> {
  const task = pdfjsLib.getDocument({ data: bytes.slice() });
  const pdf = await task.promise;
  const out: TextItem[][] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    out.push((tc.items as TextItem[]).filter((it) => "str" in it));
  }
  await task.destroy();
  return out;
}

const text = (s: string): ProseMirrorNode => ({ type: "text", text: s });
const para = (s: string): ProseMirrorNode => ({ type: "paragraph", content: [text(s)] });
const cell = (type: string, s: string): ProseMirrorNode => ({ type, content: [para(s)] });

describe("sources", () => {
  it("recognises the files it can convert by their extension", () => {
    expect(createSourceKind("Rapport.DOCX")).toBe("docx");
    expect(createSourceKind("budget.xlsx")).toBe("xlsx");
    expect(createSourceKind("deck.pptx")).toBe("pptx");
    expect(createSourceKind("page.htm")).toBe("html");
    expect(createSourceKind("notes.md")).toBe("markdown");
    expect(createSourceKind("lisez-moi.txt")).toBe("text");
    expect(createSourceKind("contrat.elium")).toBe("elium");
    expect(createSourceKind("photo.png")).toBeNull();
    expect(createSourceKind("archive.doc")).toBeNull();
  });

  it("a Word document becomes HTML with its headings, paragraph and table, on A4", async () => {
    const doc: ProseMirrorNode = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [text("Rapport annuel")] },
        para("Le chiffre d'affaires progresse nettement."),
        { type: "heading", attrs: { level: 2 }, content: [text("Résultats")] },
        {
          type: "table",
          content: [
            { type: "tableRow", content: [cell("tableHeader", "Trimestre"), cell("tableHeader", "Ventes")] },
            { type: "tableRow", content: [cell("tableCell", "T1"), cell("tableCell", "1 200")] },
          ],
        },
      ],
    };
    const file = await createEliumFile({ title: "Rapport", doc });
    const bytes = docToDocx(file);
    const src = docxSource(bytes, "Rapport.docx");
    expect(src.layout).toBe("flow");
    expect(src.body).toMatch(/<h1[^>]*>Rapport annuel<\/h1>/);
    expect(src.body).toMatch(/<h2[^>]*>Résultats<\/h2>/);
    expect(src.body).toContain("Le chiffre d'affaires progresse nettement.");
    expect(src.body).toMatch(/<table[\s\S]*Trimestre[\s\S]*Ventes[\s\S]*T1[\s\S]*1 200[\s\S]*<\/table>/);
    // The export's own title heading is not added on top of the document's.
    expect(src.body).not.toMatch(/^\s*<h1><\/h1>/);
    expect(src.page.width).toBeCloseTo(A4_PT[0], 0);
    expect(src.page.height).toBeCloseTo(A4_PT[1], 0);
    // The export's centred screen column is undone for the page.
    expect(src.css).toContain("max-width:none!important");
    const landscape = docxSource(bytes, "Rapport.docx", "landscape");
    expect(landscape.page.width).toBeCloseTo(A4_PT[1], 0);
  });

  it("an Elium document keeps its title, header, footer and page numbers", async () => {
    const file = await createEliumFile({
      title: "Contrat de bail",
      doc: { type: "doc", content: [para("Article 1")] },
    });
    file.document.page = { ...file.document.page, header: "{titre}", footer: "Confidentiel", showPageNumbers: true };
    const src = eliumSource(file);
    expect(src.title).toBe("Contrat de bail");
    expect(src.body).toContain("<h1>Contrat de bail</h1>");
    expect(src.decorations).toEqual({ header: "{titre}", footer: "Confidentiel", pageNumbers: true });
  });

  it("Markdown goes through the document importer (title from its first heading)", () => {
    const src = markdownSource("# Notes de réunion\n\n- point **un**\n- point deux\n", "notes.md");
    expect(src.title).toBe("Notes de réunion");
    expect(src.body).toMatch(/<h1[^>]*>Notes de réunion<\/h1>/);
    expect(src.body).toMatch(/<li>[\s\S]*<strong>un<\/strong>/);
  });

  it("a workbook becomes one table per sheet with values as displayed, widths and merges", () => {
    const wb: Workbook = {
      active: 0,
      sheets: [
        {
          name: "Ventes",
          rows: 20,
          cols: 8,
          cells: { A1: "Produit", B1: "Prix", A2: "Pommes", B2: "3.5", C2: "=B2*2", A4: "Total fusionné" },
          styles: { B2: { fmt: "currency" }, A1: { bold: true } },
          merges: [{ c0: 0, r0: 3, c1: 2, r1: 3 }],
          colWidths: { 0: 150 },
        },
        { name: "Vide", rows: 20, cols: 8, cells: {} },
        { name: "Notes", rows: 20, cols: 8, cells: { A1: "Remarque" } },
      ],
    };
    const src = workbookSource(importXlsx(workbookToXlsx(wb)), "budget.xlsx");
    expect(src.title).toBe("budget");
    // Empty sheets are left out; each other sheet is a section starting a new page.
    expect(src.body.match(/<section class="xs /g)).toHaveLength(2);
    expect(src.css).toContain(".xs + .xs{break-before:page}");
    expect(src.body).toContain(">Ventes</h2>");
    expect(src.body).toContain(">Notes</h2>");
    expect(src.body).toContain(">Pommes</td>");
    // Number format as displayed (fr-FR currency), formula computed.
    expect(src.body).toMatch(/>3,50\s€<\/td>/);
    expect(src.body).toContain(">7</td>");
    expect(src.body).toContain('colspan="3"');
    expect(src.body).toMatch(/<col style="width:150px">/);
    expect(src.body).toMatch(/font-weight:700[^>]*>Produit</);
    expect(src.page.width).toBeLessThan(src.page.height);
  });

  it("a sheet wider than a portrait page is printed landscape unless asked otherwise", () => {
    const cells: Record<string, string> = {};
    const colWidths: Record<number, number> = {};
    for (let c = 0; c < 12; c++) {
      cells[`${String.fromCharCode(65 + c)}1`] = `Col ${c}`;
      colWidths[c] = 110;
    }
    const wb: Workbook = { active: 0, sheets: [{ name: "Large", rows: 5, cols: 12, cells, colWidths }] };
    expect(workbookSource(wb, "large.xlsx").page.width).toBeCloseTo(A4_PT[1], 0);
    expect(workbookSource(wb, "large.xlsx", "portrait").page.width).toBeCloseTo(A4_PT[0], 0);
  });
});

describe("HTML files are made safe", () => {
  it("drops scripts, handlers, javascript: links, frames and pictures from elsewhere", () => {
    const s = sanitiseHtml(`<!doctype html><html lang="en"><head><title>Ma page</title>
      <style>@import url(http://evil/x.css); body{background:url(https://evil/bg.png)} .a{background:url(data:image/png;base64,AAAA)}</style>
      <script>alert(1)</script><link rel="stylesheet" href="http://evil/s.css"></head>
      <body onload="steal()"><h1 onclick="x()">Titre</h1>
      <img src="https://tracker.example/pixel.gif" alt="logo distant"><img src="data:image/png;base64,AAAA" alt="local">
      <a href="javascript:alert(1)">piège</a><a href="https://example.org/">lien</a>
      <iframe src="https://example.org"></iframe><p style="background-image:url(http://evil/p.png);color:red">texte</p>
      <svg><image href="https://evil/i.png"/></svg></body></html>`);
    expect(s.title).toBe("Ma page");
    expect(s.lang).toBe("en");
    expect(s.body).not.toMatch(/script|onload|onclick|iframe|javascript:|evil|tracker/);
    expect(s.body).toContain("logo distant");
    expect(s.body).toContain('src="data:image/png;base64,AAAA"');
    expect(s.body).toContain('href="https://example.org/"');
    expect(s.body).toContain("color:red");
    expect(s.css).not.toMatch(/@import|evil/);
    expect(s.css).toContain("url(data:image/png;base64,AAAA)");
    expect(sanitiseCss("a{b:url('http://x/y')}")).toBe("a{b:none}");
  });
});

describe("page breaks", () => {
  const lines = (from: number, to: number, h = 20) =>
    Array.from({ length: Math.floor((to - from) / h) }, (_, i) => ({ top: from + i * h, bottom: from + i * h + 16 }));

  it("never cuts a line: a page ends at the top of the first line that would cross it", () => {
    const boxes = lines(0, 1000);
    const slices = planPageSlices({ end: 996, pageHeight: 250, boxes });
    expect(slices.length).toBe(5);
    for (const s of slices) {
      expect(s.bottom - s.top).toBeLessThanOrEqual(250);
      for (const b of boxes) expect(b.top < s.bottom && b.bottom > s.bottom + 0.5).toBe(false);
    }
    expect(slices[0]).toEqual({ top: 0, bottom: 240 });
    expect(slices[slices.length - 1].bottom).toBe(996);
  });

  it("honours forced breaks and drops the empty pages they would leave", () => {
    const boxes = [...lines(0, 100), ...lines(300, 400)];
    const slices = planPageSlices({ end: 400, pageHeight: 1000, boxes, forced: [150, 160] });
    expect(slices).toEqual([
      { top: 0, bottom: 150 },
      { top: 160, bottom: 400 },
    ]);
  });

  it("cuts through what is taller than a page, which starts a page", () => {
    const boxes = [
      { top: 0, bottom: 16 },
      { top: 40, bottom: 720 },
    ];
    const slices = planPageSlices({ end: 720, pageHeight: 300, boxes });
    expect(slices.map((s) => [s.top, s.bottom])).toEqual([
      [0, 40],
      [40, 340],
      [340, 640],
      [640, 720],
    ]);
  });

  it("an empty source still has one page", () => {
    expect(planPageSlices({ end: 0, pageHeight: 300, boxes: [] })).toHaveLength(1);
  });
});

describe("text layer", () => {
  it("groups words into lines by baseline and size", () => {
    const w = (text: string, x: number, y: number, size = 10): WordBox => ({
      text,
      x,
      y,
      w: text.length * size * 0.5,
      h: size * 1.15,
      fontSize: size,
    });
    const lines = wordsToLines([w("Bonjour", 72, 100), w("le", 112, 100), w("monde", 126, 100), w("Suite", 72, 114)]);
    expect(lines).toHaveLength(2);
    expect(lines[0].words.map((x) => x.text)).toEqual(["Bonjour", "le", "monde"]);
    expect(lines[0].height).toBeCloseTo(10 / 0.95, 5);
    expect(lines[1].words.map((x) => x.text)).toEqual(["Suite"]);
  });

  it("writes the measured words as invisible text at their positions, with links and title", async () => {
    const words: WordBox[] = [
      { text: "Bonjour", x: 72, y: 100, w: 40, h: 13.8, fontSize: 12 },
      { text: "tout", x: 116, y: 100, w: 22, h: 13.8, fontSize: 12 },
      { text: "Seconde", x: 72, y: 400, w: 44, h: 13.8, fontSize: 12 },
      { text: "ligne", x: 120, y: 400, w: 26, h: 13.8, fontSize: 12 },
      { text: "Élan", x: 72, y: 420, w: 24, h: 13.8, fontSize: 12 },
    ];
    const bytes = await assemblePdf(
      [
        {
          width: A4_PT[0],
          height: A4_PT[1],
          image: { bytes: PNG, type: "png" },
          words,
          links: [
            { x: 72, y: 100, w: 40, h: 14, uri: "https://example.org/" },
            { x: 72, y: 400, w: 44, h: 14, dest: { page: 1, y: 50 } },
          ],
        },
        { width: A4_PT[0], height: A4_PT[1], image: { bytes: PNG, type: "png" }, words: [], links: [] },
      ],
      { title: "Essai", lang: "fr", creator: "Elium — Word", decorations: { pageNumbers: true } },
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getTitle()).toBe("Essai");
    expect(doc.getCreator()).toBe("Elium — Word");
    const annots = doc.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
    expect(annots.size()).toBe(2);
    const first = annots.lookup(0, PDFDict);
    expect(first.lookup(PDFName.of("A"), PDFDict).get(PDFName.of("URI"))?.toString()).toContain("example.org");

    const pages = await pageTexts(bytes);
    const joined = pages[0].map((i) => i.str).join("");
    expect(joined).toContain("Bonjour");
    expect(joined).toContain("Seconde");
    expect(joined).toContain("Élan");
    const at = (s: string) => pages[0].find((i) => i.str.includes(s))!;
    const bonjour = at("Bonjour");
    expect(bonjour.transform[4]).toBeCloseTo(72, 0);
    // Baseline a fifth of the box above its bottom, in PDF space (y up).
    expect(bonjour.transform[5]).toBeCloseTo(A4_PT[1] - (100 + 13.8 * 0.8), 0);
    expect(at("Seconde").transform[5]).toBeCloseTo(A4_PT[1] - (400 + 13.8 * 0.8), 0);
    // Page numbers are real text.
    expect(pages[1].map((i) => i.str).join("")).toContain("Page 2 / 2");
  });
});

describe("plain text", () => {
  it("is written as real text, one page per form feed at least, in either orientation", async () => {
    const body = `Première ligne\n${"mot ".repeat(400)}\n\fAprès le saut`;
    const bytes = await textToPdfDocument(body, "notes", "landscape");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeGreaterThan(height);
    const pages = await pageTexts(bytes);
    expect(pages[0].map((i) => i.str).join(" ")).toContain("Première ligne");
    expect(pages[pages.length - 1].map((i) => i.str).join(" ")).toContain("Après le saut");
  });

  it("reads UTF-8, and Windows-1252 when the file is not UTF-8", () => {
    expect(decodeText(new TextEncoder().encode("﻿Été"))).toBe("Été");
    expect(decodeText(Uint8Array.from([0xc9, 0x74, 0xe9]))).toBe("Été");
  });
});
