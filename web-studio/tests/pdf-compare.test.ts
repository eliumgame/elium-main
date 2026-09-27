// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { zlibSync } from "fflate";
import { PdfEngine } from "../src/pdf/core/engine";
import type { PageText } from "../src/pdf/ops/export";
import { allItems, comparePages, compareLayouts, type DiffItem } from "../src/pdf/ops/compare";
import {
  compareFiles,
  compareVisual,
  diffBitmaps,
  unexplainedRegions,
  type Bitmap,
  type PageRasteriser,
} from "../src/pdf/ops/compare-visual";
import { buildCompareReport } from "../src/pdf/ops/compare-report";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

/** « Comparer des fichiers »: formatting, moved pages, picture differences, the PDF report. */

type Line = { text: string; bold?: boolean; size?: number; red?: boolean };

async function pdfOf(pages: Line[][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const lines of pages) {
    const p = doc.addPage([595, 842]);
    lines.forEach((l, i) =>
      p.drawText(l.text, {
        x: 60,
        y: 760 - i * 30,
        size: l.size ?? 12,
        font: l.bold ? bold : regular,
        color: l.red ? rgb(0.8, 0, 0) : rgb(0, 0, 0),
      }),
    );
  }
  return doc.save();
}

async function withEngines<T>(a: Uint8Array, b: Uint8Array, run: (l: PdfEngine, r: PdfEngine) => Promise<T>) {
  const l = await PdfEngine.open(a);
  const r = await PdfEngine.open(b);
  try {
    return await run(l, r);
  } finally {
    l.destroy();
    r.destroy();
  }
}

/** A white bitmap with filled rectangles. */
function bitmap(
  w: number,
  h: number,
  boxes: { x: number; y: number; w: number; h: number; v?: number }[] = [],
): Bitmap {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const b of boxes)
    for (let y = b.y; y < b.y + b.h; y++)
      for (let x = b.x; x < b.x + b.w; x++) {
        const o = (y * w + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = b.v ?? 0;
      }
  return { width: w, height: h, data };
}

const emptyPage = (page: number): PageText => ({ page, lines: [], blocks: [] });

describe("compare — formatting", () => {
  it("same words, bold vs regular and a larger size, are formatting changes, not text changes", async () => {
    const before = await pdfOf([[{ text: "Le loyer mensuel est payable" }, { text: "Article deux du contrat" }]]);
    const after = await pdfOf([
      [
        { text: "Le loyer mensuel est payable", bold: true },
        { text: "Article deux du contrat", size: 16 },
      ],
    ]);
    const report = await withEngines(before, after, (l, r) => compareFiles(l, r));
    const items = allItems(report);
    expect(items.filter((i) => i.category === "text")).toHaveLength(0);
    const format = items.filter((i) => i.category === "format");
    expect(format).toHaveLength(2);
    expect(format[0].detail).toContain("gras ajouté");
    expect(format[0].right).toContain("loyer");
    expect(format[1].detail).toMatch(/taille 12 pt → 16 pt/);
    expect(report.formatChanges).toBe(2);
    expect(report.pagesModified).toBe(1);
    expect(report.pages[0].status).toBe("modified");
    // Boxes in page space (y down): the first line sits near the top, 60 pt from the left.
    const box = format[0].rightRects[0];
    expect(box.x).toBeCloseTo(60, 0);
    expect(box.y).toBeGreaterThan(60);
    expect(box.y).toBeLessThan(90);
    expect(format[1].rightRects[0].y).toBeGreaterThan(box.y);
  });

  it("a colour change is formatting; a changed word has boxes on both sides", async () => {
    const before = await pdfOf([[{ text: "Montant total de mille euros" }]]);
    const after = await pdfOf([[{ text: "Montant total de douze euros", red: true }]]);
    const report = await withEngines(before, after, (l, r) => compareFiles(l, r));
    const items = allItems(report);
    const text = items.find((i) => i.category === "text")!;
    expect(text.kind).toBe("replace");
    expect(text.left).toBe("mille");
    expect(text.right).toBe("douze");
    expect(text.leftRects).toHaveLength(1);
    expect(text.rightRects).toHaveLength(1);
    // « mille » is the 4th word: well right of the line start.
    expect(text.leftRects[0].x).toBeGreaterThan(120);
    const colour = items.find((i) => i.category === "format")!;
    expect(colour.detail).toContain("couleur #000000 → #cc0000");
  });

  it("identical documents have nothing to report", async () => {
    const bytes = await pdfOf([[{ text: "Rien ne change ici" }], [{ text: "Ni sur la seconde page" }]]);
    const report = await withEngines(bytes, bytes, (l, r) => compareFiles(l, r));
    expect(allItems(report)).toHaveLength(0);
    expect(report.pagesModified).toBe(0);
  });
});

