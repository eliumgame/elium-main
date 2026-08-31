import { describe, it, expect } from "vitest";
import { PDFDocument, PDFName, PDFRawStream, type PDFContext, type PDFDict } from "pdf-lib";
import { jpegComponentCount, isJpegSafeToRecompress } from "../src/pdf/ops/optimize";

/**
 * Guards against silent colour corruption: `optimiseDocument()` must not hand
 * a CMYK (or otherwise non-RGB/Gray) JPEG to the browser's generic decoder —
 * it assumes sRGB and would re-encode with wrong colours, invisible on screen
 * but a real problem for a prepress/CMYK document. These are pure functions
 * (no `document`/`canvas`), unlike the rest of `optimize.ts`, which needs a
 * DOM the vitest node environment does not provide.
 */

function makeImageDict(ctx: PDFContext, props: Record<string, unknown>): PDFDict {
  return ctx.obj(props as never) as PDFDict;
}

/** Builds a synthetic baseline-JPEG byte sequence with just enough of a real
 *  header (SOI, then a SOF0 marker with the given component count) for
 *  `jpegComponentCount` to parse — the rest of the "image" is irrelevant. */
function fakeJpegBytes(numComponents: number): Uint8Array {
  const bytes: number[] = [0xff, 0xd8]; // SOI
  // SOF0 marker: FF C0, length=8+3*n (we only declare 1 component's worth of
  // data after the header fields the parser reads, length value itself isn't
  // used by jpegComponentCount beyond skipping unrelated markers).
  const len = 8;
  bytes.push(0xff, 0xc0, (len >> 8) & 0xff, len & 0xff);
  bytes.push(8); // precision
  bytes.push(0, 10, 0, 10); // height=10, width=10
  bytes.push(numComponents);
  bytes.push(0xff, 0xd9); // EOI
  return new Uint8Array(bytes);
}

describe("optimize.ts — jpegComponentCount", () => {
  it("reads the component count from a SOF0 marker (grayscale = 1)", () => {
    expect(jpegComponentCount(fakeJpegBytes(1))).toBe(1);
  });
  it("reads the component count from a SOF0 marker (YCbCr/RGB = 3)", () => {
    expect(jpegComponentCount(fakeJpegBytes(3))).toBe(3);
  });
  it("reads the component count from a SOF0 marker (CMYK/YCCK = 4)", () => {
    expect(jpegComponentCount(fakeJpegBytes(4))).toBe(4);
  });
  it("returns null for a stream with no SOF marker", () => {
    expect(jpegComponentCount(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});

describe("optimize.ts — isJpegSafeToRecompress", () => {
  it("allows DeviceRGB and DeviceGray", async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    expect(isJpegSafeToRecompress(makeImageDict(ctx, { ColorSpace: "DeviceRGB" }), fakeJpegBytes(3))).toBe(true);
    expect(isJpegSafeToRecompress(makeImageDict(ctx, { ColorSpace: "DeviceGray" }), fakeJpegBytes(1))).toBe(true);
  });

  it("refuses DeviceCMYK even when the JPEG header alone would look ambiguous", async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const dict = makeImageDict(ctx, { ColorSpace: "DeviceCMYK" });
    // Header claims 3 components (would pass on header alone) — the explicit
    // /ColorSpace must still win and refuse it.
    expect(isJpegSafeToRecompress(dict, fakeJpegBytes(3))).toBe(false);
  });

  it("refuses an ICCBased colour space with N=4 (CMYK ICC profile)", async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const iccStreamRef = ctx.register(PDFRawStream.of(makeImageDict(ctx, { N: 4 }), new Uint8Array(4)));
    const dict = makeImageDict(ctx, { ColorSpace: ctx.obj([PDFName.of("ICCBased"), iccStreamRef]) });
    expect(isJpegSafeToRecompress(dict, fakeJpegBytes(3))).toBe(false);
  });

  it("allows an ICCBased colour space with N=3 (RGB ICC profile)", async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const iccStreamRef = ctx.register(PDFRawStream.of(makeImageDict(ctx, { N: 3 }), new Uint8Array(4)));
    const dict = makeImageDict(ctx, { ColorSpace: ctx.obj([PDFName.of("ICCBased"), iccStreamRef]) });
    expect(isJpegSafeToRecompress(dict, fakeJpegBytes(3))).toBe(true);
  });

  it("refuses Separation/DeviceN/Lab/Indexed colour spaces", async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    for (const kind of ["Separation", "DeviceN", "Lab", "Indexed"]) {
      const dict = makeImageDict(ctx, { ColorSpace: ctx.obj([PDFName.of(kind)]) });
      expect(isJpegSafeToRecompress(dict, fakeJpegBytes(3))).toBe(false);
    }
  });

  it("falls back to the JPEG's own SOF component count when /ColorSpace is absent", async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const dict = makeImageDict(ctx, {});
    expect(isJpegSafeToRecompress(dict, fakeJpegBytes(3))).toBe(true); // RGB/YCbCr
    expect(isJpegSafeToRecompress(dict, fakeJpegBytes(1))).toBe(true); // grayscale
    expect(isJpegSafeToRecompress(dict, fakeJpegBytes(4))).toBe(false); // CMYK/YCCK
  });

  it("is conservative (refuses) when neither /ColorSpace nor the JPEG header settle it", async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const dict = makeImageDict(ctx, {});
    expect(isJpegSafeToRecompress(dict, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBe(false);
  });
});
