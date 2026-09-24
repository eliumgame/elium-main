// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { PdfEngine, type EngineEvent } from "../src/pdf/core/engine";

// See tests/detector-ingest.test.ts: no Vite to resolve the `?url` worker import.
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

/** 40 pages: A4 everywhere except an A3 landscape (5), a /Rotate 90 (10) and an offset CropBox (12). */
async function mixedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 40; i++) {
    const page = doc.addPage(i === 5 ? [1191, 842] : [595, 842]);
    if (i === 10) page.setRotation(degrees(90));
    if (i === 12) page.setCropBox(20, 30, 380, 545);
  }
  return doc.save();
}

describe("PdfEngine — lazy page geometry", () => {
  it("opens with page 1 exact and the others estimated from it", async () => {
    const engine = await PdfEngine.open(await mixedPdf());
    try {
      expect(engine.pageCount).toBe(40);
      expect(engine.pages[0]).toMatchObject({ w: 595, h: 842, rotate: 0 });
      expect(engine.pages[0].estimated).toBeFalsy();
      // Nothing asked for page 6 yet: it is a guess copied from page 1.
      expect(engine.pages[5]).toMatchObject({ index: 5, w: 595, h: 842, estimated: true });
    } finally {
      engine.destroy();
    }
  });

  it("settles a page on demand and tells subscribers which pages changed", async () => {
    const engine = await PdfEngine.open(await mixedPdf());
    try {
      const events: EngineEvent[] = [];
      engine.subscribe((e) => events.push(e));
      const a3 = await engine.pageInfo(5);
      expect(a3).toMatchObject({ index: 5, w: 1191, h: 842, rotate: 0 });
      expect(a3.estimated).toBeFalsy();
      expect(engine.pages[5]).toBe(a3);
      await new Promise((r) => setTimeout(r, 5)); // events are coalesced on a timer
      const geo = events.filter((e) => e.type === "geometry");
      expect(geo.length).toBeGreaterThan(0);
      expect(geo.flatMap((e) => (e.type === "geometry" ? e.indices : []))).toContain(5);
    } finally {
      engine.destroy();
    }
  });

  it("completes every page in the background, including rotation and crop-box origin", async () => {
    const engine = await PdfEngine.open(await mixedPdf());
    try {
      const changed = new Set<number>();
      engine.subscribe((e) => {
        if (e.type === "geometry") e.indices.forEach((i) => changed.add(i));
      });
      await engine.geometryReady;
      await new Promise((r) => setTimeout(r, 5));
      expect(engine.pages.every((p) => !p.estimated)).toBe(true);
      expect(engine.pages[10].rotate).toBe(90);
      expect(engine.pages[12]).toMatchObject({ w: 380, h: 545, ox: 20, oy: 30 });
      // Only pages that really differ from the estimate are reported.
      expect([...changed].sort((a, b) => a - b)).toEqual([5, 10, 12]);
      expect(engine.geometryVersion).toBe(3);
    } finally {
      engine.destroy();
    }
  }, 30000);

  it("computes the form / signature facts in the background", async () => {
    const engine = await PdfEngine.open(await mixedPdf());
    try {
      let notified = false;
      engine.subscribe((e) => {
        if (e.type === "info") notified = true;
      });
      const info = await engine.infoReady;
      expect(info.hasAcroForm).toBe(false);
      expect(info.signed).toBe(false);
      expect(notified).toBe(true);
    } finally {
      engine.destroy();
    }
  });
});