describe("compare — moved pages", () => {
  const pages = [
    "Préambule du contrat entre les parties soussignées",
    "Article premier objet de la convention signée",
    "Article deux durée et résiliation anticipée",
    "Annexe technique liste des équipements fournis",
  ];

  it("the last page now first is moved, not added and removed", () => {
    const r = comparePages(pages, [pages[3], ...pages.slice(0, 3)]);
    expect(r.pagesAdded).toBe(0);
    expect(r.pagesRemoved).toBe(0);
    expect(r.pagesMoved).toBe(1);
    expect(r.pagesModified).toBe(0);
    const moved = r.pages.filter((p) => p.moved);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ leftPage: 4, rightPage: 1, status: "unchanged" });
    // Listed where it now is (the revised document's order).
    expect(r.pages[0].moved).toBe(true);
  });

  it("the first page now last is moved too, the others stay paired", () => {
    const r = comparePages(pages, [...pages.slice(1), pages[0]]);
    expect(r.pagesMoved).toBe(1);
    expect(r.pages.find((p) => p.moved)).toMatchObject({ leftPage: 1, rightPage: 4 });
    expect(r.pages.filter((p) => !p.moved).every((p) => p.leftPage! === p.rightPage! + 1)).toBe(true);
  });

  it("a moved page gets a « déplacée » item in the detailed report; large documents stay fast", () => {
    const layout = (texts: string[]): PageText[] =>
      texts.map((t, page) => ({
        page,
        blocks: [],
        lines: [
          {
            key: "l",
            text: t,
            rect: { x: 0, y: 0, w: 100, h: 10 },
            quad: [
              { x: 0, y: 0 },
              { x: 100, y: 0 },
              { x: 100, y: 10 },
              { x: 0, y: 10 },
            ],
            origin: { x: 0, y: 8 },
            fontSize: 10,
            angle: 0,
            bold: false,
            italic: false,
            charStart: 0,
            charEnd: t.length,
            runs: [
              {
                index: 0,
                str: t,
                origin: { x: 0, y: 8 },
                width: 100,
                fontSize: 10,
                angle: 0,
                dir: { x: 1, y: 0 },
                up: { x: 0, y: -1 },
                bold: false,
                italic: false,
                quad: [
                  { x: 0, y: 0 },
                  { x: 100, y: 0 },
                  { x: 100, y: 10 },
                  { x: 0, y: 10 },
                ],
                rect: { x: 0, y: 0, w: 100, h: 10 },
                hasEOL: false,
              },
            ],
          },
        ],
      }));
    const report = compareLayouts(layout(pages), layout([pages[3], ...pages.slice(0, 3)]));
    const moved = allItems(report).filter((i) => i.kind === "moved");
    expect(moved).toHaveLength(1);
    expect(moved[0].detail).toBe("Page déplacée de la position 4 à la position 1");

    const words = Array.from({ length: 400 }, (_, i) => `mot${i}`).join(" ");
    const L = Array.from({ length: 300 }, (_, i) => `page ${i} ${words}`);
    const t0 = Date.now();
    const big = comparePages(L, [L[299], ...L.slice(0, 299)]);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(big.pagesMoved).toBe(1);
    expect(big.pagesAdded + big.pagesRemoved).toBe(0);
  });
});

