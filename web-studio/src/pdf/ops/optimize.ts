/**
 * File-size reduction ("Optimise PDF").
 *
 * Three safe wins, in order of payoff:
 *   1. downsample and recompress oversized JPEG images (scans are 90% of the
 *      weight of a typical heavy PDF),
 *   2. Flate-compress streams that were stored uncompressed,
 *   3. drop cached artefacts readers regenerate anyway — page thumbnails,
 *      producer piece-info, spider/web-capture data.
 *
 * Anything that risks changing how the document renders is left alone.
 */

import { zlibSync } from "fflate";
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFStream } from "pdf-lib";
import type { PDFDocument } from "pdf-lib";
import { canvasToBlob } from "../core/render";

/**
 * Number of colour components a JPEG's SOFn marker declares (1 = grayscale,
 * 3 = YCbCr/RGB, 4 = CMYK/YCCK), parsed straight from the marker segments —
 * `null` if no SOF marker is found (malformed stream). Used as a fallback
 * when the PDF's own `/ColorSpace` is absent or unrecognised: some DCTDecode
 * streams rely entirely on the JPEG's own header for that.
 */
export function jpegComponentCount(bytes: Uint8Array): number | null {
  const n = bytes.length;
  let i = 2; // skip SOI (0xFFD8)
  while (i + 4 <= n) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // markers with no payload
      continue;
    }
    if (marker === 0xd9) return null; // EOI reached, no SOF found
    const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // marker(2) length(2) precision(1) height(2) width(2) numComponents(1)
      const compOffset = i + 2 + 2 + 1 + 2 + 2;
      return compOffset < n ? (bytes[compOffset] ?? null) : null;
    }
    if (len < 2) return null; // malformed length, stop rather than loop forever
    i += 2 + len;
  }
  return null;
}

/**
 * Is this image's colour space plain RGB or Gray — safe to hand to the
 * browser's generic JPEG decoder and re-encode as a JPEG? The browser decoder
 * (and `canvasToBlob`'s re-encode) always assumes/produces sRGB: a DeviceCMYK,
 * Separation/DeviceN, Lab, Indexed, or 4-component ICC image decoded that way
 * comes out with silently wrong colours — invisible on screen right after
 * export, but a real problem for a prepress/CMYK document. `true`/`false` is
 * a confident answer from the PDF's own `/ColorSpace`; `null` means it could
 * not be determined there and the caller should fall back to inspecting the
 * JPEG bytes directly.
 */
