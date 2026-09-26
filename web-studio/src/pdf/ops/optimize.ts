/**
 * File-size reduction ("Optimise PDF", Acrobat's « Réduire la taille du fichier »
 * and « Optimisation avancée »).
 *
 * Safe wins, in order of payoff:
 *   1. downsample and recompress oversized JPEG images (scans are 90% of the
 *      weight of a typical heavy PDF),
 *   2. downsample oversized Flate images (8-bit gray/RGB, with their soft
 *      mask), kept lossless,
 *   3. store identical streams once (a logo repeated on every page by a
 *      careless producer),
 *   4. Flate-compress streams that were stored uncompressed,
 *   5. drop cached artefacts readers regenerate anyway — page thumbnails,
 *      producer piece-info, spider/web-capture data.
 * `spaceAudit` tells where the bytes go (Acrobat's « Audit de l'espace utilisé »).
 *
 * Anything that risks changing how the document renders is left alone.
 */

import { unzlibSync, zlibSync } from "fflate";
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";
import type { PDFDocument, PDFObject } from "pdf-lib";
import { sha256 } from "@noble/hashes/sha2.js";
import { canvasToBlob } from "../core/render";
import { unPng } from "./redact";
import { withoutExif } from "./imagefile";

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
      const n = stream instanceof PDFStream ? numOf((stream as unknown as { dict: PDFDict }).dict, "N") : null;
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
  /** Downsample oversized lossless (Flate) pictures too. */
  downsampleFlate: boolean;
  /** Store identical streams (pictures, fonts, forms) once. */
  dedupe: boolean;
}

export const DEFAULT_OPTIMISE: OptimiseOptions = {
  imageDpi: 150,
  jpegQuality: 0.72,
  dropThumbnails: true,
  dropPieceInfo: true,
  recompressStreams: true,
  downsampleFlate: true,
  dedupe: true,
};

export interface OptimiseReport {
  imagesRecompressed: number;
  streamsRecompressed: number;
  /** Streams found twice or more and stored once. */
  duplicatesMerged: number;
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
    // Decoded as stored: a PDF viewer ignores the EXIF orientation, a browser would apply it.
    const blob = new Blob([withoutExif(bytes).slice().buffer as ArrayBuffer], { type: "image/jpeg" });
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
  const report: OptimiseReport = { imagesRecompressed: 0, streamsRecompressed: 0, duplicatesMerged: 0, bytesSaved: 0 };
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

