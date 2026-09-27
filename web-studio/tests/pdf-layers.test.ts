// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { PdfEngine } from "../src/pdf/core/engine";
import { buildPdf } from "../src/pdf/ops/save";
import * as D from "../src/pdf/model/doc";
import { emptyState } from "../src/pdf/model/types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

/** Layers (optional content): the panel's tree and switches, the saved default. */

/** Layers: Plan (OFF by default) with child Cotes (locked), and a group « Langue » of FR / EN (radio). */
async function source(): Promise<{ bytes: Uint8Array; ids: Record<string, string> }> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  const ctx = doc.context;
  const ocg = (name: string) => ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of(name) } as never));
  const plan = ocg("Plan");
  const cotes = ocg("Cotes");
  const fr = ocg("FR");
  const en = ocg("EN");
  doc.catalog.set(
    PDFName.of("OCProperties"),
    ctx.obj({
      OCGs: [plan, cotes, fr, en],
      D: {
        Order: [plan, [cotes], [PDFString.of("Langue"), fr, en]],
        OFF: [plan, en],
        Locked: [cotes],
        RBGroups: [[fr, en]],
      },
    } as never),
  );
  const id = (r: typeof plan) => `${r.objectNumber}R`;
  return { bytes: await doc.save(), ids: { plan: id(plan), cotes: id(cotes), fr: id(fr), en: id(en) } };
}

async function withEngine<T>(bytes: Uint8Array, fn: (e: PdfEngine) => Promise<T>): Promise<T> {
  const engine = await PdfEngine.open(bytes);
  try {
    return await fn(engine);
  } finally {
    engine.destroy();
  }
}

describe("layers panel", () => {
  it("lists the tree as /Order has it: nesting, headings, locked, radio", async () => {
    const { bytes, ids } = await source();
    const rows = await withEngine(bytes, (e) => e.layers());
    expect(rows.map((r) => [r.name, r.depth, !!r.heading, r.visible, !!r.locked, !!r.radio])).toEqual([
      ["Plan", 0, false, false, false, false],
      ["Cotes", 1, false, true, true, false],
      ["Langue", 0, true, true, false, false],
      ["FR", 1, false, true, false, true],
      ["EN", 1, false, false, false, true],
    ]);
    expect(rows[0].id).toBe(ids.plan);
  });

  it("a layer hidden by default can be shown; turning a radio layer on turns its group's other off", async () => {
    const { bytes, ids } = await source();
    const rows = await withEngine(bytes, (e) =>
      e.layers(
        new Map([
          [ids.plan, true],
          [ids.en, true],
        ]),
      ),
    );
    const vis = Object.fromEntries(rows.filter((r) => !r.heading).map((r) => [r.name, r.visible]));
    expect(vis).toEqual({ Plan: true, Cotes: true, FR: false, EN: true });
  });

  it("saves the current visibility as the file's default", async () => {
    const { bytes, ids } = await source();
    const s = {
      ...emptyState(),
      pages: D.pagesFromSource(1),
      ocDefaults: { [ids.plan]: true, [ids.cotes]: true, [ids.fr]: false, [ids.en]: true },
    };
    const out = (await buildPdf(bytes, s)).bytes;
    const rows = await withEngine(out, (e) => e.layers());
    const vis = Object.fromEntries(rows.filter((r) => !r.heading).map((r) => [r.name, r.visible]));
    expect(vis).toEqual({ Plan: true, Cotes: true, FR: false, EN: true });
  });
});
