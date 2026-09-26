import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, PDFName } from "pdf-lib";
import { writeOcrLayer } from "../src/pdf/ops/ocr";
import { FontBook } from "../src/pdf/ops/fonts";

/** The OCR text layer lands under the word it was read from, whatever the page does. */

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

async function wordOrigin(content: string, rotate = 0, crop?: number[]): Promise<[number, number]> {
  const doc = await PDFDocument.create();
  const p = doc.addPage([600, 800]);
  if (crop) p.setCropBox(crop[0]!, crop[1]!, crop[2]!, crop[3]!);
  if (rotate) p.setRotation({ type: "degrees", angle: rotate } as never);
  p.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(content)));
  const box = p.getCropBox();
  // One word at (100, 100) in the page as shown, 80 × 20, baseline at y = 116.
  const line = {
    words: [{ text: "Bonjour", confidence: 90, rect: { x: 100, y: 100, w: 80, h: 20 } }],
    baseline: { x0: 100, y0: 116, x1: 180, y1: 116 },
    height: 20,
  };
  const size = { w: box.width, h: box.height };
  await writeOcrLayer(doc, p, { lines: [line], rotation: rotate as never, size }, new FontBook(doc));
  const pdf = await pdfjsLib.getDocument({
    data: await doc.save(),
    standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  }).promise;
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const items = (await page.getTextContent()).items as { str: string; transform: number[] }[];
  const word = items.find((i) => i.str.includes("Bonjour"))!;
  const [x, y] = vp.convertToViewportPoint(word.transform[4]!, word.transform[5]!);
  return [Math.round(x), Math.round(y)];
}

describe("OCR text layer", () => {
  it("sits on the word, even after content that leaves a transformation in force", async () => {
    expect(await wordOrigin("q Q")).toEqual([100, 116]);
    expect(await wordOrigin("1 0 0 1 50 -40 cm")).toEqual([100, 116]);
    expect(await wordOrigin("q Q", 90, [30, 40, 500, 700])).toEqual([100, 116]);
    expect(await wordOrigin("q Q", 270)).toEqual([100, 116]);
  });
});