  // Soft masks are resized with their picture, never on their own.
  const masks = new Set<string>();
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFStream ? (obj as unknown as { dict: PDFDict }).dict : undefined;
    const m = d?.get(PDFName.of("SMask"));
    if (m instanceof PDFRef) masks.add(m.toString());
  }

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue;
    if (masks.has(ref.toString())) continue;
    const dict = (obj as unknown as { dict: PDFDict }).dict;
    const subtype = nameOf(dict, "Subtype");
    const filter = nameOf(dict, "Filter");

    // --- oversized JPEG pictures --------------------------------------------
    if (
      subtype === "Image" &&
      filter === "DCTDecode" &&
      obj instanceof PDFRawStream &&
      dict.lookup(PDFName.of("SMask")) === undefined &&
      // An inverted or colour-keyed picture keeps its bytes (the re-encode is always plain RGB).
      !dict.has(PDFName.of("Decode")) &&
      !dict.has(PDFName.of("Mask")) &&
      !dict.has(PDFName.of("ImageMask"))
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

    // --- oversized lossless pictures (and their soft mask) --------------------
    if (opts.downsampleFlate && subtype === "Image" && filter === "FlateDecode" && obj instanceof PDFRawStream) {
      const w = numOf(dict, "Width") ?? 0;
      const h = numOf(dict, "Height") ?? 0;
      if (Math.max(w, h) > maxSide * 1.15) {
        const saved = downsampleFlate(doc, ref, dict, obj, maxSide);
        if (saved > 0) {
          report.bytesSaved += saved;
          report.imagesRecompressed++;
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

  if (opts.dedupe) {
    const merged = dedupeStreams(doc);
    report.duplicatesMerged = merged.count;
    report.bytesSaved += merged.bytes;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Lossless pictures
// ---------------------------------------------------------------------------

/** Pixels of an 8-bit Flate picture with `comps` components (PNG predictors undone), or null. */
function flatePixels(dict: PDFDict, stream: PDFRawStream, comps: number): Uint8Array | null {
  const w = numOf(dict, "Width") ?? 0;
  const h = numOf(dict, "Height") ?? 0;
  if (numOf(dict, "BitsPerComponent") !== 8 || !w || !h) return null;
  let data: Uint8Array;
  try {
    data = unzlibSync(stream.contents);
  } catch {
    return null;
  }
  // /DecodeParms may be a dictionary or, like /Filter, a one-element array.
  let parms = dict.lookup(PDFName.of("DecodeParms"));
  if (parms instanceof PDFArray) {
    if (parms.size() > 1) return null;
    parms = parms.size() ? parms.lookup(0) : undefined;
  }
  const pred = parms instanceof PDFDict ? (numOf(parms, "Predictor") ?? 1) : 1;
  if (pred >= 10) {
    const p = parms as PDFDict;
    if ((numOf(p, "Colors") ?? 1) !== comps || (numOf(p, "BitsPerComponent") ?? 8) !== 8 || (numOf(p, "Columns") ?? 1) !== w)
      return null;
    data = unPng(data, w * comps, comps, h);
  } else if (pred !== 1) return null;
  return data.length >= w * h * comps ? data : null;
}

/** Box-filter `src` (w×h×comps) down to nw×nh. */
function boxResample(src: Uint8Array, w: number, h: number, comps: number, nw: number, nh: number): Uint8Array {
  const out = new Uint8Array(nw * nh * comps);
  const fx = w / nw;
  const fy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      for (let c = 0; c < comps; c++) {
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += src[(yy * w + xx) * comps + c]!;
        out[(y * nw + x) * comps + c] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
      }
    }
  }
  return out;
}

const componentsOf = (doc: PDFDocument, dict: PDFDict): number => {
  const cs = dict.lookup(PDFName.of("ColorSpace"));
  const v = cs instanceof PDFRef ? doc.context.lookup(cs) : cs;
  if (v instanceof PDFName) return v.asString() === "/DeviceGray" ? 1 : v.asString() === "/DeviceRGB" ? 3 : 0;
  return 0;
};

/** Downsample one Flate picture (and its /SMask) in place; the bytes saved, 0 when left alone. */
function downsampleFlate(
  doc: PDFDocument,
  selfRef: PDFRef,
  dict: PDFDict,
  stream: PDFRawStream,
  maxSide: number,
): number {
  const comps = dict.has(PDFName.of("ImageMask")) ? 0 : componentsOf(doc, dict);
  if (!comps || dict.has(PDFName.of("Decode")) || dict.has(PDFName.of("Mask"))) return 0;
  const w = numOf(dict, "Width")!;
  const h = numOf(dict, "Height")!;
  const k = maxSide / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * k));
  const nh = Math.max(1, Math.round(h * k));
  const px = flatePixels(dict, stream, comps);
  if (!px) return 0;
  // The soft mask must shrink with the picture (same size), or be left as is.
  const smaskRef = dict.get(PDFName.of("SMask"));
  const smask = smaskRef instanceof PDFRef ? doc.context.lookup(smaskRef) : undefined;
  let smaskNext: Uint8Array | null = null;
  if (smask) {
    if (!(smask instanceof PDFRawStream)) return 0;
    const sd = smask.dict;
    if (numOf(sd, "Width") !== w || numOf(sd, "Height") !== h || nameOf(sd, "Filter") !== "FlateDecode") return 0;
    const alpha = flatePixels(sd, smask, 1);
    if (!alpha) return 0;
    smaskNext = zlibSync(boxResample(alpha, w, h, 1, nw, nh), { level: 8 });
  }
  const next = zlibSync(boxResample(px, w, h, comps, nw, nh), { level: 8 });
  const before = stream.contents.length + (smask instanceof PDFRawStream ? smask.contents.length : 0);
  const after = next.length + (smaskNext?.length ?? 0);
  if (after >= before * 0.92) return 0;
  const apply = (d: PDFDict, ref: PDFRef, bytes: Uint8Array) => {
    d.set(PDFName.of("Width"), PDFNumber.of(nw));
    d.set(PDFName.of("Height"), PDFNumber.of(nh));
    d.set(PDFName.of("Length"), PDFNumber.of(bytes.length));
    d.delete(PDFName.of("DecodeParms"));
    doc.context.assign(ref, PDFRawStream.of(d, bytes));
  };
  if (smask instanceof PDFRawStream && smaskNext) apply(smask.dict, smaskRef as PDFRef, smaskNext);
  apply(dict, selfRef, next);
  return before - after;
}

// ---------------------------------------------------------------------------
// Identical streams
// ---------------------------------------------------------------------------

function replaceRefs(o: PDFObject, map: Map<string, PDFRef>): void {
  if (o instanceof PDFDict) {
    for (const [k, v] of o.entries()) {
      if (v instanceof PDFRef) {
        const to = map.get(v.toString());
        if (to) o.set(k, to);
      } else replaceRefs(v, map);
    }
  } else if (o instanceof PDFArray) {
    for (let i = 0; i < o.size(); i++) {
      const v = o.get(i);
      if (v instanceof PDFRef) {
        const to = map.get(v.toString());
        if (to) o.set(i, to);
      } else replaceRefs(v, map);
    }
  } else if (o instanceof PDFStream) {
    replaceRefs((o as unknown as { dict: PDFDict }).dict, map);
  }
}

/** Store identical streams once; every reference points at the one kept. */
export function dedupeStreams(doc: PDFDocument): { count: number; bytes: number } {
  const ctx = doc.context;
  const seen = new Map<string, PDFRef>();
  const map = new Map<string, PDFRef>();
  let bytes = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.contents.length < 64) continue;
    const dict = obj.dict;
    // Page content streams are never shared (a later edit of one page would change both).
    if (!nameOf(dict, "Subtype") && !nameOf(dict, "Type") && !dict.has(PDFName.of("Length1"))) continue;
    const keys = [...dict.entries()]
      .filter(([k]) => k.asString() !== "/Length")
      .map(([k, v]) => `${k.asString()} ${v.toString()}`)
      .sort()
      .join("\n");
    const h = sha256(new TextEncoder().encode(keys));
    const digest = Array.from(sha256(obj.contents), (b) => b.toString(16).padStart(2, "0")).join("");
    const key = `${Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("")}:${digest}`;
    const first = seen.get(key);
    if (first) {
      map.set(ref.toString(), first);
      bytes += obj.contents.length;
    } else seen.set(key, ref);
  }
  if (!map.size) return { count: 0, bytes: 0 };
  for (const [, obj] of ctx.enumerateIndirectObjects()) replaceRefs(obj, map);
  replaceRefs(ctx.trailerInfo.Root as PDFObject, map);
  for (const k of map.keys()) {
    const [num, gen] = k.split(" ");
    ctx.delete(PDFRef.of(Number(num), Number(gen)));
  }
  return { count: map.size, bytes };
}

