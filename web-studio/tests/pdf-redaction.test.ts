import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, StandardFonts, decodePDFRawStream } from "pdf-lib";
import * as D from "../src/pdf/model/doc";
import { emptyState, newId, type Annot, type PdfState } from "../src/pdf/model/types";
import { buildPdf } from "../src/pdf/ops/save";
import { AFTER_REDACTION } from "../src/pdf/ops/redact";

/** Redaction and hidden information: nothing of what was removed may stay anywhere in the file. */

const W = 595,
  H = 842;
const baseState = (n: number): PdfState => ({ ...emptyState(), pages: D.pagesFromSource(n) });
/** A redaction mark over a PDF-space rect (x, y: bottom left). */
function mark(state: PdfState, pageIdx: number, x: number, y: number, w: number, h: number): PdfState {
  return D.addAnnot(state, {
    id: newId("an"),
    pageId: state.pages[pageIdx].id,
    kind: "redact",
    rect: { x, y: H - (y + h), w, h },
    color: "#000000",
    fill: "#000000",
    opacity: 1,
    strokeWidth: 0,
    author: "t",
    createdAt: "2026-01-01T00:00:00Z",
    modifiedAt: "2026-01-01T00:00:00Z",
    replies: [],
  } as Annot);
}

/** The needles still found in the file: in any object, streams decoded, strings as Latin-1 or UTF-16. */
async function leftovers(bytes: Uint8Array, needles: string[]): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const hay: string[] = [];
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (o instanceof PDFRawStream) {
      let data: Uint8Array = o.getContents();
      try {
        data = decodePDFRawStream(o).decode();
      } catch {
        /* raw */
      }
      hay.push(new TextDecoder("latin1").decode(data), o.dict.toString());
    } else hay.push(o.toString());
  }
  const all = hay.join("\n");
  const utf16hex = (t: string) =>
    [...t]
      .map((c) => c.charCodeAt(0).toString(16).padStart(4, "0"))
      .join("")
      .toUpperCase();
  return needles.filter(
    (n) =>
      all.includes(n) ||
      all.toUpperCase().includes(utf16hex(n)) ||
      all.toUpperCase().includes(Buffer.from(n, "latin1").toString("hex").toUpperCase()),
  );
}

