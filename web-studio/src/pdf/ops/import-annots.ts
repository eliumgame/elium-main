/**
 * Reading the markup a PDF already carries into Elium's own model.
 *
 * Without this, comments made in Acrobat would only be *painted* by pdf.js:
 * visible, but not listed in the comment pane, not repliable, not editable and
 * silently dropped on export. Importing them makes a review started elsewhere
 * a first-class Elium review — which is the whole point of interoperability.
 */

import { zlibSync } from "fflate";
import type { Pt, Quad, Rect } from "../core/coords";
import { rectOfPoints, rectOfQuads } from "../core/coords";
import { concat, parseContentStream } from "../core/contentstream";
import type { Annot, AnnotKind, BorderStyle, LineEnding, Reply, ReviewStatus } from "../model/types";
import { newId } from "../model/types";
import { bytesToBase64 } from "../model/persist";

/** The shape pdf.js hands back from `page.getAnnotations()`. */
export interface RawAnnotation {
  id?: string;
  subtype?: string;
  /** True when pdf.js painted an `/AP /N` appearance stream for this annotation. */
  hasAppearance?: boolean;
  rect?: number[];
  color?: Uint8ClampedArray | number[] | null;
  interiorColor?: Uint8ClampedArray | number[] | null;
  opacity?: number;
  quadPoints?: Float32Array | number[] | null;
  inkLists?: (Float32Array | number[])[];
  vertices?: Float32Array | number[] | null;
  lineCoordinates?: number[] | null;
  lineEndings?: string[];
  contentsObj?: { str?: string };
  titleObj?: { str?: string };
  subject?: string;
  creationDate?: string | null;
  modificationDate?: string | null;
  borderStyle?: { width?: number; style?: number; dashArray?: number[] };
  annotationFlags?: number;
  name?: string;
  inReplyTo?: string;
  replyType?: string;
  fieldType?: string;
  it?: string;
  defaultAppearanceData?: { fontSize?: number; fontColor?: Uint8ClampedArray | number[] };
  url?: string;
  dest?: unknown;
  /**
   * The bitmap actually painted by a Stamp's `/AP /N` appearance stream, when
   * whoever built this raw annotation was able to resolve it. pdf.js's own
   * `getAnnotations()` never includes this — it reports only a boolean
   * `hasAppearance`, the real pixels are rendered later straight to a canvas
   * — so this only shows up when a caller separately walked the source
   * PDF's structure (e.g. via pdf-lib, keyed by this annotation's own ref)
   * to pull the image XObject out. Absent for text-only stamps ("APPROVED")
   * and whenever no such resolution happened; the stamp then keeps the
   * labelled-box fallback, exactly as before this field existed.
   */
  appearanceImage?: {
    /** Sample bytes with every *generic* PDF stream filter already peeled
     *  off (Flate/LZW/ASCII85/RunLength — e.g. via pdf-lib's
     *  `decodePDFRawStream(...).decode()`). Still image-encoded when
     *  `filter` names an image-specific codec (DCTDecode et al.), since
     *  those aren't generic filters a stream decoder unwraps. */
    bytes: Uint8Array;
    /** The image XObject's final `/Filter`, so `bytes` can be read correctly. */
    filter?: string | null;
    width: number;
    height: number;
    /** `/ColorSpace`; only DeviceRGB and DeviceGray are decoded today. */
    colorSpace?: string | null;
    bitsPerComponent?: number | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Turning a Stamp's appearance-stream image into a data URL
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

let crcTable: Uint32Array | null = null;

/** The standard PNG/zip CRC-32 (see the PNG spec's own reference code). */
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(type, (ch) => ch.charCodeAt(0));
  const body = concat([typeBytes, data]);
  return concat([u32be(data.length), body, u32be(crc32(body))]);
}

/**
 * A minimal, spec-plain PNG around raw 8-bit DeviceRGB/DeviceGray samples —
 * one IDAT, filter type "None" on every scanline, no interlacing. `fflate`'s
 * `zlibSync` (already a dependency, already used the same way for a page's
 * own content stream in ops/content.ts) does the actual compression; this is
 * just the container bytes around it, so nothing here is a real image codec.
 */
function encodeRawSamplesAsPng(samples: Uint8Array, width: number, height: number, channels: 1 | 3): Uint8Array {
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 — None
    raw.set(samples.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const ihdr = concat([u32be(width), u32be(height), Uint8Array.from([8, channels === 1 ? 0 : 2, 0, 0, 0])]);
  return concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibSync(raw, { level: 6 })),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

/**
 * A Stamp's appearance image as a data URL, or `null` when this codebase
 * cannot decode it — the caller keeps the labelled-box fallback in that case.
 *
 * Handled: DCTDecode (the bytes already *are* a complete JPEG file, so this
 * is a plain base64 wrap) and fully-decompressed 8-bit DeviceRGB/DeviceGray
 * samples (wrapped into a PNG above). Not handled — deliberately, rather
 * than guessed at: Indexed palettes, DeviceCMYK, 1/2/4-bit depths, soft
 * masks (transparency is dropped, never faked), and the CCITTFax/JBIG2/
 * JPXDecode (JPEG 2000) image codecs, none of which this codebase decodes
 * anywhere else either.
 */
function stampImageDataUrl(img: NonNullable<RawAnnotation["appearanceImage"]>): string | null {
  const filter = (img.filter ?? "").replace(/^\//, "");
  if (filter === "DCTDecode" || filter === "DCT") return `data:image/jpeg;base64,${bytesToBase64(img.bytes)}`;
  if (filter) return null; // JPXDecode, CCITTFaxDecode, JBIG2Decode…

  const channels = img.colorSpace === "DeviceGray" ? 1 : img.colorSpace === "DeviceRGB" ? 3 : 0;
  if (!channels || img.bitsPerComponent !== 8) return null; // Indexed, CMYK, 1/2/4-bit…
  const { width: w, height: h, bytes } = img;
  if (!(w > 0) || !(h > 0) || bytes.length < w * h * channels) return null;

  try {
    const png = encodeRawSamplesAsPng(bytes, w, h, channels as 1 | 3);
    return `data:image/png;base64,${bytesToBase64(png)}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Resolving a Stamp's `/AP /N` picture from the source PDF itself
// ---------------------------------------------------------------------------

/** Image-specific codecs a stream decoder does not unwrap — see `stampImageDataUrl`. */
const IMAGE_CODECS = new Set(["DCTDecode", "DCT", "CCITTFaxDecode", "CCF", "JBIG2Decode", "JPXDecode"]);

type AppearanceImage = NonNullable<RawAnnotation["appearanceImage"]>;
type PdfLibNS = typeof import("pdf-lib");

function pdfName(dict: import("pdf-lib").PDFDict, key: string, PDFName: PdfLibNS["PDFName"]): string | undefined {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFName ? v.asString().replace(/^\//, "") : undefined;
}

function pdfNumber(
  dict: import("pdf-lib").PDFDict,
  key: string,
  PDFName: PdfLibNS["PDFName"],
  PDFNumber: PdfLibNS["PDFNumber"],
): number | undefined {
  return dict.lookupMaybe(PDFName.of(key), PDFNumber)?.asNumber();
}

/**
 * The image XObject actually painted by a Form XObject's own content stream
 * (`/Im0 Do`, typically), resolved through its `/Resources /XObject` — not
 * just "the only image in Resources", since a form can carry more than one
 * and only walking the operators says which is really drawn. Recurses through
 * nested Forms, bounded so a malformed/cyclic file cannot loop forever.
 */
function findPaintedImage(
  form: import("pdf-lib").PDFRawStream,
  pdfLib: PdfLibNS,
  depth: number,
): import("pdf-lib").PDFRawStream | null {
  if (depth > 4) return null;
  const { PDFDict, PDFName, PDFRawStream, decodePDFRawStream } = pdfLib;
  const resources = form.dict.lookup(PDFName.of("Resources"));
  if (!(resources instanceof PDFDict)) return null;
  const xobjects = resources.lookup(PDFName.of("XObject"));
  if (!(xobjects instanceof PDFDict)) return null;

  let content: Uint8Array;
  try {
    content = decodePDFRawStream(form).decode();
  } catch {
    return null;
  }
  // A form can `Do` more than one XObject (e.g. a background rule); the last
  // one painted is what actually ends up on top.
  let picked: string | null = null;
  for (const op of parseContentStream(content)) {
    if (op.op === "Do" && op.args[0]?.t === "name") picked = op.args[0].v;
  }
  if (!picked) return null;
  const target = xobjects.lookup(PDFName.of(picked));
  if (!(target instanceof PDFRawStream)) return null;
  const subtype = pdfName(target.dict, "Subtype", PDFName);
  if (subtype === "Image") return target;
  if (subtype === "Form") return findPaintedImage(target, pdfLib, depth + 1);
  return null;
}

/**
 * An image XObject's own sample bytes, with any *generic* filter peeled off —
 * still codec-encoded when the filter is image-specific (DCTDecode et al.),
 * exactly what `stampImageDataUrl` expects. `null` for chained filters (e.g.
 * `[ASCII85Decode DCTDecode]`): rare for a Stamp's picture, and guessing which
 * part of the chain is the "real" filter risks handing back bytes that look
 * decodable but aren't — the labelled-box fallback is the honest answer there.
 */
function readImageBytes(
  img: import("pdf-lib").PDFRawStream,
  pdfLib: PdfLibNS,
): { bytes: Uint8Array; filter: string | null } | null {
  const { PDFArray, PDFName, decodePDFRawStream } = pdfLib;
  const filterObj = img.dict.lookup(PDFName.of("Filter"));
  let filter: string | null = null;
  if (filterObj instanceof PDFName) filter = filterObj.asString().replace(/^\//, "");
  else if (filterObj instanceof PDFArray) {
    if (filterObj.size() > 1) return null; // chained filters — not handled, deliberately
    const only = filterObj.size() === 1 ? filterObj.lookup(0) : undefined;
    if (only instanceof PDFName) filter = only.asString().replace(/^\//, "");
  } else if (filterObj !== undefined) {
    return null; // unexpected shape
  }

  if (filter && IMAGE_CODECS.has(filter)) return { bytes: img.contents, filter };
  try {
    return { bytes: decodePDFRawStream(img).decode(), filter: null };
  } catch {
    return null;
  }
}

/**
 * Resolve every Stamp annotation's own picture across a whole source PDF, by
 * walking the same bytes with pdf-lib — pdf.js's `getAnnotations()` never
 * exposes appearance-stream pixels (see `appearanceImage`'s own doc comment).
 * Returns a map from page index (0-based, matching `PdfEngine`) to a map from
 * that annotation's pdf.js-reported `id` to its decoded picture, so the
 * caller can attach one to the other by a simple lookup — never by position —
 * since a wrong correlation would show the wrong picture on the wrong stamp,
 * worse than the labelled-box fallback this replaces. pdf.js's `id` for an
 * annotation backed by indirect reference `n g R` is the string `` `${n}R` ``
 * when `g` is 0 (confirmed empirically against this project's own pdfjs-dist
 * build) or `` `${n}R${g}` `` otherwise; building the same string from the
 * matching pdf-lib ref — rather than parsing pdf.js's `id` — is what makes the
 * two line up.
 *
 * Best-effort throughout: any failure (an encryption scheme `removeProtection`
 * cannot undo, a malformed structure, a codec this codebase does not decode)
 * simply leaves the affected stamps out of the map.
 */
export async function resolveStampAppearanceImages(
  sourceBytes: Uint8Array,
  password?: string | null,
): Promise<Map<number, Map<string, AppearanceImage>>> {
  const byPage = new Map<number, Map<string, AppearanceImage>>();
  try {
    const pdfLib = await import("pdf-lib");
    const { PDFDocument, PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef } = pdfLib;

    let bytes = sourceBytes;
    if (password) {
      const { removeProtection } = await import("./security");
      bytes = (await removeProtection(sourceBytes, password)).bytes;
    }
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });

    const pages = doc.getPages();
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      const annotsArr = pages[pageIndex].node.Annots();
      if (!(annotsArr instanceof PDFArray)) continue;
      let pageMap: Map<string, AppearanceImage> | null = null;

      for (let i = 0; i < annotsArr.size(); i++) {
        const ref = annotsArr.get(i);
        if (!(ref instanceof PDFRef)) continue;
        const annotDict = annotsArr.lookup(i);
        if (!(annotDict instanceof PDFDict)) continue;
        if (pdfName(annotDict, "Subtype", PDFName) !== "Stamp") continue;

        const ap = annotDict.lookup(PDFName.of("AP"));
        if (!(ap instanceof PDFDict)) continue;
        let n = ap.lookup(PDFName.of("N"));
        if (n instanceof PDFDict) {
          // A dictionary of named appearance states — pick the active one.
          const as = annotDict.lookup(PDFName.of("AS"));
          n = as instanceof PDFName ? n.lookup(as) : undefined;
        }
        if (!(n instanceof PDFRawStream)) continue;

        const subtype = pdfName(n.dict, "Subtype", PDFName);
        const imgStream = subtype === "Image" ? n : subtype === "Form" ? findPaintedImage(n, pdfLib, 0) : null;
        if (!imgStream) continue;

        const width = pdfNumber(imgStream.dict, "Width", PDFName, PDFNumber);
        const height = pdfNumber(imgStream.dict, "Height", PDFName, PDFNumber);
        if (!width || !height) continue;
        const resolved = readImageBytes(imgStream, pdfLib);
        if (!resolved) continue;

        const key = ref.generationNumber ? `${ref.objectNumber}R${ref.generationNumber}` : `${ref.objectNumber}R`;
        (pageMap ??= new Map()).set(key, {
          bytes: resolved.bytes,
          filter: resolved.filter,
          width,
          height,
          colorSpace: pdfName(imgStream.dict, "ColorSpace", PDFName) ?? null,
          bitsPerComponent: pdfNumber(imgStream.dict, "BitsPerComponent", PDFName, PDFNumber) ?? null,
        });
      }

      if (pageMap) byPage.set(pageIndex, pageMap);
    }
  } catch {
    /* best effort — every page's stamps keep the labelled-box fallback */
  }
  return byPage;
}

const KIND: Record<string, AnnotKind> = {
  Highlight: "highlight",
  Underline: "underline",
  StrikeOut: "strikeout",
  Squiggly: "squiggly",
  Text: "note",
  FreeText: "freetext",
  Ink: "ink",
  Square: "square",
  Circle: "circle",
  Line: "line",
  Polygon: "polygon",
  PolyLine: "polyline",
  Stamp: "stamp",
};

const LINE_ENDING: Record<string, LineEnding> = {
  None: "none",
  ClosedArrow: "arrow",
  OpenArrow: "openArrow",
  Circle: "circle",
  Square: "square",
  Diamond: "diamond",
  Butt: "butt",
  Slash: "slash",
};

const BORDER: Record<number, BorderStyle> = { 1: "solid", 2: "dashed", 3: "solid", 4: "solid", 5: "solid" };

function hex(c: Uint8ClampedArray | number[] | null | undefined, fallback: string): string {
  if (!c || c.length < 3) return fallback;
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/** `D:YYYYMMDDHHmmSS…` → ISO. Falls back to the epoch so sorting stays stable. */
function parsePdfDate(raw: string | null | undefined): string {
  if (!raw) return new Date(0).toISOString();
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(raw.trim());
  if (!m) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
  }
  const [, y, mo = "01", da = "01", h = "00", mi = "00", s = "00"] = m;
  const d = new Date(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(s));
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/**
 * The page's crop box in PDF user space: `h` its unrotated height, `(x, y)` its
 * lower-left origin. pdf.js reports annotation geometry in absolute PDF space,
 * so mapping into Elium's top-left page space is the exact inverse of what
 * `pageFrame` (ops/annots-pdf.ts) applies on export:
 *   x_ps = x_pdf − x     y_ps = (y + h) − y_pdf
 * Ignoring the origin — as this did before — leaves markup from any PDF whose
 * box does not start at (0,0) shifted, and vertically mirrored when the offset
 * is large. Such boxes are common in files that passed through another editor.
 */
interface Frame {
  x: number;
  y: number;
  h: number;
}

const flip =
  (f: Frame) =>
  (x: number, y: number): Pt => ({ x: x - f.x, y: f.y + f.h - y });

function rectFrom(raw: number[] | undefined, frame: Frame): Rect {
  if (!raw || raw.length < 4) return { x: 0, y: 0, w: 0, h: 0 };
  const x1 = Math.min(raw[0], raw[2]);
  const x2 = Math.max(raw[0], raw[2]);
  const y1 = Math.min(raw[1], raw[3]);
  const y2 = Math.max(raw[1], raw[3]);
  return { x: x1 - frame.x, y: frame.y + frame.h - y2, w: x2 - x1, h: y2 - y1 };
}

/** `/QuadPoints` is UL, UR, LL, LR — reorder into our reading-order quads. */
function quadsFrom(raw: Float32Array | number[] | null | undefined, frame: Frame): Quad[] {
  if (!raw || raw.length < 8) return [];
  const f = flip(frame);
  const out: Quad[] = [];
  for (let i = 0; i + 7 < raw.length; i += 8) {
    out.push([
      f(raw[i], raw[i + 1]), // upper-left
      f(raw[i + 2], raw[i + 3]), // upper-right
      f(raw[i + 6], raw[i + 7]), // lower-right
      f(raw[i + 4], raw[i + 5]), // lower-left
    ]);
  }
  return out;
}

function pointsFrom(raw: Float32Array | number[] | null | undefined, frame: Frame): Pt[] {
  if (!raw) return [];
  const f = flip(frame);
  const out: Pt[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push(f(raw[i], raw[i + 1]));
  return out;
}

export interface ImportResult {
  annots: Annot[];
  /** Annotations we could see but not model (widgets, media, 3D…). */
  skipped: number;
}

/**
 * Convert one page's annotations. `pageId` is the model page they belong to,
 * `pageHeight` its unrotated crop-box height and `origin` the crop box's
 * lower-left corner in PDF user space (defaults to (0,0), the common case).
 * Both are needed to flip absolute PDF geometry into Elium's page space — see
 * `Frame` above. The origin defaults keep older callers working unchanged.
 */
export function importPageAnnots(
  raw: readonly RawAnnotation[],
  pageId: string,
  pageHeight: number,
  fallbackAuthor: string,
  origin: { x: number; y: number } = { x: 0, y: 0 },
): ImportResult {
  const frame: Frame = { x: origin.x, y: origin.y, h: pageHeight };
  const annots: Annot[] = [];
  const replies: { parent: string; reply: Reply }[] = [];
  let skipped = 0;

  for (const a of raw) {
    const subtype = a.subtype ?? "";
    // Widgets are form fields (handled by the form layer) and popups are just
    // the little windows attached to a parent comment.
    if (subtype === "Widget" || subtype === "Popup" || subtype === "Link") continue;
    const kind = KIND[subtype];
    if (!kind) {
      skipped++;
      continue;
    }

    const created = parsePdfDate(a.creationDate);
    const modified = parsePdfDate(a.modificationDate ?? a.creationDate);
    const contents = a.contentsObj?.str ?? "";
    const author = a.titleObj?.str || fallbackAuthor;

    // A reply carries `/IRT`; attach it to its parent instead of showing a
    // second icon on the page.
    if (a.inReplyTo) {
      replies.push({
        parent: a.inReplyTo,
        reply: { id: a.id || newId("rp"), author, text: contents, createdAt: created },
      });
      continue;
    }

    const annot: Annot = {
      id: a.id || newId("an"),
      pageId,
      kind,
      rect: rectFrom(a.rect, frame),
      color: hex(a.color, kind === "highlight" ? "#ffd400" : "#e11d48"),
      fill: a.interiorColor ? hex(a.interiorColor, "#ffffff") : null,
      opacity: typeof a.opacity === "number" ? a.opacity : 1,
      strokeWidth: a.borderStyle?.width ?? 1.5,
      borderStyle: BORDER[a.borderStyle?.style ?? 1] ?? "solid",
      author,
      subject: a.subject || undefined,
      contents: contents || undefined,
      createdAt: created,
      modifiedAt: modified,
      status: "none" as ReviewStatus,
      replies: [],
      // Flag bit 8 (value 128) is "Locked"; bit 2 (value 2) is "Hidden".
      locked: !!((a.annotationFlags ?? 0) & 128),
      hidden: !!((a.annotationFlags ?? 0) & 2),
    };

    switch (kind) {
      case "highlight":
      case "underline":
      case "strikeout":
      case "squiggly": {
        const quads = quadsFrom(a.quadPoints, frame);
        if (quads.length) {
          annot.quads = quads;
          annot.rect = rectOfQuads(quads);
        }
        if (kind === "highlight" && typeof a.opacity !== "number") annot.opacity = 0.4;
        break;
      }
      case "ink": {
        const paths = (a.inkLists ?? []).map((list) => pointsFrom(list, frame)).filter((p) => p.length);
        if (paths.length) {
          annot.paths = paths;
          annot.rect = rectOfPoints(paths.flat());
        }
        break;
      }
      case "line": {
        const l = a.lineCoordinates;
        if (l && l.length >= 4) {
          const f = flip(frame);
          annot.paths = [[f(l[0], l[1]), f(l[2], l[3])]];
        }
        annot.lineStart = LINE_ENDING[a.lineEndings?.[0] ?? "None"] ?? "none";
        annot.lineEnd = LINE_ENDING[a.lineEndings?.[1] ?? "None"] ?? "none";
        if (annot.lineEnd !== "none" && annot.lineStart === "none") annot.kind = "arrow";
        if (a.it === "LineDimension") annot.kind = "distance";
        break;
      }
      case "polygon":
      case "polyline": {
        const pts = pointsFrom(a.vertices, frame);
        if (pts.length) {
          annot.paths = [pts];
          annot.rect = rectOfPoints(pts);
        }
        if (a.it === "PolygonDimension") annot.kind = "area";
        if (a.it === "PolyLineDimension") annot.kind = "perimeter";
        break;
      }
      case "freetext": {
        annot.text = contents;
        annot.contents = undefined;
        annot.fontSize = a.defaultAppearanceData?.fontSize || 12;
        annot.color = hex(a.defaultAppearanceData?.fontColor, "#0f172a");
        annot.textBg = a.color ? hex(a.color, "#ffffff") : null;
        annot.strokeWidth = a.borderStyle?.width ?? 0;
        if (a.it === "FreeTextCallout") annot.kind = "callout";
        break;
      }
      case "note":
        annot.rect = { ...annot.rect, w: 20, h: 20 };
        break;
      case "stamp": {
        // pdf.js paints the appearance stream itself — but only as long as
        // nothing has been imported yet: PdfWorkspace turns pdf.js's own
        // annotation painting off the moment there is anything to import
        // (so a re-exported comment doesn't get drawn twice, once by pdf.js
        // and once by Elium). From that point on the picture has to live in
        // the model, or it simply never appears again. `stampLabel` stays as
        // a fallback (and for genuinely text-only stamps).
        annot.stampLabel = a.name || a.subject || "TAMPON";
        if (a.appearanceImage) {
          const src = stampImageDataUrl(a.appearanceImage);
          if (src) annot.src = src;
        }
        break;
      }
      default:
        break;
    }

    annots.push(annot);
  }

  for (const { parent, reply } of replies) {
    const target = annots.find((a) => a.id === parent);
    if (target) target.replies = [...(target.replies ?? []), reply];
    else skipped++;
  }

  return { annots, skipped };
}

/** True when a page carries markup worth importing (cheap pre-check). */
export function hasImportableAnnots(raw: readonly RawAnnotation[]): boolean {
  return raw.some((a) => a.subtype && KIND[a.subtype]);
}

/** Subtypes that were imported into the model and must not be written twice. */
const IMPORTED_SUBTYPES = new Set([...Object.keys(KIND), "Popup"]);

/**
 * Drop the markup the model now owns from a page's `/Annots`, leaving form
 * widgets and links alone. Called at export time when `importedAnnots` is set,
 * so an imported-then-edited comment appears once in the output.
 */
export async function stripImportedAnnots(page: import("pdf-lib").PDFPage): Promise<number> {
  const { PDFArray, PDFDict, PDFName, PDFRef } = await import("pdf-lib");
  const annots = page.node.Annots();
  if (!(annots instanceof PDFArray)) return 0;
  let removed = 0;
  for (let i = annots.size() - 1; i >= 0; i--) {
    const ref = annots.get(i);
    const dict = annots.lookup(i);
    if (!(dict instanceof PDFDict)) continue;
    const sub = dict.lookup(PDFName.of("Subtype"));
    const name = sub instanceof PDFName ? sub.asString().replace(/^\//, "") : "";
    if (!IMPORTED_SUBTYPES.has(name)) continue;
    annots.remove(i);
    if (ref instanceof PDFRef) page.doc.context.delete(ref);
    removed++;
  }
  return removed;
}
