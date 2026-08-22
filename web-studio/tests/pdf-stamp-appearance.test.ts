import { describe, it, expect } from "vitest";
import { zlibSync } from "fflate";
import { PDFDocument, PDFName, PDFRawStream, type PDFContext, type PDFRef } from "pdf-lib";
// Node-compatible build (no worker/DOM needed) — mirrors what `PdfEngine` runs
// through Vite in the browser, just without the bundler-specific worker setup.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { hasImportableAnnots, importPageAnnots, resolveStampAppearanceImages, type RawAnnotation } from "../src/pdf/ops/import-annots";
import { protectDocument } from "../src/pdf/ops/security";

/**
 * End-to-end coverage for the real import path this codebase actually runs
 * (`PdfWorkspace.openBytes`): pdf.js's own `getAnnotations()` for the raw
 * markup pdf.js can see, `resolveStampAppearanceImages` for the picture pdf.js
 * cannot, merged by annotation id, then `importPageAnnots`. Unlike
 * `pdf-import-annots.test.ts` (which feeds `importPageAnnots` hand-built
 * `RawAnnotation`s), this builds a real multi-annotation, multi-page PDF with
 * pdf-lib and parses it back with the project's actual pdf.js dependency, so a
 * wrong id format or a wrong correlation would show up here, not just in a
 * fixture that assumes the plumbing already works.
 */

// A tiny but genuine baseline JPEG (16×12, red/blue halves) produced by a real
// encoder (@napi-rs/canvas) — not hand-crafted bytes — so the DCTDecode
// passthrough path is exercised against a file an actual tool could produce.
const RED_BLUE_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAMABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAABgf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAB//EABkRAAIDAQAAAAAAAAAAAAAAAAAHRIPCw//aAAwDAQACEQMRAD8AhQiXCJRV02vYmOOBbzP/2Q==";

function jpegBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(RED_BLUE_JPEG_B64, "base64"));
}

/** `/Length` is derived from `contents` automatically at save time (see
 * `PDFStream.updateDict`) — no need to set it by hand. */
function registerRawStream(ctx: PDFContext, dictProps: Record<string, unknown>, contents: Uint8Array): PDFRef {
  return ctx.register(PDFRawStream.of(ctx.obj(dictProps as never), contents));
}

/** A hand-built raw Image XObject (FlateDecode, DeviceRGB) — the "no camera, no
 * Acrobat, just a tool writing pixels" path, distinct from the JPEG above. */
function registerSolidRgbImage(ctx: PDFContext, w: number, h: number, rgb: [number, number, number]): PDFRef {
  const samples = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) samples.set(rgb, i * 3);
  return registerRawStream(
    ctx,
    { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "FlateDecode" },
    zlibSync(samples),
  );
}

