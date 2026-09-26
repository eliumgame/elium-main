import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as pdfjsLib from "pdfjs-dist";
import { strFromU8, unzipSync } from "fflate";
import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { JSDOM } from "jsdom";
import { PdfEngine } from "../src/pdf/core/engine";
import { detectTables, extractLayout, type PageText } from "../src/pdf/ops/export";
import {
  analyseLayout,
  collectPageMeta,
  detectTableRegions,
  exportDocx,
  exportPptx,
  exportRtf,
  exportXlsx,
  officeText,
  parseLocaleNumber,
} from "../src/pdf/ops/export-office";
import { listMarker, readingOrder } from "../src/pdf/ops/export-office-model";
import { rtfEscape } from "../src/pdf/ops/export-rtf";
import { workbookToXlsx } from "../src/sheet/xlsx-export";
import { xmlSafeText } from "../src/format/xml-text";

/** « Exporter un PDF » vers Word, Excel, PowerPoint et RTF. */

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

const PNG_1PX = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
const URL_TEXT = "https://elium.example/rapport";
const TABLE = [
  ["Article", "Qte", "Prix unitaire", "Total"],
  ["Pommes", "12", "3,50", "42,00"],
  ["Poires", "7", "2,10", "14,70"],
  ["Cerises", "250", "14,00", "3500,00"],
  ["Abricots", "31", "6,20", "192,20"],
];

/** Draw pieces one after the other on a baseline, each in its own font. */
function drawPieces(page: PDFPage, x: number, y: number, size: number, pieces: [string, PDFFont][]): number {
  let cx = x;
  for (const [text, font] of pieces) {
    page.drawText(text, { x: cx, y, size, font });
    cx += font.widthOfTextAtSize(text, size);
  }
  return cx;
}

async function samplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const b = await doc.embedFont(StandardFonts.HelveticaBold);
  const p = doc.addPage([595, 842]);
  p.drawText("Rapport annuel", { x: 72, y: 770, size: 22, font: b });
  drawPieces(p, 72, 735, 11, [
    ["Ceci est le premier paragraphe du rapport, avec un mot ", f],
    ["important", b],
    [" au milieu", f],
  ]);
  p.drawText("de la phrase, qui continue sur une seconde ligne de texte courant.", {
    x: 72,
    y: 721,
    size: 11,
    font: f,
  });
  p.drawText("Résultats", { x: 72, y: 685, size: 16, font: b });
  ["Premier point de la liste", "Deuxième point de la liste", "Troisième point"].forEach((t, i) =>
    p.drawText(`• ${t}`, { x: 80, y: 660 - i * 15, size: 11, font: f }),
  );
  const xs = [72, 220, 300, 440];
  TABLE.forEach((r, i) => r.forEach((c, j) => p.drawText(c, { x: xs[j], y: 580 - i * 18, size: 11, font: f })));
  const end = drawPieces(p, 72, 460, 11, [["Voir le site ", f]]);
  const urlEnd = drawPieces(p, end, 460, 11, [[URL_TEXT, f]]);
  drawPieces(p, urlEnd, 460, 11, [[" pour la suite.", f]]);
  const link = doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [end, 456, urlEnd, 471],
    Border: [0, 0, 0],
    A: { Type: "Action", S: "URI", URI: PDFString.of(URL_TEXT) },
  });
  p.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(link)]));
  const img = await doc.embedPng(PNG_1PX);
  p.drawImage(img, { x: 400, y: 600, width: 100, height: 50 });

  // Page 2: a full-width title over two columns whose paragraph gaps line up.
  const q = doc.addPage([595, 842]);
  q.drawText("Deux colonnes", { x: 72, y: 770, size: 22, font: b });
  for (const [col, x] of [
    ["gauche", 72],
    ["droite", 320],
  ] as const) {
    for (let para = 0; para < 2; para++) {
      for (let line = 0; line < 3; line++) {
        const y = 730 - para * 70 - line * 13;
        q.drawText(`Colonne ${col} paragraphe ${para + 1} ligne ${line + 1}`, { x, y, size: 10, font: f });
      }
    }
  }
  return doc.save();
}

let engine: PdfEngine;
let layout: PageText[];

beforeAll(async () => {
  engine = await PdfEngine.open(await samplePdf());
  layout = await extractLayout(engine);
});

afterAll(() => engine?.destroy());