function isSafeRgbOrGrayColorSpace(dict: PDFDict): boolean | null {
  const cs = dict.lookup(PDFName.of("ColorSpace"));
  if (cs instanceof PDFName) {
    const name = cs.asString().replace(/^\//, "");
    if (name === "DeviceRGB" || name === "DeviceGray" || name === "CalRGB" || name === "CalGray") return true;
    if (name === "DeviceCMYK") return false;
    return null; // e.g. a resource-dict name we can't resolve here
  }
  if (cs instanceof PDFArray && cs.size() > 0) {
    const head = cs.lookup(0);
    const kind = head instanceof PDFName ? head.asString().replace(/^\//, "") : "";
    if (kind === "CalRGB" || kind === "CalGray") return true;
    if (kind === "ICCBased") {
      const stream = cs.lookup(1);
      const n =
        stream instanceof PDFStream ? numOf((stream as unknown as { dict: PDFDict }).dict, "N") : null;
      if (n === 1 || n === 3) return true;
      if (n === 4) return false;
      return null;
    }
    if (kind === "Indexed" || kind === "Separation" || kind === "DeviceN" || kind === "Lab" || kind === "DeviceCMYK") {
      return false;
    }
    return null;
  }
  return null; // no /ColorSpace at all — fall back to the JPEG's own header
}

/** Combines the PDF `/ColorSpace` (authoritative when present) with the
 *  JPEG's own SOFn component count (fallback) — anything not confidently
 *  RGB/Gray is left alone rather than risk silent colour corruption. */
export function isJpegSafeToRecompress(dict: PDFDict, bytes: Uint8Array): boolean {
  const fromColorSpace = isSafeRgbOrGrayColorSpace(dict);
  if (fromColorSpace !== null) return fromColorSpace;
  const components = jpegComponentCount(bytes);
  return components === 1 || components === 3;
}

export interface OptimiseOptions {
  /** Target resolution for embedded pictures, in DPI relative to the page. */
  imageDpi: number;
  /** JPEG quality for recompressed pictures, 0..1. */
  jpegQuality: number;
  dropThumbnails: boolean;
  dropPieceInfo: boolean;
  recompressStreams: boolean;
}

export const DEFAULT_OPTIMISE: OptimiseOptions = {
  imageDpi: 150,
  jpegQuality: 0.72,
  dropThumbnails: true,
  dropPieceInfo: true,
  recompressStreams: true,
};

export interface OptimiseReport {
  imagesRecompressed: number;
  streamsRecompressed: number;
  bytesSaved: number;
}

const nameOf = (d: PDFDict, key: string): string | null => {
  const v = d.lookup(PDFName.of(key));
  if (v instanceof PDFName) return v.asString().replace(/^\//, "");
  if (v instanceof PDFArray && v.size() === 1) {
    const f = v.lookup(0);
    return f instanceof PDFName ? f.asString().replace(/^\//, "") : null;
  }
  return null;
};

const numOf = (d: PDFDict, key: string): number | null => {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : null;
};

/** Decode a JPEG payload to a canvas, downscaled to `maxSide`. */
async function jpegToCanvas(bytes: Uint8Array, maxSide: number): Promise<HTMLCanvasElement | null> {
  try {
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas;
  } catch {
    return null;
  }
}

export async function optimiseDocument(
  doc: PDFDocument,
  options: Partial<OptimiseOptions> = {},
): Promise<OptimiseReport> {
  const opts: OptimiseOptions = { ...DEFAULT_OPTIMISE, ...options };
  const report: OptimiseReport = { imagesRecompressed: 0, streamsRecompressed: 0, bytesSaved: 0 };
  const ctx = doc.context;

  // The largest a picture needs to be, derived from the biggest page.
  let maxPagePt = 612;
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    maxPagePt = Math.max(maxPagePt, width, height);
  }
  const maxSide = Math.max(320, Math.round((maxPagePt / 72) * opts.imageDpi));

  if (opts.dropThumbnails || opts.dropPieceInfo) {
    for (const page of doc.getPages()) {
      if (opts.dropThumbnails) page.node.delete(PDFName.of("Thumb"));
      if (opts.dropPieceInfo) {
        page.node.delete(PDFName.of("PieceInfo"));
        page.node.delete(PDFName.of("LastModified"));
      }
    }
    if (opts.dropPieceInfo) {
      doc.catalog.delete(PDFName.of("PieceInfo"));
      doc.catalog.delete(PDFName.of("SpiderInfo"));
    }
  }

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue;
    const dict = (obj as unknown as { dict: PDFDict }).dict;
    const subtype = nameOf(dict, "Subtype");
    const filter = nameOf(dict, "Filter");

    // --- oversized JPEG pictures --------------------------------------------
    if (
      subtype === "Image" &&
      filter === "DCTDecode" &&
      obj instanceof PDFRawStream &&
      dict.lookup(PDFName.of("SMask")) === undefined
    ) {
      const w = numOf(dict, "Width") ?? 0;
      const h = numOf(dict, "Height") ?? 0;
      if (Math.max(w, h) > maxSide * 1.15 && isJpegSafeToRecompress(dict, obj.contents)) {
        const canvas = await jpegToCanvas(obj.contents, maxSide);
        if (canvas) {
          try {
            const blob = await canvasToBlob(canvas, "image/jpeg", opts.jpegQuality);
            const next = new Uint8Array(await blob.arrayBuffer());
            if (next.length < obj.contents.length * 0.92) {
              report.bytesSaved += obj.contents.length - next.length;
              report.imagesRecompressed++;
              dict.set(PDFName.of("Width"), PDFNumber.of(canvas.width));
              dict.set(PDFName.of("Height"), PDFNumber.of(canvas.height));
              dict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
              dict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
              dict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
              dict.set(PDFName.of("Length"), PDFNumber.of(next.length));
              dict.delete(PDFName.of("DecodeParms"));
              ctx.assign(ref, PDFRawStream.of(dict, next));
            }
          } catch {
            /* keep the original */
          }
        }
        continue;
      }
    }

    // --- uncompressed streams ------------------------------------------------
    if (opts.recompressStreams && !filter && obj instanceof PDFRawStream && obj.contents.length > 256) {
      try {
        const packed = zlibSync(obj.contents, { level: 8 });
        if (packed.length < obj.contents.length * 0.95) {
          report.bytesSaved += obj.contents.length - packed.length;
          report.streamsRecompressed++;
          dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
          dict.set(PDFName.of("Length"), PDFNumber.of(packed.length));
          ctx.assign(ref, PDFRawStream.of(dict, packed));
        }
      } catch {
        /* leave it */
      }
    }
  }

  return report;
}

/** Human-readable byte size. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}
