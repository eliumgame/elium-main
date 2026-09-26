import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import * as D from "../src/pdf/model/doc";
import { emptyState } from "../src/pdf/model/types";
import { buildPdf } from "../src/pdf/ops/save";
import { readPageContentBytes } from "../src/pdf/ops/content";
import { PdfEngine } from "../src/pdf/core/engine";
import { detectTables, extractLayout, tablesToCsv } from "../src/pdf/ops/export";
import { comparePages } from "../src/pdf/ops/compare";

/** Conversion: tables out of a page, comparison of pages with no text. */

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

describe("tables", () => {
  it("an invoice drawn cell by cell is one table; two columns of running text are none", async () => {
    const doc = await PDFDocument.create();
    const f = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([595, 842]);
    const rows = [
      ["Article", "Qte", "Prix unitaire", "Total"],
      ["Pommes", "12", "3,50", "42,00"],
      ["Poires", "7", "2,10", "14,70"],
      ["Cerises", "250", "14,00", "3500,00"],
      ["Abricots", "31", "6,20", "192,20"],
    ];
    const xs = [60, 220, 300, 440];
    rows.forEach((r, i) => r.forEach((c, j) => p.drawText(c, { x: xs[j]!, y: 700 - i * 18, size: 11, font: f })));
    for (let i = 0; i < 6; i++) {
      p.drawText(`Colonne gauche ligne ${i} texte suivi`, { x: 60, y: 500 - i * 14, size: 10, font: f });
      p.drawText(`Colonne droite ligne ${i} autre texte`, { x: 320, y: 500 - i * 14, size: 10, font: f });
    }
    const e = await PdfEngine.open(await doc.save());
    try {
      const tables = detectTables(await extractLayout(e));
      expect(tables).toHaveLength(1);
      expect(tables[0]!.rows).toEqual(rows);
      expect(tablesToCsv(tables)).toContain("Cerises;250;14,00;3500,00");
    } finally {
      e.destroy();
    }
  });
});

describe("compare", () => {
  it("pages without text are not reported as identical", () => {
    const r = comparePages(["", ""], ["", ""]);
    expect(r.pagesWithoutText).toBe(2);
    const t = comparePages(["Bonjour"], ["Bonjour"]);
    expect(t.pagesWithoutText).toBe(0);
  });
});

describe("print", () => {
  it("a screen-only button is not printed; a printable field is", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.drawText("Formulaire", { x: 50, y: 800, size: 14, font });
    const form = doc.getForm();
    const btn = form.createButton("imprimer");
    btn.addToPage("CLIQUEZ POUR IMPRIMER", page, { x: 50, y: 700, width: 220, height: 30 });
    const tf = form.createTextField("nom");
    tf.setText("Dupont");
    tf.addToPage(page, { x: 50, y: 650, width: 200, height: 20 });
    // « Visible mais non imprimable »: no Print flag.
    btn.acroField.getWidgets()[0]!.dict.set(PDFName.of("F"), doc.context.obj(0));
    const src = await doc.save();
    const state = { ...emptyState(), pages: D.pagesFromSource(1) };
    const build = (forPrint: boolean) =>
      buildPdf(src, state, { interactiveAnnots: false, flattenForms: true, encryption: "remove", forPrint } as never);
    const drawn = async (bytes: Uint8Array) => {
      const out = await PDFDocument.load(bytes);
      return (new TextDecoder("latin1").decode(readPageContentBytes(out.getPage(0))).match(/ Do\b/g) ?? []).length;
    };
    expect(await drawn((await build(false)).bytes)).toBe(2);
    expect(await drawn((await build(true)).bytes)).toBe(1);
  });
});