const unzipText = (bytes: Uint8Array, name: string) => {
  const zip = unzipSync(bytes);
  expect(Object.keys(zip)).toContain(name);
  return strFromU8(zip[name]);
};

describe("analysis", () => {
  it("finds headings, the list, the table, the link and the image", async () => {
    const meta = await collectPageMeta(engine, layout);
    expect(meta[0].w).toBeCloseTo(595);
    expect(meta[0].links).toHaveLength(1);
    expect(meta[0].links[0].url).toBe(URL_TEXT);
    const img = meta[0].images[0];
    expect(img.x).toBeCloseTo(400, 0);
    expect(img.y).toBeCloseTo(842 - 650, 0);
    expect(img.w).toBeCloseTo(100, 0);

    const model = analyseLayout(layout, meta, { images: true });
    const items = model.pages[0].items;
    // Page 2's columns (10 pt) carry more text than page 1's 11 pt body.
    expect(model.bodySize).toBe(10);
    const headings = items.filter((i) => i.kind === "heading");
    expect(
      headings.map((h) => [
        h.kind === "heading" && h.level,
        officeText({ ...model, pages: [{ ...model.pages[0], items: [h] }] }),
      ]),
    ).toEqual([
      [1, "Rapport annuel"],
      [2, "Résultats"],
    ]);
    const para = items.find((i) => i.kind === "paragraph");
    expect(para?.kind === "paragraph" && para.runs.find((r) => r.bold)?.text).toBe("important");
    expect(officeText(model)).toContain("avec un mot important au milieu de la phrase, qui continue");
    const list = items.find((i) => i.kind === "list");
    expect(list?.kind === "list" && list.items.map((it) => it.runs.map((r) => r.text).join(""))).toEqual([
      "Premier point de la liste",
      "Deuxième point de la liste",
      "Troisième point",
    ]);
    const table = items.find((i) => i.kind === "table");
    expect(table?.kind === "table" && table.rows.map((r) => r.map((c) => c.text))).toEqual(TABLE);
    // The table's text left the flow.
    expect(
      items
        .filter((i) => i.kind === "paragraph")
        .some((i) => officeText({ ...model, pages: [{ ...model.pages[0], items: [i] }] }).includes("Cerises")),
    ).toBe(false);
    const linked = items.flatMap((i) => (i.kind === "paragraph" ? i.runs : [])).find((r) => r.href);
    expect(linked).toMatchObject({ text: URL_TEXT, href: URL_TEXT });
    expect(items.some((i) => i.kind === "image")).toBe(true);
    // Reading order: the title, the text, and the table where it sits.
    const kinds = items.map((i) => i.kind);
    expect(kinds.indexOf("heading")).toBe(0);
    expect(kinds.indexOf("table")).toBeGreaterThan(kinds.indexOf("list"));
  });

  it("reads two columns column by column under a full-width title", async () => {
    const model = analyseLayout(layout, await collectPageMeta(engine, layout));
    const text = officeText(model).split("\f")[1];
    const order = [
      "Deux colonnes",
      "gauche paragraphe 1",
      "gauche paragraphe 2",
      "droite paragraphe 1",
      "droite paragraphe 2",
    ];
    const pos = order.map((s) => text.indexOf(s));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });

  it("table regions match detectTables row for row", () => {
    expect(detectTableRegions(layout).map((t) => t.rows.map((r) => r.map((c) => c.text)))).toEqual(
      detectTables(layout).map((t) => t.rows),
    );
  });

  it("reading order keeps a narrow label beside its value", () => {
    const u = (x: number, y: number, w: number, id: string) => ({ rect: { x, y, w, h: 10 }, id });
    const order = readingOrder([
      u(300, 0, 200, "valeur 1"),
      u(72, 0, 40, "clé 1"),
      u(72, 20, 40, "clé 2"),
      u(300, 20, 200, "valeur 2"),
    ]);
    expect(order.map((o) => o.id)).toEqual(["clé 1", "valeur 1", "clé 2", "valeur 2"]);
  });

  it("list markers", () => {
    expect(listMarker("• Point")?.ordered).toBe(false);
    expect(listMarker("- Point")?.marker).toBe("-");
    expect(listMarker("1. Premier")).toMatchObject({ marker: "1.", ordered: true });
    expect(listMarker("a) Premier")).toMatchObject({ marker: "a)", ordered: true });
    expect(listMarker("-12 degrés")).toBeNull();
    expect(listMarker("2025 fut une année")).toBeNull();
  });
});