describe("redaction", () => {
  it("removes text inside form XObjects (the page's other text stays)", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([W, H]);
    const inner = await PDFDocument.create();
    const ip = inner.addPage([W, H]);
    const f2 = await inner.embedFont(StandardFonts.Helvetica);
    ip.drawText("XOSECRET 4242", { x: 100, y: 700, size: 20, font: f2 });
    const [emb] = await doc.embedPdf(await inner.save());
    page.drawPage(emb, { x: 0, y: 0 });
    page.drawText("PAGETEXT visible", { x: 100, y: 500, size: 20, font });
    let st = baseState(1);
    st = mark(st, 0, 90, 690, 300, 35);
    const { bytes } = await buildPdf(await doc.save(), st, { applyRedactions: true });
    expect(await leftovers(bytes, ["XOSECRET", "PAGETEXT"])).toEqual(["PAGETEXT"]);
  });

  it("destroys the covered pixels of pictures, keeps the rest, and drops the originals", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([W, H]);
    // 100x100 RGB raw image, red, with a distinctive pixel row pattern.
    const px = new Uint8Array(100 * 100 * 3);
    for (let i = 0; i < px.length; i += 3) {
      px[i] = 0xab;
      px[i + 1] = 0xcd;
      px[i + 2] = 0xef;
    }
    const img = doc.context.stream(px, {
      Type: "XObject",
      Subtype: "Image",
      Width: 100,
      Height: 100,
      ColorSpace: "DeviceRGB",
      BitsPerComponent: 8,
    } as never);
    const ref = doc.context.register(img);
    page.node.setXObject(PDFName.of("Im1"), ref);
    const ref2 = doc.context.register(
      doc.context.stream(px.slice(), {
        Type: "XObject",
        Subtype: "Image",
        Width: 100,
        Height: 100,
        ColorSpace: "DeviceRGB",
        BitsPerComponent: 8,
      } as never),
    );
    page.node.setXObject(PDFName.of("Im2"), ref2);
    const cs = doc.context.stream("q 400 0 0 400 50 400 cm /Im1 Do Q q 400 0 0 300 50 50 cm /Im2 Do Q");
    page.node.set(PDFName.of("Contents"), doc.context.register(cs));
    let st = baseState(1);
    st = mark(st, 0, 60, 410, 40, 40); // 1% of Im1 (160000 area → 1600)
    st = mark(st, 0, 60, 60, 120, 100); // 10% of Im2
    const { bytes, report } = await buildPdf(await doc.save(), st, { applyRedactions: true });
    expect(report.redactedImages).toBe(2);
    const out = await PDFDocument.load(bytes);
    const images = out.context
      .enumerateIndirectObjects()
      .map(([, o]) => o)
      .filter(
        (o): o is PDFRawStream =>
          o instanceof PDFRawStream && o.dict.lookup(PDFName.of("Subtype"))?.toString() === "/Image",
      );
    expect(images).toHaveLength(2);
    const black = images.map((im) => {
      const d = decodePDFRawStream(im).decode();
      let n = 0;
      for (let i = 0; i < d.length; i += 3) if (!d[i] && !d[i + 1] && !d[i + 2]) n++;
      return n;
    });
    // About 1 % and 10 % of the pixels, not the whole pictures.
    expect(black[0]).toBeGreaterThan(80);
    expect(black[0]).toBeLessThan(200);
    expect(black[1]).toBeGreaterThan(900);
    expect(black[1]).toBeLessThan(1300);
  });

  it("removes form fields and comments under the area, and the hidden information chosen", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([W, H]);
    page.drawText("NAME: Jean DUPONT", { x: 100, y: 700, size: 18, font });
    const form = doc.getForm();
    const tf = form.createTextField("nom");
    tf.setText("FIELDSECRET");
    tf.addToPage(page, { x: 100, y: 600, width: 200, height: 24 });
    // Note annotation with /Contents, 20% under the area.
    const note = doc.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [100, 560, 120, 580],
      Contents: PDFString.of("NOTESECRET"),
    } as never);
    page.node.addAnnot(doc.context.register(note));
    // Outline with the redacted words
    const ctx = doc.context;
    const item = ctx.register(
      ctx.obj({ Title: PDFString.of("OUTLINE Jean DUPONT"), Dest: [page.ref, PDFName.of("Fit")] } as never),
    );
    const root = ctx.register(ctx.obj({ Type: "Outlines", First: item, Last: item, Count: 1 } as never));
    (ctx.lookup(item) as PDFDict).set(PDFName.of("Parent"), root);
    doc.catalog.set(PDFName.of("Outlines"), root);
    doc.setTitle("TITLE Jean DUPONT");
    doc.setSubject("SUBJ DUPONT");
    // Structure-tree style alt text + ActualText in a marked-content BDC on the page.
    const se = ctx.register(
      ctx.obj({
        Type: "StructElem",
        S: "P",
        Alt: PDFString.of("ALTSECRET DUPONT"),
        ActualText: PDFString.of("ACTUALSECRET DUPONT"),
      } as never),
    );
    const str = ctx.register(ctx.obj({ Type: "StructTreeRoot", K: [se] } as never));
    doc.catalog.set(PDFName.of("StructTreeRoot"), str);
    // Page thumbnail image
    const thumb = ctx.register(
      ctx.stream(new Uint8Array([1, 2, 3, 0x54, 0x48, 0x55, 0x4d, 0x42]), {
        Width: 1,
        Height: 1,
        ColorSpace: "DeviceRGB",
        BitsPerComponent: 8,
      } as never),
    );
    page.node.set(PDFName.of("Thumb"), thumb);
    // Named JS
    doc.addJavaScript("js1", "var s='JSSECRET DUPONT';");
    let st = baseState(1);
    st = mark(st, 0, 90, 555, 220, 75); // covers field fully, note fully
    st = mark(st, 0, 150, 695, 120, 25); // "Jean DUPONT"
    const src = await doc.save();
    const plain = (await buildPdf(src, st, { applyRedactions: true })).bytes;
    expect(await leftovers(plain, ["FIELDSECRET", "NOTESECRET"])).toEqual([]);
    const out = await PDFDocument.load(plain);
    expect(out.getForm().getFields()).toHaveLength(0);
    const clean = (await buildPdf(src, st, { applyRedactions: true, hiddenInfo: AFTER_REDACTION })).bytes;
    expect(await leftovers(clean, ["DUPONT", "FIELDSECRET", "NOTESECRET"])).toEqual([]);
  });

  it("removes line art under the area (a shape mostly covered)", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([W, H]);
    const ctx = doc.context;
    const glyph = ctx.register(ctx.stream("500 0 0 0 500 700 d1 0 0 500 700 re f"));
    const t3 = ctx.register(
      ctx.obj({
        Type: "Font",
        Subtype: "Type3",
        FontBBox: [0, 0, 500, 700],
        FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: { a: glyph },
        Encoding: {
          Type: "Encoding",
          Differences: [
            65,
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
            "a",
          ],
        },
        FirstChar: 65,
        LastChar: 90,
        Widths: Array(26).fill(500),
        Resources: {},
      } as never),
    );
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    page.node.setFontDictionary(PDFName.of("T3"), t3);
    page.node.setFontDictionary(PDFName.of("F1"), helv.ref);
    const cs = ctx.stream(
      "BT /T3 20 Tf 100 700 Td (TYPETHREESECRET) Tj ET " +
        "BT 3 Tr /F1 20 Tf 100 600 Td (OCRSECRET) Tj ET " +
        "BT /F1 20 Tf 100 500 Td [(KER) -120 (NSECRET) 50 (X)] TJ ET " +
        "BT /F1 20 Tf 100 400 Td (VISIBLE) Tj ET " +
        "0 0 1 rg 100 300 150 30 re f",
    );
    page.node.set(PDFName.of("Contents"), ctx.register(cs));
    let st = baseState(1);
    st = mark(st, 0, 90, 690, 400, 30);
    st = mark(st, 0, 90, 590, 400, 30);
    st = mark(st, 0, 90, 490, 400, 30);
    st = mark(st, 0, 90, 290, 200, 50); // vector rect
    const { bytes, report } = await buildPdf(await doc.save(), st, { applyRedactions: true });
    expect(await leftovers(bytes, ["TYPETHREESECRET", "OCRSECRET", "KER", "NSECRET", "VISIBLE"])).toEqual(["VISIBLE"]);
    expect(await leftovers(bytes, ["150 30 re"])).toEqual([]);
    void report;
  });
});

