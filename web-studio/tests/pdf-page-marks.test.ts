// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  concatTransformationMatrix,
  decodePDFRawStream,
  degrees,
} from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { buildPdf } from "../src/pdf/ops/save";
import { hasPageMarks, planMarks, stripPageMarks } from "../src/pdf/ops/decorate";
import { readPageContentBytes } from "../src/pdf/ops/content";
import * as D from "../src/pdf/model/doc";
import { DEFAULT_BATES, DEFAULT_WATERMARK, emptyBand, emptyState, type PdfState } from "../src/pdf/model/types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

/** Headers, footers, watermarks and Bates numbers: placement, isolation, ranges, removal. */

async function source(rotations: number[], dirty = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const r of rotations) {
    const p = doc.addPage([600, 800]);
    p.drawText("Corps", { x: 40, y: 400, size: 12, font });
    if (r) p.setRotation(degrees(r));
    // Content that leaves a transform in force (as many producers do).
    if (dirty) p.pushOperators(concatTransformationMatrix(0.5, 0, 0, 0.5, 300, 0));
  }
  return doc.save({ useObjectStreams: false });
}

async function seenText(bytes: Uint8Array) {
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const out: { page: number; str: string; x: number; y: number; w: number; h: number; m: number[] }[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    for (const item of tc.items as { str: string; transform: number[] }[]) {
      if (!item.str.trim()) continue;
      const m = pdfjsLib.Util.transform(vp.transform, item.transform);
      out.push({ page: n, str: item.str, x: m[4], y: m[5], w: vp.width, h: vp.height, m });
    }
  }
  await pdf.cleanup();
  return out;
}

function marked(s: PdfState): PdfState {
  return {
    ...s,
    header: { ...emptyBand(), enabled: true, center: "EN-TETE {page}" },
    footer: { ...emptyBand(), enabled: true, right: "PIED" },
  };
}

describe("page marks follow the page as seen", () => {
  it("runs the header along the displayed top edge, upright, whatever /Rotate", async () => {
    const rotations = [0, 90, 180, 270];
    const s = marked({ ...emptyState(), pages: D.pagesFromSource(4) });
    const out = (await buildPdf(await source(rotations), s)).bytes;
    const items = await seenText(out);
    for (let n = 1; n <= 4; n++) {
      const head = items.find((i) => i.page === n && i.str.startsWith("EN-TETE"))!;
      const foot = items.find((i) => i.page === n && i.str === "PIED")!;
      expect(head, `page ${n}`).toBeTruthy();
      // Displayed page: y goes down. The header near the top, centred; the footer near the bottom, right.
      expect(head.y, `page ${n}`).toBeLessThan(40);
      expect(Math.abs(head.x - head.w / 2)).toBeLessThan(60);
      expect(foot.y, `page ${n}`).toBeGreaterThan(head.h - 40);
      expect(foot.x, `page ${n}`).toBeGreaterThan(foot.w / 2);
      // Upright: horizontal baseline, left to right.
      expect(head.m[0], `page ${n}`).toBeGreaterThan(0);
      expect(Math.abs(head.m[1])).toBeLessThan(1e-6);
      // Landscape when turned by a quarter.
      expect(head.w).toBe(n % 2 ? 600 : 800);
    }
  });

  it("isolates the page's own content, so a transform it leaves does not move the marks", async () => {
    const s = marked({ ...emptyState(), pages: D.pagesFromSource(1) });
    const out = (await buildPdf(await source([0], true), s)).bytes;
    const [head] = (await seenText(out)).filter((i) => i.str.startsWith("EN-TETE"));
    expect(head.y).toBeLessThan(40);
    expect(Math.abs(head.x - 300)).toBeLessThan(60);
    // Marks are tagged artifacts.
    const doc = await PDFDocument.load(out);
    const content = new TextDecoder("latin1").decode(readPageContentBytes(doc.getPage(0)));
    expect(content).toMatch(/\/Artifact <<\/Type \/Pagination \/Subtype \/Header \/EliumMark \/Header>> BDC/);
  });
});

