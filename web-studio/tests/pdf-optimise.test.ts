import { describe, expect, it } from "vitest";
import { zlibSync } from "fflate";
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from "pdf-lib";
import { optimiseDocument, spaceAudit } from "../src/pdf/ops/optimize";

/** Optimise: lossless pictures downsampled with their mask, duplicates stored once, space audit. */

function flateImage(doc: PDFDocument, w: number, h: number, comps: 1 | 3, smask?: PDFRef): PDFRef {
  // A photo-like picture: smooth, with noise (no repeating pattern zlib could squeeze).
  const px = new Uint8Array(w * h * comps);
  let seed = 12345;
  for (let i = 0; i < px.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    px[i] = (((i / comps) % w) / w) * 200 + (seed % 40);
  }
  const dict = doc.context.obj({
    Type: "XObject",
    Subtype: "Image",
    Width: w,
    Height: h,
    ColorSpace: comps === 3 ? "DeviceRGB" : "DeviceGray",
    BitsPerComponent: 8,
    Filter: "FlateDecode",
    ...(smask ? { SMask: smask } : {}),
  }) as PDFDict;
  return doc.context.register(PDFRawStream.of(dict, zlibSync(px)));
}

async function makeDoc(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const mask = flateImage(doc, 1600, 1200, 1);
  const photo = flateImage(doc, 1600, 1200, 3, mask);
  const copy1 = flateImage(doc, 300, 300, 3);
  const copy2 = flateImage(doc, 300, 300, 3);
  for (const im of [photo, copy1, copy2]) {
    const page = doc.addPage([400, 300]);
    page.node.set(PDFName.of("Resources"), doc.context.obj({ XObject: { Im1: im } }));
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("q 400 0 0 300 0 0 cm /Im1 Do Q")));
  }
  return doc;
}

const imageOf = (doc: PDFDocument, i: number) => {
  const xo = doc.getPage(i).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
  return xo.get(PDFName.of("Im1")) as PDFRef;
};

describe("optimise", () => {
  it("downsamples a lossless picture and its soft mask together, and stores duplicates once", async () => {
    const doc = await makeDoc();
    const before = (await doc.save()).length;
    const r = await optimiseDocument(doc, { imageDpi: 72 });
    expect(r.imagesRecompressed).toBe(1);
    expect(r.duplicatesMerged).toBe(1);
    const photo = doc.context.lookup(imageOf(doc, 0)) as PDFRawStream;
    const w = (photo.dict.lookup(PDFName.of("Width")) as PDFNumber).asNumber();
    expect(w).toBeLessThan(1600);
    const mask = doc.context.lookup(photo.dict.get(PDFName.of("SMask")) as PDFRef) as PDFRawStream;
    expect((mask.dict.lookup(PDFName.of("Width")) as PDFNumber).asNumber()).toBe(w);
    // Pages 2 and 3 now show the very same picture.
    expect(imageOf(doc, 1).toString()).toBe(imageOf(doc, 2).toString());
    const after = await doc.save();
    expect(after.length).toBeLessThan(before / 2);
    // Still a valid file.
    expect((await PDFDocument.load(after)).getPageCount()).toBe(3);
  });

  it("audits where the bytes go", async () => {
    const doc = await makeDoc();
    const bytes = await doc.save();
    const audit = spaceAudit(await PDFDocument.load(bytes), bytes.length);
    expect(audit.categories[0]!.label).toBe("Images");
    expect(audit.categories.reduce((n, c) => n + c.bytes, 0)).toBe(bytes.length);
  });

  it("reads /Filter and /DecodeParms given as one-element arrays (PNG predictor undone)", async () => {
    const doc = await PDFDocument.create();
    const w = 1600;
    const h = 1200;
    // Left half dark, right half light; rows written with the PNG « Up » predictor.
    const raw = new Uint8Array(h * (w * 3 + 1));
    for (let y = 0; y < h; y++) {
      raw[y * (w * 3 + 1)] = 2;
      if (y) continue; // « Up » rows after the first are all zero differences
      for (let x = 0; x < w; x++) raw.fill(x < w / 2 ? 20 : 235, 1 + x * 3, 4 + x * 3);
    }
    const dict = doc.context.obj({
      Type: "XObject",
      Subtype: "Image",
      Width: w,
      Height: h,
      ColorSpace: "DeviceRGB",
      BitsPerComponent: 8,
      Filter: ["FlateDecode"],
      DecodeParms: [{ Predictor: 15, Colors: 3, Columns: w }],
    }) as PDFDict;
    // Noise in the compressed bytes' size would let zlib win: force a large stream.
    const ref = doc.context.register(PDFRawStream.of(dict, zlibSync(raw, { level: 0 })));
    const page = doc.addPage([400, 300]);
    page.node.set(PDFName.of("Resources"), doc.context.obj({ XObject: { Im1: ref } }));
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("q 400 0 0 300 0 0 cm /Im1 Do Q")));
    const r = await optimiseDocument(doc, { imageDpi: 72, dedupe: false });
    expect(r.imagesRecompressed).toBe(1);
    const s = doc.context.lookup(ref) as PDFRawStream;
    const nw = (s.dict.lookup(PDFName.of("Width")) as PDFNumber).asNumber();
    const { unzlibSync } = await import("fflate");
    const px = unzlibSync(s.contents);
    expect(px[(10 * nw + 3) * 3]).toBe(20);
    expect(px[(10 * nw + nw - 3) * 3]).toBe(235);
  });
});