describe("sanitise (Nettoyer le document)", () => {
  it("removes every kind of hidden information it reports", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.drawText("visible", { x: 100, y: 700, size: 18, font });
    const ctx = doc.context;
    // white / invisible text (hidden text)
    const cs = ctx.stream(
      "BT 3 Tr /F1 12 Tf 100 100 Td (HIDDENTEXTSECRET) Tj ET BT 1 1 1 rg /F1 12 Tf 100 80 Td (WHITETEXTSECRET) Tj ET",
    );
    page.node.setFontDictionary(PDFName.of("F1"), font.ref);
    page.node.addContentStream(ctx.register(cs));
    // Link with JavaScript action, link with URI, comment with contents
    const js = ctx.register(
      ctx.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [0, 0, 50, 50],
        A: { S: "JavaScript", JS: PDFString.of("app.alert('LINKJSSECRET')") },
      } as never),
    );
    const uri = ctx.register(
      ctx.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [60, 0, 110, 50],
        A: { S: "URI", URI: PDFString.of("https://URISECRET.example/") },
      } as never),
    );
    const launch = ctx.register(
      ctx.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [120, 0, 170, 50],
        A: { S: "Launch", F: PDFString.of("LAUNCHSECRET.exe") },
      } as never),
    );
    const comment = ctx.register(
      ctx.obj({
        Type: "Annot",
        Subtype: "Text",
        Rect: [200, 0, 220, 20],
        Contents: PDFString.of("COMMENTSECRET"),
        T: PDFString.of("AUTHORSECRET"),
      } as never),
    );
    page.node.addAnnot(js);
    page.node.addAnnot(uri);
    page.node.addAnnot(launch);
    page.node.addAnnot(comment);
    // Form field with value + field-level JS on a widget /A
    const form = doc.getForm();
    const tf = form.createTextField("f");
    tf.setText("FORMVALUESECRET");
    tf.addToPage(page, { x: 300, y: 300, width: 100, height: 20 });
    tf.acroField
      .getWidgets()[0]
      .dict.set(PDFName.of("A"), ctx.obj({ S: "JavaScript", JS: PDFString.of("WIDGETJSSECRET") } as never));
    // Outline with JS action
    const item = ctx.register(
      ctx.obj({
        Title: PDFString.of("OUTLINESECRET"),
        A: { S: "JavaScript", JS: PDFString.of("OUTLINEJSSECRET") },
      } as never),
    );
    const root = ctx.register(ctx.obj({ Type: "Outlines", First: item, Last: item, Count: 1 } as never));
    (ctx.lookup(item) as PDFDict).set(PDFName.of("Parent"), root);
    doc.catalog.set(PDFName.of("Outlines"), root);
    // Hidden layer
    const ocg = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("LAYERSECRET") } as never));
    doc.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: [ocg], D: { OFF: [ocg], Order: [ocg] } } as never));
    // Embedded file (name tree), doc JS, custom Info, PieceInfo, Thumb, struct tree
    await doc.attach(new TextEncoder().encode("ATTACHSECRET"), "secret.txt", { mimeType: "text/plain" });
    doc.addJavaScript("x", "var z='DOCJSSECRET'");
    const info = ctx.lookup(ctx.trailerInfo.Info) as PDFDict;
    info.set(PDFName.of("Company"), PDFString.of("CUSTOMINFOSECRET"));
    info.set(PDFName.of("Author"), PDFString.of("INFOAUTHORSECRET"));
    page.node.set(PDFName.of("PieceInfo"), ctx.obj({ App: { Private: PDFString.of("PIECEINFOSECRET") } } as never));
    doc.catalog.set(PDFName.of("PieceInfo"), ctx.obj({ App: { Private: PDFString.of("CATPIECESECRET") } } as never));
    page.node.set(PDFName.of("Thumb"), ctx.register(ctx.stream("THUMBSECRET", { Width: 1, Height: 1 } as never)));
    doc.catalog.set(
      PDFName.of("StructTreeRoot"),
      ctx.register(
        ctx.obj({ Type: "StructTreeRoot", K: [ctx.obj({ S: "P", Alt: PDFString.of("ALTSECRET") } as never)] } as never),
      ),
    );
    doc.catalog.set(
      PDFName.of("Metadata"),
      ctx.register(ctx.stream("<x:xmpmeta>XMPSECRET</x:xmpmeta>", { Type: "Metadata", Subtype: "XML" } as never)),
    );
    const src = await doc.save({ useObjectStreams: false });
    const { bytes, report } = await buildPdf(src, { ...emptyState(), pages: D.pagesFromSource(1) }, { sanitise: true });
    const left = await leftovers(bytes, [
      "HIDDENTEXTSECRET",
      "LINKJSSECRET",
      "URISECRET",
      "LAUNCHSECRET",
      "COMMENTSECRET",
      "AUTHORSECRET",
      "WIDGETJSSECRET",
      "OUTLINESECRET",
      "OUTLINEJSSECRET",
      "LAYERSECRET",
      "ATTACHSECRET",
      "DOCJSSECRET",
      "CUSTOMINFOSECRET",
      "INFOAUTHORSECRET",
      "PIECEINFOSECRET",
      "CATPIECESECRET",
      "THUMBSECRET",
      "ALTSECRET",
      "XMPSECRET",
      "visible",
    ]);
    expect(left).toEqual(["visible"]);
    // The form was flattened: its value is page content now, no field is left.
    expect((await PDFDocument.load(bytes)).getForm().getFields()).toHaveLength(0);
    expect(report.warnings.join(" ")).toContain("Informations masquées supprimées");
  });
});