// ---------------------------------------------------------------------------
// Space audit
// ---------------------------------------------------------------------------

export interface SpaceAudit {
  total: number;
  categories: { label: string; bytes: number }[];
}

/** Where the bytes of a file go, by kind of object (Acrobat's « Audit de l'espace utilisé »). */
export function spaceAudit(doc: PDFDocument, fileSize: number): SpaceAudit {
  const sums = new Map<string, number>();
  const add = (label: string, n: number) => sums.set(label, (sums.get(label) ?? 0) + n);
  const pageContents = new Set<string>();
  for (const page of doc.getPages()) {
    const c = page.node.get(PDFName.of("Contents"));
    if (c instanceof PDFRef) pageContents.add(c.toString());
    const arr = c instanceof PDFRef ? doc.context.lookup(c) : c;
    if (arr instanceof PDFArray) for (let i = 0; i < arr.size(); i++) pageContents.add(String(arr.get(i)));
  }
  let counted = 0;
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    const size = obj.sizeInBytes();
    counted += size;
    if (obj instanceof PDFStream) {
      const d = (obj as unknown as { dict: PDFDict }).dict;
      const subtype = nameOf(d, "Subtype");
      const type = nameOf(d, "Type");
      if (subtype === "Image") add("Images", size);
      else if (
        d.has(PDFName.of("Length1")) ||
        d.has(PDFName.of("Length2")) ||
        subtype === "Type1C" ||
        subtype === "CIDFontType0C" ||
        subtype === "OpenType"
      )
        add("Polices", size);
      else if (subtype === "Form") add("Objets graphiques (formulaires XObject)", size);
      else if (type === "Metadata") add("Métadonnées", size);
      else if (pageContents.has(ref.toString())) add("Contenu des pages", size);
      else if (type === "EmbeddedFile") add("Fichiers joints", size);
      else add("Autres flux", size);
    } else if (obj instanceof PDFDict) {
      const type = nameOf(obj, "Type");
      if (type === "Annot") add("Commentaires et champs", size);
      else if (type === "Font" || type === "FontDescriptor") add("Polices", size);
      else if (type === "Outlines" || obj.has(PDFName.of("First")) || obj.has(PDFName.of("Dest"))) add("Signets", size);
      else add("Structure du document", size);
    } else add("Structure du document", size);
  }
  // Objects packed in object streams take less room in the file than on their own: shares, then.
  if (counted > fileSize) {
    const k = fileSize / counted;
    for (const [label, n] of sums) sums.set(label, Math.floor(n * k));
    const rest = fileSize - [...sums.values()].reduce((a, b) => a + b, 0);
    add("Structure du document", rest);
  } else add("Tables de références et divers", fileSize - counted);
  return {
    total: fileSize,
    categories: [...sums.entries()]
      .map(([label, bytes]) => ({ label, bytes }))
      .filter((c) => c.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes),
  };
}

/** Human-readable byte size. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}
