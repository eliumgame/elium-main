import { describe, it, expect } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb } from "pdf-lib";
import { parseContentStream, walkText } from "../src/pdf/core/contentstream";
import { decodeShowText, loadPageFonts, widthFnFor } from "../src/pdf/core/fontmetrics";
import { readPageContentBytes } from "../src/pdf/ops/content";
import { stripPageMarks } from "../src/pdf/ops/decorate";
import {
  appendPdfPages,
  extractPages,
  mergeDocuments,
  purgeRemovedPages,
  readPageLabelDefs,
  splitDocument,
  writePageLabels,
} from "../src/pdf/ops/organize";
import { buildPdf } from "../src/pdf/ops/save";
import * as D from "../src/pdf/model/doc";
import { emptyState, newId, type Annot, type PdfState } from "../src/pdf/model/types";

/** Defects found by the adversarial review of the page organisation work (T5), kept fixed. */

// --- cropredact ---
async function shownText(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const ops = parseContentStream(readPageContentBytes(page));
  const fonts = await loadPageFonts(page);
  return walkText(ops, widthFnFor(fonts))
    .map((s) => decodeShowText(s.state.font ? fonts.get(s.state.font) : undefined, s.bytes))
    .join(" ");
}
describe("crop + redact", () => {
  it("redaction drawn on a cropped page hits what is under it", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([595, 842]);
    p.drawText("AAAA", { x: 60, y: 760, size: 18, font, color: rgb(0, 0, 0) });
    p.drawText("BBBB", { x: 260, y: 560, size: 18, font, color: rgb(0, 0, 0) });
    const src = await doc.save();
    let s: PdfState = { ...emptyState(), pages: D.pagesFromSource(1) };
    s = D.cropPages(s, [s.pages[0].id], { top: 200, left: 200, right: 0, bottom: 0 });
    const now = new Date().toISOString();
    s = D.addAnnot(s, {
      id: newId("an"),
      pageId: s.pages[0].id,
      kind: "redact",
      rect: { x: 50, y: 58, w: 200, h: 36 },
      color: "#000",
      fill: "#000000",
      opacity: 1,
      strokeWidth: 0,
      author: "a",
      createdAt: now,
      modifiedAt: now,
      replies: [],
    } as Annot);
    const { bytes } = await buildPdf(src, s, { applyRedactions: true });
    const t = await shownText(bytes);
    expect(t).toContain("AAAA");
    expect(t).not.toContain("BBBB");
  });
  it("redaction drawn BEFORE cropping still hits its text", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([595, 842]);
    p.drawText("AAAA", { x: 60, y: 760, size: 18, font, color: rgb(0, 0, 0) });
    p.drawText("BBBB", { x: 260, y: 560, size: 18, font, color: rgb(0, 0, 0) });
    const src = await doc.save();
    let s: PdfState = { ...emptyState(), pages: D.pagesFromSource(1) };
    const now = new Date().toISOString();
    s = D.addAnnot(s, {
      id: newId("an"),
      pageId: s.pages[0].id,
      kind: "redact",
      rect: { x: 50, y: 58, w: 200, h: 36 },
      color: "#000",
      fill: "#000000",
      opacity: 1,
      strokeWidth: 0,
      author: "a",
      createdAt: now,
      modifiedAt: now,
      replies: [],
    } as Annot);
    s = D.cropPages(s, [s.pages[0].id], { top: 40, left: 0, right: 0, bottom: 0 });
    const { bytes } = await buildPdf(src, s, { applyRedactions: true });
    const t = await shownText(bytes);
    expect(t).toContain("BBBB");
    expect(t).not.toContain("AAAA");
  });
});

// --- strip ---
describe("strip", () => {
  it("keeps page content wrapped around an Acrobat mark", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([600, 800]);
    const ctx = doc.context;
    const fm = ctx.register(
      ctx.stream("0 0 m 10 10 l S", {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, 100, 100],
        PieceInfo: { ADBE_CompoundType: { Private: PDFName.of("Watermark") } },
      } as never),
    );
    const content = ctx.register(
      ctx.stream(
        `/Span <</MCID 0>> BDC BT /F1 12 Tf 50 700 Td (Hello) Tj ET\n/Artifact <</Subtype /Watermark /Type /Pagination>> BDC q /Fm0 Do Q EMC\nEMC`,
      ),
    );
    page.node.set(PDFName.of("Contents"), content);
    page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: font.ref }, XObject: { Fm0: fm } } as never));
    expect(stripPageMarks(doc, page)).toBe(1);
    const after = new TextDecoder("latin1").decode(readPageContentBytes(page));
    expect(after).toContain("Hello");
  });
});

// --- extractfield ---
describe("extract", () => {
  it("does not drag in pages left out through a shared field", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = [0, 1, 2].map((i) => {
      const p = doc.addPage();
      p.drawText(`Page ${i + 1} text`, { x: 50, y: 700, font, size: 12 });
      return p;
    });
    const f = doc.getForm().createTextField("nom");
    f.addToPage(pages[0], { x: 50, y: 50, width: 100, height: 20 });
    f.addToPage(pages[2], { x: 50, y: 50, width: 100, height: 20 });
    const out = await PDFDocument.load(await extractPages(await doc.save(), [0]));
    const pageDicts = out.context
      .enumerateIndirectObjects()
      .filter(([, o]) => o instanceof PDFDict && o.lookup(PDFName.of("Type"))?.toString() === "/Page");
    expect(pageDicts.length).toBe(1);
  });
});

// --- links ---

