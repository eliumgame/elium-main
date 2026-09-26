import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as pdfjsLib from "pdfjs-dist";
import { PDFDict, PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { JSDOM } from "jsdom";
import { strFromU8, unzipSync } from "fflate";
import * as D from "../src/pdf/model/doc";
import { emptyState } from "../src/pdf/model/types";
import { buildPdf } from "../src/pdf/ops/save";
import { readPageContentBytes } from "../src/pdf/ops/content";
import { PdfEngine } from "../src/pdf/core/engine";
import {
  csvSafeCell,
  detectTables,
  extractLayout,
  tablesToCsv,
  toDocx,
  toHtml,
  toPlainText,
  toPlainTextWithMarkers,
} from "../src/pdf/ops/export";
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

/**
 * A page whose text carries characters XML forbids — a ToUnicode map sending
 * « A » to U+0001 and « B » to U+FFFE, as real files do — and a table whose
 * cells a spreadsheet would run as formulas.
 */
async function hostilePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.drawText("Titre <b>&amp; \"x\"</b>", { x: 72, y: 780, size: 22, font: f });
  const rows = [
    ["Nom", "Formule", "Montant"],
    ['=HYPERLINK("http://evil","x")', "+cmd|' /C calc'!A0", "12,00"],
    ["@SUM(A1:A2)", "-2+3", "-14,50"],
    ["Alpha", "Beta", "15,00"],
    ["Gamma", "Delta", "16,00"],
  ];
  rows.forEach((r, i) => r.forEach((c, j) => p.drawText(c, { x: 72 + j * 170, y: 700 - i * 18, size: 10, font: f })));
  const cmap =
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def 1 begincodespacerange <00> <FF> endcodespacerange " +
    "2 beginbfchar <41> <0001> <42> <FFFE> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end";
  const tu = doc.context.register(doc.context.stream(cmap));
  const f2 = doc.context.register(
    doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding", ToUnicode: tu }),
  );
  (p.node.Resources()!.lookup(PDFName.of("Font")) as PDFDict).set(PDFName.of("FCtl"), f2);
  p.node.addContentStream(
    doc.context.register(
      doc.context.stream(
        "BT /FCtl 12 Tf 72 400 Td (Hello ABAB world) Tj ET BT /FCtl 10 Tf 72 628 Td (xAx) Tj ET BT /FCtl 10 Tf 242 628 Td (yBy) Tj ET",
      ),
    ),
  );
  return doc.save();
}

/** Characters XML 1.0 forbids (C0 controls but tab / LF / CR, U+FFFE / U+FFFF, lone surrogates). */
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Parse `xml` with a real XML parser; the error message when it is not well-formed. */
const XmlParser = new JSDOM("").window.DOMParser;
function xmlError(xml: string): string | null {
  const doc = new XmlParser().parseFromString(xml, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  return err ? err.textContent : null;
}

describe("hostile text: forbidden characters and formulas", () => {
  it("CSV cells a spreadsheet would run get an apostrophe; plain numbers stay numbers", () => {
    expect(csvSafeCell("=HYPERLINK(\"http://evil\")")).toBe("'=HYPERLINK(\"http://evil\")");
    expect(csvSafeCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
    expect(csvSafeCell("@SUM(A1:A2)")).toBe("'@SUM(A1:A2)");
    expect(csvSafeCell("-2+3")).toBe("'-2+3");
    expect(csvSafeCell("\t=1")).toBe("'\t=1");
    expect(csvSafeCell("\r=1")).toBe("'\r=1");
    for (const n of ["-2", "-12,50", "+33", "-1 234,50", "12", "-5 %"]) expect(csvSafeCell(n)).toBe(n);
    expect(csvSafeCell("Alpha")).toBe("Alpha");
    expect(csvSafeCell("a\u0001b￾")).toBe("ab");
  });

  it("a PDF's table with formulas and control characters exports safely", async () => {
    const e = await PdfEngine.open(await hostilePdf());
    try {
      const layout = await extractLayout(e);
      const csv = tablesToCsv(detectTables(layout));
      expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
      expect(csv).toContain("'+cmd|' /C calc'!A0");
      expect(csv).toContain("'@SUM(A1:A2);'-2+3;-14,50");
      expect(csv).not.toMatch(/(^|;)[=+@]/m);
      expect(FORBIDDEN.test(csv)).toBe(false);

      const zip = unzipSync(toDocx(layout, "Titre\u0001￾"));
      for (const [name, data] of Object.entries(zip)) {
        const xml = strFromU8(data);
        expect(FORBIDDEN.test(xml), name).toBe(false);
        expect(xmlError(xml), name).toBeNull();
      }
      expect(strFromU8(zip["docProps/core.xml"]!)).toContain("<dc:title>Titre</dc:title>");

      const html = toHtml(layout, "t￾");
      expect(FORBIDDEN.test(html)).toBe(false);
      expect(html).toContain("Hello");
      expect(FORBIDDEN.test(toPlainText(layout))).toBe(false);
      expect(FORBIDDEN.test(toPlainTextWithMarkers(layout))).toBe(false);
    } finally {
      e.destroy();
    }
  });
});