describe("page ranges and Bates numbers", () => {
  it("numbers only the pages of the Bates range, in sequence", () => {
    const plan = planMarks(
      {
        watermark: DEFAULT_WATERMARK,
        header: emptyBand(),
        footer: emptyBand(),
        bates: { ...DEFAULT_BATES, enabled: true, prefix: "X", digits: 3, start: 10, pages: "2-" },
      },
      4,
    );
    expect([...plan.bates]).toEqual([
      [1, "X010"],
      [2, "X011"],
      [3, "X012"],
    ]);
  });

  it("stamps the Bates number when neither band places it, and not twice when one does", async () => {
    const base: PdfState = {
      ...emptyState(),
      pages: D.pagesFromSource(2),
      bates: { ...DEFAULT_BATES, enabled: true, prefix: "B" },
      header: { ...emptyBand(), enabled: true, left: "Titre" },
    };
    const a = await seenText((await buildPdf(await source([0, 0]), base)).bytes);
    expect(a.filter((i) => i.str === "B000001")).toHaveLength(1);
    expect(a.filter((i) => i.str === "B000002")).toHaveLength(1);

    const placed = { ...base, footer: { ...emptyBand(), enabled: true, center: "Pièce {bates}" } };
    const b = await seenText((await buildPdf(await source([0, 0]), placed)).bytes);
    expect(b.filter((i) => i.str.includes("B000001"))).toHaveLength(1);
    expect(b.find((i) => i.str.includes("B000001"))!.str).toBe("Pièce B000001");
  });

  it("starts {page} at the chosen number", async () => {
    const s: PdfState = {
      ...emptyState(),
      pages: D.pagesFromSource(2),
      footer: { ...emptyBand(), enabled: true, center: "p. {page}", startPage: 5 },
    };
    const items = await seenText((await buildPdf(await source([0, 0]), s)).bytes);
    expect(items.filter((i) => i.str.startsWith("p. ")).map((i) => i.str)).toEqual(["p. 5", "p. 6"]);
  });

  it("tints the whole page for a background colour, under the content", async () => {
    const s: PdfState = {
      ...emptyState(),
      pages: D.pagesFromSource(1),
      watermark: { ...DEFAULT_WATERMARK, enabled: true, mode: "color", color: "#ffeeaa", opacity: 0.5 },
    };
    const doc = await PDFDocument.load((await buildPdf(await source([90]), s)).bytes);
    const contents = doc.getPage(0).node.Contents() as PDFArray;
    const first = doc.context.lookup(contents.get(0)) as PDFRawStream;
    const body = new TextDecoder("latin1").decode(decodePDFRawStream(first).decode());
    expect(body).toMatch(/\/Type \/Background/);
    expect(body).toMatch(/ re\nf/);
  });
});

describe("removing marks", () => {
  it("removes Elium's marks, so marking again does not stack them", async () => {
    const s = marked({ ...emptyState(), pages: D.pagesFromSource(2) });
    const once = (await buildPdf(await source([0, 90]), s)).bytes;
    expect(hasPageMarks(await PDFDocument.load(once))).toBe(true);

    const again = (await buildPdf(once, { ...s, stripMarks: true })).bytes;
    const items = await seenText(again);
    expect(items.filter((i) => i.str.startsWith("EN-TETE"))).toHaveLength(2);
    expect(items.some((i) => i.str === "Corps")).toBe(true);

    const cleared = (await buildPdf(once, { ...emptyState(), pages: D.pagesFromSource(2), stripMarks: true })).bytes;
    expect((await seenText(cleared)).map((i) => i.str)).toEqual(["Corps", "Corps"]);
    expect(hasPageMarks(await PDFDocument.load(cleared))).toBe(false);
  });

  it("removes Acrobat's marks and keeps a word processor's running header", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([600, 800]);
    page.drawText("Corps", { x: 40, y: 400, size: 12, font });
    const ctx = doc.context;
    const fontName = (page.node.Resources()!.lookup(PDFName.of("Font"), PDFDict).keys()[0] as PDFName).asString();
    // Acrobat: a form XObject tagged /PieceInfo /ADBE_CompoundType /Private /Watermark.
    const fm = ctx.register(
      ctx.flateStream("BT /F1 30 Tf 100 300 Td (FILIGRANE) Tj ET", {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, 600, 800],
        Resources: {},
        PieceInfo: { ADBE_CompoundType: { Private: "Watermark" } },
      } as never),
    );
    page.node.setXObject(PDFName.of("Fm0"), fm);
    page.node.addContentStream(
      ctx.register(
        ctx.stream(
          "/Artifact <</Type /Pagination /Subtype /Watermark>> BDC q /Fm0 Do Q EMC\n" +
            `/Artifact <</Type /Pagination /Subtype /Header /Attached [/Top]>> BDC BT ${fontName}` +
            " 9 Tf 40 780 Td (Rapport annuel) Tj ET EMC\n",
        ),
      ),
    );
    page.node.set(PDFName.of("PieceInfo"), ctx.obj({ ADBE_CompoundType: { Private: "Watermark" } } as never));
    // As a file read back (its content streams encoded), the way a save meets it.
    const file = await PDFDocument.load(await doc.save());
    const read = file.getPage(0);
    expect(hasPageMarks(file)).toBe(true);
    expect(stripPageMarks(file, read)).toBe(1);
    expect(read.node.get(PDFName.of("PieceInfo"))).toBeUndefined();
    expect(hasPageMarks(file)).toBe(false);
    const items = await seenText(await file.save());
    expect(items.map((i) => i.str).sort()).toEqual(["Corps", "Rapport annuel"]);
  });
});
