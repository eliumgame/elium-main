// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFDict, PDFDocument, PDFName, StandardFonts, rgb } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { buildPdf } from "../src/pdf/ops/save";
import { sanitiseForFont } from "../src/pdf/ops/fonts";
import * as D from "../src/pdf/model/doc";
import { emptyState, newId, type Annot, type PdfState } from "../src/pdf/model/types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

/**
 * Everything Elium writes into a page — a rewritten paragraph, a watermark, a
 * footer, a free-text comment, the OCR layer — used the WinAnsi-only standard
 * fonts, and characters outside it (« Łódź », Greek, Cyrillic) were dropped
 * without a word. They are now drawn with an embedded Unicode face.
 */

const SAMPLE = "Łódź — Ελλάδα, Москва « ok » €";

async function source(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.drawText("Texte d'origine", { x: 60, y: 760, size: 18, font, color: rgb(0, 0, 0) });
  return doc.save();
}

async function text(bytes: Uint8Array): Promise<string> {
  const task = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  const anns = (await page.getAnnotations()) as { contentsObj?: { str: string } }[];
  await task.destroy();
  return [tc.items.map((i) => ("str" in i ? i.str : "")).join(""), ...anns.map((a) => a.contentsObj?.str ?? "")].join(
    "\n",
  );
}

const base = (): PdfState => ({ ...emptyState(), pages: D.pagesFromSource(1) });

describe("Unicode text written into pages", () => {
  it("keeps every character of a rewritten paragraph", async () => {
    let state = base();
    state = D.upsertContentEdit(state, {
      id: "e1",
      pageId: state.pages[0].id,
      blockKey: "B0",
      original: "Texte d'origine",
      text: SAMPLE,
      rect: { x: 58, y: 66, w: 400, h: 26 },
      fontSize: 18,
      leading: 22,
      align: "left",
    });
    const { bytes, report } = await buildPdf(await source(), state);
    expect(report.lost).toEqual([]);
    const got = (await text(bytes)).replace(/\s+/g, " ");
    expect(got).toContain(SAMPLE);
    expect(got).not.toContain("Texte d'origine");
  });

  it("keeps them in a watermark and a footer", async () => {
    const state: PdfState = {
      ...base(),
      watermark: { ...base().watermark, enabled: true, mode: "text", text: "Ελλάδα" },
      footer: { ...base().footer, enabled: true, center: "Łódź — p. {page}" },
    };
    const got = await text((await buildPdf(await source(), state)).bytes);
    expect(got).toContain("Ελλάδα");
    expect(got).toContain("Łódź — p. 1");
  });

  it("keeps them in a free-text comment's appearance", async () => {
    const state = base();
    const now = new Date().toISOString();
    const note: Annot = {
      id: newId("an"),
      pageId: state.pages[0].id,
      kind: "freetext",
      rect: { x: 60, y: 200, w: 300, h: 40 },
      color: "#000000",
      opacity: 1,
      strokeWidth: 0,
      author: "Test",
      text: SAMPLE,
      contents: SAMPLE,
      fontSize: 12,
      createdAt: now,
      modifiedAt: now,
      replies: [],
    } as Annot;
    const { bytes } = await buildPdf(await source(), { ...state, annots: [note] }, { interactiveAnnots: false });
    expect((await text(bytes)).replace(/\s+/g, " ")).toContain(SAMPLE);
  });
});

describe("Unicode text keeps its family", () => {
  it("a Times paragraph is rewritten in Liberation Serif, a Courier one in Liberation Mono", async () => {
    for (const [family, expected] of [
      ["Times New Roman", "LiberationSerif"],
      ["Courier New", "LiberationMono"],
    ] as const) {
      let state = base();
      state = D.upsertContentEdit(state, {
        id: "e1",
        pageId: state.pages[0].id,
        blockKey: "B0",
        original: "Texte d'origine",
        text: "Łódź",
        rect: { x: 58, y: 66, w: 400, h: 26 },
        fontSize: 18,
        leading: 22,
        align: "left",
        fontFamily: family,
      });
      const { bytes } = await buildPdf(await source(), state);
      const doc = await PDFDocument.load(bytes);
      const baseFonts = doc.context
        .enumerateIndirectObjects()
        .map(([, o]) => (o instanceof PDFDict ? o.lookup(PDFName.of("BaseFont")) : undefined))
        .filter(Boolean)
        .map(String);
      expect(baseFonts.join(" ")).toContain(expected);
      expect(await text(bytes)).toContain("Łódź");
    }
  });
});

describe("sanitiseForFont — last resort for a WinAnsi font", () => {
  it("keeps what WinAnsi has (French typography included), replaces or drops the rest", () => {
    expect(sanitiseForFont("« Ça — c’est l’été… œuvre • 5 € »", false)).toBe("« Ça — c’est l’été… œuvre • 5 € »");
    expect(sanitiseForFont("a‑b ﬁn x−y Łó", false)).toBe("a-b fin x-y ó");
    expect(sanitiseForFont("Łódź", true)).toBe("Łódź");
  });
});