/** A Form XObject `/AP /N` that draws exactly one image XObject over its BBox. */
function registerAppearanceForm(ctx: PDFContext, imageRef: PDFRef, w: number, h: number): PDFRef {
  return registerRawStream(
    ctx,
    { Type: "XObject", Subtype: "Form", BBox: [0, 0, w, h], Resources: { XObject: { Im0: imageRef } } },
    new TextEncoder().encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`),
  );
}

function registerStampAnnot(ctx: PDFContext, rect: number[], apRef?: PDFRef): PDFRef {
  return ctx.register(
    ctx.obj({
      Type: "Annot",
      Subtype: "Stamp",
      Rect: rect,
      F: 4,
      ...(apRef ? { AP: { N: apRef } } : {}),
    } as never),
  );
}

/** pdf.js does not surface a Stamp's `/Name` or `/Subj` as annotation metadata
 * (verified empirically against this project's own pdfjs-dist build — both
 * come back `undefined`), so stamps are told apart here by their box size,
 * which the fixture controls and each stamp below has a distinct one. */
const findByBoxSize = (annots: readonly { rect: { w: number; h: number } }[], w: number, h: number) =>
  annots.find((a) => Math.round(a.rect.w) === w && Math.round(a.rect.h) === h);

function registerSquareAnnot(ctx: PDFContext, rect: number[]): PDFRef {
  return ctx.register(ctx.obj({ Type: "Annot", Subtype: "Square", Rect: rect, C: [0.2, 0.2, 0.2], F: 4 } as never));
}

/** Builds the two-page fixture: page 0 has a real JPEG stamp sandwiched
 * between two Squares (registered out of `/Annots` order, on purpose) plus a
 * text-only stamp with no picture at all; page 1 has a second, differently
 * coloured stamp — proof the per-page map does not conflate the two. */
async function buildFixtureDoc(): Promise<{ doc: PDFDocument; refs: { jpeg: PDFRef; textOnly: PDFRef; green: PDFRef } }> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;

  const page0 = doc.addPage([400, 300]);
  const sq1 = registerSquareAnnot(ctx, [10, 10, 60, 60]);
  const jpegImg = registerRawStream(
    ctx,
    { Type: "XObject", Subtype: "Image", Width: 16, Height: 12, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode" },
    jpegBytes(),
  );
  const jpegAp = registerAppearanceForm(ctx, jpegImg, 160, 120);
  const jpegStamp = registerStampAnnot(ctx, [100, 100, 260, 220], jpegAp); // 160×120
  const sq2 = registerSquareAnnot(ctx, [300, 200, 350, 250]);
  const textOnlyStamp = registerStampAnnot(ctx, [50, 200, 150, 250]); // 100×50, no /AP at all
  // Deliberately not registration order: sq2, textOnlyStamp, jpegStamp, sq1.
  page0.node.set(PDFName.of("Annots"), ctx.obj([sq2, textOnlyStamp, jpegStamp, sq1]));

  const page1 = doc.addPage([400, 300]);
  const greenImg = registerSolidRgbImage(ctx, 5, 5, [24, 168, 60]);
  const greenAp = registerAppearanceForm(ctx, greenImg, 50, 50);
  const greenStamp = registerStampAnnot(ctx, [20, 20, 70, 70], greenAp); // 50×50
  page1.node.set(PDFName.of("Annots"), ctx.obj([greenStamp]));

  return { doc, refs: { jpeg: jpegStamp, textOnly: textOnlyStamp, green: greenStamp } };
}

/** Mirrors exactly what `PdfWorkspace.openBytes` does: fetch pdf.js's raw
 * annotations for a page, resolve the appearance map once, merge by id. */
async function importRealPage(
  bytes: Uint8Array,
  pageIndex: number,
  pageHeight: number,
  appearances: Map<number, Map<string, NonNullable<RawAnnotation["appearanceImage"]>>>,
  password?: string,
) {
  const task = pdfjsLib.getDocument({ data: bytes.slice(), password });
  const pdfDoc = await task.promise;
  const page = await pdfDoc.getPage(pageIndex + 1);
  const raw = (await page.getAnnotations({ intent: "any" })) as RawAnnotation[];
  expect(hasImportableAnnots(raw)).toBe(true);
  const pageAppearances = appearances.get(pageIndex);
  const withImages = pageAppearances?.size
    ? raw.map((a) => (a.id && pageAppearances.has(a.id) ? { ...a, appearanceImage: pageAppearances.get(a.id) } : a))
    : raw;
  await task.destroy();
  return { raw, result: importPageAnnots(withImages, `p${pageIndex}`, pageHeight, "Moi") };
}

describe("Real end-to-end: a genuine multi-annotation PDF keeps its stamp pictures", () => {
  it("attaches the right picture to the right stamp, and none to a text-only one", async () => {
    const { doc } = await buildFixtureDoc();
    const bytes = await doc.save();

    const appearances = await resolveStampAppearanceImages(bytes);
    expect(appearances.get(0)?.size).toBe(1); // only the JPEG stamp resolved on page 0
    expect(appearances.get(1)?.size).toBe(1); // the green stamp resolved on page 1

    const { raw: raw0, result: page0 } = await importRealPage(bytes, 0, 300, appearances);
    expect(raw0).toHaveLength(4);
    expect(page0.annots).toHaveLength(4);

    const squares = page0.annots.filter((a) => a.kind === "square");
    expect(squares).toHaveLength(2);
    for (const sq of squares) expect((sq as { src?: string }).src).toBeUndefined();

    const jpegStamp = findByBoxSize(page0.annots, 160, 120);
    expect(jpegStamp?.kind).toBe("stamp");
    expect(jpegStamp?.src).toMatch(/^data:image\/jpeg;base64,/);
    const decodedJpeg = Uint8Array.from(Buffer.from(jpegStamp!.src!.split(",")[1], "base64"));
    expect(decodedJpeg).toEqual(jpegBytes()); // byte-for-byte — not corrupted, not swapped

    const textOnlyStamp = findByBoxSize(page0.annots, 100, 50);
    expect(textOnlyStamp?.kind).toBe("stamp");
    expect(textOnlyStamp?.src).toBeUndefined(); // keeps the labelled-box fallback

    const { result: page1 } = await importRealPage(bytes, 1, 300, appearances);
    const greenStamp = findByBoxSize(page1.annots, 50, 50);
    expect(greenStamp?.src).toMatch(/^data:image\/png;base64,/);
    const pngBytes = Uint8Array.from(Buffer.from(greenStamp!.src!.split(",")[1], "base64"));
    const check = await PDFDocument.create();
    const embedded = await check.embedPng(pngBytes);
    expect(embedded.width).toBe(5);
    expect(embedded.height).toBe(5);

    // The two stamps' pictures must not have been swapped across pages.
    expect(jpegStamp?.src).not.toBe(greenStamp?.src);
  });

  it("still resolves the picture through a password-protected file", async () => {
    const { doc } = await buildFixtureDoc();
    const encrypted = await protectDocument(doc, { userPassword: "s3cret" });

    const appearances = await resolveStampAppearanceImages(encrypted, "s3cret");
    expect(appearances.get(0)?.size).toBe(1);

    const { result: page0 } = await importRealPage(encrypted, 0, 300, appearances, "s3cret");
    const jpegStamp = findByBoxSize(page0.annots, 160, 120);
    expect(jpegStamp?.src).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("resolves nothing (and never throws) for a wrong password", async () => {
    const { doc } = await buildFixtureDoc();
    const encrypted = await protectDocument(doc, { userPassword: "s3cret" });
    const appearances = await resolveStampAppearanceImages(encrypted, "wrong-password");
    expect(appearances.size).toBe(0);
  });
});