async function linkedSource() {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([600, 800]);
  const pages = doc.getPages();
  const ctx = doc.context;
  const link = ctx.register(
    ctx.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [0, 0, 100, 100],
      Dest: [pages[1].ref, PDFName.of("Fit")],
    } as never),
  );
  pages[0].node.set(PDFName.of("Annots"), ctx.obj([link]));
  return doc.save();
}
function linkTargets(doc: PDFDocument) {
  const refs = new Set(doc.getPages().map((p) => p.ref.toString()));
  const res: string[] = [];
  doc.getPages().forEach((p, i) => {
    const a = p.node.Annots();
    if (!(a instanceof PDFArray)) return;
    for (let k = 0; k < a.size(); k++) {
      const d = a.lookup(k) as PDFDict;
      const dest = d.lookup(PDFName.of("Dest")) as PDFArray;
      res.push(`page${i} link -> ${dest.get(0)} inTree=${refs.has(String(dest.get(0)))}`);
    }
  });
  return res;
}
describe("links", () => {
  it("extract keeps intra links", async () => {
    const out = await PDFDocument.load(await extractPages(await linkedSource(), [0, 1]));
    const r = linkTargets(out);
    const parts = await splitDocument(await linkedSource(), { kind: "ranges", spec: "1-2;3" }, "x");
    const p0 = await PDFDocument.load(parts[0].bytes);
    expect(linkTargets(p0)).toHaveLength(1);
    const target = await PDFDocument.create();
    target.addPage();
    await appendPdfPages(target, [{ name: "a.pdf", bytes: await linkedSource() }]);
    expect(linkTargets(target)[0]).toContain("inTree=true");
    expect(r.length).toBe(1);
  });
});

// --- insertlabels ---
describe("insert keeps labels on their pages", () => {
  it("roman front matter stays on the old pages", async () => {
    const host = await PDFDocument.create();
    for (let i = 0; i < 4; i++) host.addPage([300 + i, 400]);
    writePageLabels(host, [
      { style: "roman", prefix: "", num: 1 },
      { style: "roman", prefix: "", num: 2 },
      { style: "decimal", prefix: "", num: 1 },
      { style: "decimal", prefix: "", num: 2 },
    ]);
    const other = await PDFDocument.create();
    other.addPage([100, 100]);
    await appendPdfPages(host, [{ name: "a.pdf", bytes: await other.save() }], undefined, 2);
    const defs = readPageLabelDefs(host)!;
    const res = host.getPages().map((p, i) => `${p.getWidth()}:${defs[i]?.style}${defs[i]?.num}`);
    // old page 3 (width 302) must still be decimal 1
    expect(res[3]).toBe("302:decimal1");
  });
});

// --- struct ---
describe("struct", () => {
  it("element of a removed page does not fall onto a kept page", async () => {
    const doc = await PDFDocument.create();
    const p1 = doc.addPage();
    const p2 = doc.addPage();
    const ctx = doc.context;
    const para = ctx.register(ctx.obj({ Type: "StructElem", S: "P", Pg: p2.ref, K: [0] } as never));
    const docEl = ctx.register(ctx.obj({ Type: "StructElem", S: "Document", Pg: p1.ref, K: [para] } as never));
    doc.catalog.set(PDFName.of("StructTreeRoot"), ctx.register(ctx.obj({ Type: "StructTreeRoot", K: docEl } as never)));
    const order = doc.getPages();
    doc.removePage(1);
    purgeRemovedPages(doc, order, new Set([`${p1.ref.objectNumber} 0`]));
    const d = ctx.lookup(para) as PDFDict;
    // Pg removed while K [0] stays: MCID 0 now inherits the Document's page (page 1).
    const pg = d.get(PDFName.of("Pg"));
    const k = d.lookup(PDFName.of("K"));
    expect({ pg: String(pg), k: String(k) }).toEqual({ pg: "undefined", k: "[ ]" });
  });
});

// --- split ---
describe("split by size", () => {
  it("shared image counted once per page", async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const data = new Uint8Array(300 * 1000);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 256) | 0;
    const img = ctx.register(
      PDFRawStream.of(
        ctx.obj({
          Type: "XObject",
          Subtype: "Image",
          Width: 500,
          Height: 200,
          BitsPerComponent: 8,
          ColorSpace: "DeviceRGB",
          Length: data.length,
        } as never) as never,
        data,
      ),
    );
    for (let i = 0; i < 20; i++) {
      const p = doc.addPage();
      p.node.set(PDFName.of("Resources"), ctx.obj({ XObject: { Im0: img } } as never));
      p.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("q 500 0 0 200 0 0 cm /Im0 Do Q")));
    }
    const bytes = await doc.save();
    const parts = await splitDocument(bytes, { kind: "maxSize", bytes: 1_000_000 }, "x");
    expect(parts).toHaveLength(1);
  });
});

// --- a page taken twice ---
describe("a page combined twice", () => {
  it("gets its own annotations: one widget per page, one field", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    doc.getForm().createTextField("nom").addToPage(page, { x: 20, y: 20, width: 100, height: 20 });
    const res = await mergeDocuments([{ name: "a.pdf", bytes: await doc.save(), pages: [0, 0] }], { outline: false });
    const out = await PDFDocument.load(res.bytes);
    const annots = out.getPages().map((p) => (p.node.Annots() as PDFArray).get(0).toString());
    expect(annots[0]).not.toBe(annots[1]);
    const fields = out.getForm().getFields();
    expect(fields.map((f) => f.getName())).toEqual(["nom"]);
    expect(fields[0].acroField.getWidgets()).toHaveLength(2);
  });
});