describe("numbers", () => {
  it("parses French and English numbers", () => {
    expect(parseLocaleNumber("3500,00")).toMatchObject({ value: 3500, kind: "decimal", decimals: 2 });
    expect(parseLocaleNumber("1 234,50")?.value).toBe(1234.5);
    expect(parseLocaleNumber("1 234,50")?.value).toBe(1234.5);
    expect(parseLocaleNumber("1,234.50")?.value).toBe(1234.5);
    expect(parseLocaleNumber("1.234,50")?.value).toBe(1234.5);
    expect(parseLocaleNumber("12 %")).toMatchObject({ value: 0.12, kind: "percent" });
    expect(parseLocaleNumber("57%")?.value).toBe(0.57);
    expect(parseLocaleNumber("42,00 €")).toMatchObject({ value: 42, kind: "currency" });
    expect(parseLocaleNumber("-15,5")?.value).toBe(-15.5);
    expect(parseLocaleNumber("(15,00)")?.value).toBe(-15);
    expect(parseLocaleNumber("250")).toMatchObject({ value: 250, kind: "integer" });
    for (const text of ["00123", "12/03/2024", "01 23 45 67 89", "Pommes", "3,50 kg", "12.03.2024", ""]) {
      expect(parseLocaleNumber(text), text).toBeNull();
    }
  });
});

describe("Word", () => {
  it("writes heading styles, the inline bold, the list, a 4-column table, the link, the picture and the page size", async () => {
    let crops = 0;
    const bytes = await exportDocx(engine, layout, {
      cropImage: async () => {
        crops++;
        return PNG_1PX;
      },
    });
    const doc = unzipText(bytes, "word/document.xml");
    const styles = unzipText(bytes, "word/styles.xml");
    // Real Word heading styles: the id the app uses everywhere, named « heading 1 » for Word.
    expect(doc).toContain('<w:pStyle w:val="Titre1"/>');
    expect(doc).toContain('<w:pStyle w:val="Titre2"/>');
    expect(styles).toMatch(/w:styleId="Titre1"[^>]*><w:name w:val="heading 1"\/>/);
    expect(doc).toMatch(
      /<w:r><w:rPr><w:b\/>[^]*?<w:t xml:space="preserve">important<\/w:t><\/w:r><w:r><w:rPr><w:rFonts[^>]*\/><w:sz w:val="22"\/><\/w:rPr><w:t xml:space="preserve"> au milieu/,
    );
    const tbl = /<w:tbl>[\s\S]*?<\/w:tbl>/.exec(doc)?.[0] ?? "";
    expect(tbl.match(/<w:gridCol /g)).toHaveLength(4);
    expect(tbl.match(/<w:tr>/g)).toHaveLength(5);
    expect(tbl).toContain("3500,00");
    expect(doc).not.toMatch(/<\/w:tbl>[\s\S]*Cerises/);
    expect(doc).toContain("<w:numPr>");
    const rels = unzipText(bytes, "word/_rels/document.xml.rels");
    expect(doc).toMatch(
      /Voir le site <\/w:t><\/w:r><w:hyperlink r:id="rId\d+"><w:r>.*?<w:t xml:space="preserve">https:\/\/elium\.example\/rapport<\/w:t><\/w:r><\/w:hyperlink>/,
    );
    // Right-column paragraphs are not indented by the column offset.
    expect(doc).not.toContain('<w:ind w:left="1920"/>');
    expect(rels).toContain(`Target="${URL_TEXT}" TargetMode="External"`);
    expect(doc).toMatch(/<w:pgSz w:w="1190\d" w:h="1683\d"\/>/);
    expect(doc).toContain('<w:br w:type="page"/>');
    expect(crops).toBe(1);
    expect(Object.keys(unzipSync(bytes))).toContain("word/media/image1.png");
    expect(doc).toContain('<wp:extent cx="1270000" cy="635000"/>');
  });
});