describe("compare — visual differences", () => {
  it("two separate changed rectangles are two regions", () => {
    const a = bitmap(200, 200);
    const b = bitmap(200, 200, [
      { x: 20, y: 20, w: 30, h: 20 },
      { x: 120, y: 140, w: 40, h: 30 },
    ]);
    const regions = diffBitmaps(a, b);
    expect(regions).toEqual([
      { x: 20, y: 20, w: 30, h: 20 },
      { x: 120, y: 140, w: 40, h: 30 },
    ]);
  });

  it("anti-aliasing noise and one-pixel edge shifts are not changes", () => {
    const a = bitmap(160, 160, [{ x: 40, y: 40, w: 50, h: 12, v: 20 }]);
    // Same box moved by one pixel, with grey anti-aliased edges and faint noise all over.
    const b = bitmap(160, 160, [
      { x: 41, y: 40, w: 50, h: 12, v: 20 },
      { x: 40, y: 40, w: 1, h: 12, v: 140 },
    ]);
    let seed = 7;
    for (let i = 0; i < b.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const d = (seed % 41) - 20;
      for (let c = 0; c < 3; c++) b.data[i + c] = b.data[i + c] + d;
    }
    expect(diffBitmaps(a, b)).toEqual([]);
    // A real change is still seen through the noise.
    const c = bitmap(160, 160, [{ x: 100, y: 100, w: 20, h: 20 }]);
    expect(diffBitmaps(a, c).length).toBeGreaterThanOrEqual(1);
  });

  it("masked text lines are ignored; a region touching a text change is dropped", () => {
    const a = bitmap(200, 200);
    const b = bitmap(200, 200, [
      { x: 10, y: 10, w: 40, h: 10 },
      { x: 100, y: 100, w: 50, h: 50 },
    ]);
    expect(diffBitmaps(a, b, { mask: [{ x: 0, y: 5, w: 60, h: 20 }] })).toEqual([{ x: 100, y: 100, w: 50, h: 50 }]);
    const regions = diffBitmaps(a, b);
    expect(regions).toHaveLength(2);
    const textChange: DiffItem = {
      id: "t",
      category: "text",
      kind: "replace",
      leftPage: 1,
      rightPage: 1,
      leftRects: [{ x: 12, y: 12, w: 20, h: 8 }],
      rightRects: [],
      left: "a",
      right: "b",
    };
    expect(unexplainedRegions(regions, [textChange])).toEqual([{ x: 100, y: 100, w: 50, h: 50 }]);
  });

  it("pages without text are compared as pictures", async () => {
    const left = {} as PdfEngine;
    const right = {} as PdfEngine;
    const pictures = new Map<PdfEngine, Bitmap[]>([
      [left, [bitmap(100, 140, [{ x: 10, y: 10, w: 30, h: 30 }]), bitmap(100, 140)]],
      [right, [bitmap(100, 140, [{ x: 10, y: 10, w: 30, h: 30 }]), bitmap(100, 140, [{ x: 50, y: 70, w: 20, h: 20 }])]],
    ]);
    const scales: number[] = [];
    const render: PageRasteriser = async (engine, index, scale) => {
      scales.push(scale);
      return pictures.get(engine)![index];
    };
    const base = compareLayouts([emptyPage(0), emptyPage(1)], [emptyPage(0), emptyPage(1)]);
    expect(base.pagesWithoutText).toBe(2);
    expect(base.pages.every((p) => p.textless)).toBe(true);
    const report = await compareVisual(left, right, base, { render, dpi: 72 });
    expect(scales.every((s) => s === 1)).toBe(true);
    expect(report.visual).toBe(true);
    expect(report.pages[0].status).toBe("unchanged");
    expect(report.pages[0].items).toHaveLength(0);
    expect(report.pages[1].status).toBe("modified");
    expect(report.imageChanges).toBe(1);
    expect(report.pagesModified).toBe(1);
    const img = report.pages[1].items[0];
    expect(img).toMatchObject({ category: "image", kind: "image", leftPage: 2, rightPage: 2 });
    // dpi 72: one pixel = one point.
    expect(img.rightRects[0]).toEqual({ x: 50, y: 70, w: 20, h: 20 });
  });
});

/** A tiny valid PNG (solid grey), without a canvas. */
function png(w: number, h: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(
      [...type].map((c) => c.charCodeAt(0)),
      4,
    );
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  const raw = new Uint8Array(h * (w + 1)).fill(200);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("compare — PDF report", () => {
  it("has a cover and one sheet per changed page", async () => {
    const before = await pdfOf([
      [{ text: "Première page inchangée du dossier" }],
      [{ text: "Le loyer est de mille euros" }],
      [{ text: "Clause finale sans modification aucune" }],
    ]);
    const after = await pdfOf([
      [{ text: "Première page inchangée du dossier" }],
      [{ text: "Le loyer est de douze cents euros" }],
      [{ text: "Clause finale sans modification aucune", bold: true }],
      [{ text: "Nouvelle annexe ajoutée à la fin" }],
    ]);
    const report = await withEngines(before, after, (l, r) => compareFiles(l, r));
    expect(report.pagesAdded).toBe(1);
    const changed = report.pages.filter((p) => p.status !== "unchanged");
    expect(changed).toHaveLength(3);

    const bytes = await buildCompareReport(report, {
      leftName: "bail-v1.pdf",
      rightName: "bail-v2.pdf",
      date: new Date("2026-09-26T10:00:00Z"),
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1 + changed.length);
    expect(doc.getTitle()).toContain("bail-v1.pdf");

    // With page pictures (as the browser rasteriser gives them).
    const asked: string[] = [];
    const withPictures = await buildCompareReport(report, {
      leftName: "bail-v1.pdf",
      rightName: "bail-v2.pdf",
      picture: async (side, index) => {
        asked.push(`${side}${index}`);
        return png(30, 42);
      },
    });
    expect((await PDFDocument.load(withPictures)).getPageCount()).toBe(1 + changed.length);
    expect(asked).toEqual(["left1", "right1", "left2", "right2", "right3"]);
  });

  it("an identical comparison is a cover only", async () => {
    const report = compareLayouts([emptyPage(0)], [emptyPage(0)]);
    const doc = await PDFDocument.load(await buildCompareReport(report, { leftName: "a.pdf", rightName: "b.pdf" }));
    expect(doc.getPageCount()).toBe(1);
  });
});
