// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFDocument, PDFName } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { buildPdf } from "../src/pdf/ops/save";
import { writePageLabels } from "../src/pdf/ops/organize";
import * as D from "../src/pdf/model/doc";
import { emptyState, type PdfState } from "../src/pdf/model/types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

/** Page labels as every reader shows them: « i, ii, iii, 1, 2… », « A-1 », « Annexe ». */

async function blank(n: number, labelled?: (doc: PDFDocument) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([300, 400]);
  labelled?.(doc);
  return doc.save();
}

async function labels(bytes: Uint8Array): Promise<string[] | null> {
  const task = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const out = (await (await task.promise).getPageLabels()) as string[] | null;
  await task.destroy();
  return out;
}

describe("page labels", () => {
  it("writes styles, prefixes and starts that readers show as set", async () => {
    let s: PdfState = { ...emptyState(), pages: D.pagesFromSource(7) };
    const ids = s.pages.map((p) => p.id);
    s = D.labelPages(s, ids.slice(0, 3), "roman", "", 1);
    s = D.labelPages(s, ids.slice(3, 5), "decimal", "A-", 1);
    s = D.labelPages(s, ids.slice(5, 6), "none", "Annexe", 1);
    s = D.labelPages(s, ids.slice(6), "ALPHA", "", 3);
    const out = (await buildPdf(await blank(7), s)).bytes;
    expect(await labels(out)).toEqual(["i", "ii", "iii", "A-1", "A-2", "Annexe", "C"]);
  });

  it("keeps the file's labels with their pages when the pages move", async () => {
    const src = await blank(5, (doc) =>
      writePageLabels(doc, [
        { style: "roman", prefix: "", num: 1 },
        { style: "roman", prefix: "", num: 2 },
        { style: "decimal", prefix: "", num: 1 },
        { style: "decimal", prefix: "", num: 2 },
        { style: "decimal", prefix: "", num: 3 },
      ]),
    );
    expect(await labels(src)).toEqual(["i", "ii", "1", "2", "3"]);
    let s: PdfState = { ...emptyState(), pages: D.pagesFromSource(5) };
    s = D.deletePages(s, [s.pages[1].id]);
    s = D.reorderPages(s, [s.pages[3].id], 0);
    // Order now: 3 (« 3 »), i, 1, 2.
    expect(await labels((await buildPdf(src, s)).bytes)).toEqual(["3", "i", "1", "2"]);
  });

  it("leaves an untouched file's labels as they are, and removes them when none remain", async () => {
    const src = await blank(2, (doc) =>
      writePageLabels(doc, [
        { style: "none", prefix: "Couverture", num: 1 },
        { style: "decimal", prefix: "", num: 1 },
      ]),
    );
    const s: PdfState = { ...emptyState(), pages: D.pagesFromSource(2) };
    expect(await labels((await buildPdf(src, s)).bytes)).toEqual(["Couverture", "1"]);
    const doc = await PDFDocument.load(await blank(2));
    writePageLabels(doc, [undefined, undefined]);
    expect(doc.catalog.get(PDFName.of("PageLabels"))).toBeUndefined();
  });
});

describe("excluded pages", () => {
  it("stay in the saved document, and are left out of copies", async () => {
    let s: PdfState = { ...emptyState(), pages: D.pagesFromSource(3) };
    s = D.setPageSkipped(s, [s.pages[1].id], true);
    const src = await blank(3);
    const kept = await PDFDocument.load((await buildPdf(src, s, { keepSkipped: true })).bytes);
    expect(kept.getPageCount()).toBe(3);
    const copy = await PDFDocument.load((await buildPdf(src, s)).bytes);
    expect(copy.getPageCount()).toBe(2);
  });
});