describe("Excel", () => {
  it("one sheet per table with numeric cells", () => {
    const bytes = exportXlsx(layout);
    const wb = unzipText(bytes, "xl/workbook.xml");
    expect(wb).toContain('name="Page 1 — Tableau 1"');
    const sheet = unzipText(bytes, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain("<v>3500</v>");
    expect(sheet).toContain("<v>42</v>");
    expect(sheet).toContain("<v>3.5</v>");
    expect(sheet).toMatch(/<c r="A1"[^>]*t="inlineStr"><is><t xml:space="preserve">Article<\/t>/);
    // The header row is styled (bold) and frozen.
    expect(sheet).toMatch(/<c r="A1" s="[1-9]\d*"/);
    expect(sheet).toContain('ySplit="1"');
  });

  it("falls back to the text lines split on their gaps", async () => {
    const doc = await PDFDocument.create();
    const f = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([595, 842]);
    p.drawText("Nom", { x: 72, y: 700, size: 11, font: f });
    p.drawText("Montant 1 234,50", { x: 72, y: 680, size: 11, font: f });
    p.drawText("Total", { x: 72, y: 660, size: 11, font: f });
    p.drawText("12 %", { x: 300, y: 660, size: 11, font: f });
    const e = await PdfEngine.open(await doc.save());
    try {
      const bytes = exportXlsx(await extractLayout(e));
      expect(unzipText(bytes, "xl/workbook.xml")).toContain('name="Texte"');
      const sheet = unzipText(bytes, "xl/worksheets/sheet1.xml");
      expect(sheet).toContain("Montant 1 234,50");
      expect(sheet).toMatch(/<c r="B3"[^>]*><v>0.12<\/v>/);
    } finally {
      e.destroy();
    }
  });
});

describe("PowerPoint", () => {
  it("one slide per page at the page's size, with the text and the table", async () => {
    let asked = 0;
    const bytes = await exportPptx(engine, layout, {
      pageImage: async (page) => {
        asked++;
        return page === 0 ? PNG_1PX : null;
      },
    });
    expect(asked).toBe(2);
    const zip = unzipSync(bytes);
    expect(Object.keys(zip)).toContain("ppt/slides/slide2.xml");
    const pres = strFromU8(zip["ppt/presentation.xml"]);
    expect(pres).toContain(`<p:sldSz cx="${595 * 12700}" cy="${842 * 12700}"/>`);
    const s1 = strFromU8(zip["ppt/slides/slide1.xml"]);
    expect(s1).toContain("Rapport annuel");
    expect(s1).toContain("important");
    expect(s1).toContain("<a:tbl>");
    expect(s1).toContain("<p:pic>");
    // The title box sits where the title is: x = 72 pt less the text inset.
    expect(s1).toContain(`<a:off x="${72 * 12700 - 91440}"`);
    expect(strFromU8(zip["ppt/slides/slide2.xml"])).toContain("Deux colonnes");
  });
});

describe("RTF", () => {
  it("writes the heading, the table rows, the link and the page size", async () => {
    const rtf = await exportRtf(engine, layout);
    expect(rtf.startsWith("{\\rtf1\\ansi")).toBe(true);
    expect(rtf.endsWith("}")).toBe(true);
    expect(/^[\x00-\x7f]*$/.test(rtf)).toBe(true);
    expect(rtf).toContain("\\s1\\outlinelevel0");
    expect(rtf).toContain("Rapport annuel");
    expect(rtf).toContain("R\\u233?sultats");
    expect(rtf.match(/\\trowd/g)).toHaveLength(5);
    expect(rtf).toContain("3500,00\\cell");
    expect(rtf).toContain(`HYPERLINK "${URL_TEXT}"`);
    expect(rtf).toContain("\\paperw11900\\paperh16840");
    expect(rtf).toContain("\\pagebb");
    // Balanced braces.
    let depth = 0;
    for (let i = 0; i < rtf.length; i++) {
      if (rtf[i] === "\\") i++;
      else if (rtf[i] === "{") depth++;
      else if (rtf[i] === "}") depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it("escapes the format's own characters and non-ASCII text", () => {
    expect(rtfEscape("a{b}\\c")).toBe("a\\{b\\}\\\\c");
    expect(rtfEscape("été €")).toBe("\\u233?t\\u233? \\u8364?");
    expect(rtfEscape("😀")).toBe("\\u-10179?\\u-8704?");
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
  let engine: PdfEngine;
  let layout: PageText[];
  beforeAll(async () => {
    engine = await PdfEngine.open(await hostilePdf());
    layout = await extractLayout(engine);
  });
  afterAll(() => engine.destroy());

  /** Every XML part of an Office package parses, and none holds a forbidden character. */
  function expectWellFormed(bytes: Uint8Array): Record<string, string> {
    const parts: Record<string, string> = {};
    for (const [name, data] of Object.entries(unzipSync(bytes))) {
      if (!/\.(xml|rels)$/.test(name)) continue;
      const xml = strFromU8(data);
      parts[name] = xml;
      expect(FORBIDDEN.test(xml), name).toBe(false);
      expect(xmlError(xml), name).toBeNull();
    }
    return parts;
  }

  it("the layout really carries the forbidden characters (the test is meaningful)", () => {
    const text = layout.flatMap((p) => p.lines.map((l) => l.text)).join("\n");
    expect(text).toMatch(/\u0001/);
    expect(text).toMatch(/￾/);
  });

  it("Word, Excel and PowerPoint packages are well-formed XML", async () => {
    const docx = expectWellFormed(await exportDocx(engine, layout));
    expect(docx["word/document.xml"]).toContain("Hello");
    expect(docx["word/document.xml"]).toContain("Titre &lt;b&gt;&amp;amp;");
    expectWellFormed(exportXlsx(layout));
    const pptx = expectWellFormed(await exportPptx(engine, layout));
    expect(Object.values(pptx).some((x) => x.includes("Hello"))).toBe(true);
  });

  it("Excel never turns text printed in the PDF into a formula", () => {
    const parts = expectWellFormed(exportXlsx(layout));
    const sheets = Object.entries(parts).filter(([n]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    expect(sheets.length).toBeGreaterThan(0);
    const all = sheets.map(([, x]) => x).join("");
    expect(all).not.toContain("<f>");
    expect(all).toContain('t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;http://evil&quot;,&quot;x&quot;)</t>');
    expect(all).toContain(">@SUM(A1:A2)</t>");
    expect(all).toContain(">-2+3</t>");
    // Real numbers stay numbers.
    expect(all).toContain("<v>-14.5</v>");
  });

  it("RTF drops noncharacters with the controls", async () => {
    const rtf = await exportRtf(engine, layout, { title: "t\u0001￾" });
    expect(rtf).not.toContain("\\u-2?"); // U+FFFE
    expect(rtf).not.toContain("\\u-1?"); // U+FFFF
    expect(rtf).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
    expect(rtfEscape("a\u0001b￾c￿d\uD800e")).toBe("abcde");
    expect(rtfEscape("😀")).toBe("\\u-10179?\\u-8704?");
  });

  it("the shared XML writers clean titles, sheet names, notes and long cells", () => {
    const long = "x".repeat(40000);
    const bytes = workbookToXlsx({
      active: 0,
      sheets: [
        {
          name: "Bad\u0001Name￾",
          rows: 3,
          cols: 1,
          cells: { A1: "a\u0002b", A2: long, A3: "=" + "1+".repeat(5000) + "1" },
          notes: { A1: "note\u0003￿" },
        },
      ],
    });
    const parts = expectWellFormed(bytes);
    expect(parts["xl/workbook.xml"]).toContain('name="BadName"');
    const sheet = parts["xl/worksheets/sheet1.xml"]!;
    expect(sheet).toContain(">ab</t>");
    expect(sheet).toContain(`>${"x".repeat(32767)}</t>`);
    expect(sheet).not.toContain("x".repeat(32768));
    // A formula past Excel's 8 192 characters is kept as text, not written as <f>.
    expect(sheet).not.toContain("<f>");
    expect(Object.values(parts).join("")).toContain(">note</t>");
    // In the app's own export, a real formula is still a formula.
    const f = strFromU8(
      unzipSync(workbookToXlsx({ active: 0, sheets: [{ name: "S", rows: 1, cols: 1, cells: { A1: "=SUM(1,2)" } }] }))[
        "xl/worksheets/sheet1.xml"
      ]!,
    );
    expect(f).toContain("<f>SUM(1,2)</f>");
  });

  it("the sanitiser keeps tab, newline, astral characters and drops the rest", () => {
    expect(xmlSafeText("a\tb\nc\rd😀")).toBe("a\tb\nc\rd😀");
    expect(xmlSafeText("\u0000a\u0008\u000b\u000c\u001f￾￿b\uDC00\uD83D")).toBe("ab");
  });
});
