/**
 * Reading and rewriting a page's own content stream.
 *
 * Shared plumbing for the two features that genuinely modify a PDF rather than
 * drawing on top of it: real text editing and real redaction.
 */

import { zlibSync } from "fflate";
import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFStream, decodePDFRawStream } from "pdf-lib";
import type { PDFDocument, PDFPage } from "pdf-lib";
import type { Mat, Op } from "../core/contentstream";
import { concat, parseContentStream, writeContentStream } from "../core/contentstream";
import type { FontMetrics } from "../core/fontmetrics";
import { loadPageFonts } from "../core/fontmetrics";

/** Decode a content stream object to raw operator bytes. */
function decodeStream(s: unknown): Uint8Array | null {
  if (s instanceof PDFRawStream) {
    try { return decodePDFRawStream(s).decode(); } catch { return null; }
  }
  if (s instanceof PDFStream) {
    try { return (s as unknown as { getContents(): Uint8Array }).getContents(); } catch { return null; }
  }
  return null;
}

/** All of a page's content, concatenated (PDF treats an array as one stream). */
export function readPageContentBytes(page: PDFPage): Uint8Array {
  const contents = page.node.Contents();
  if (!contents) return new Uint8Array(0);
  if (contents instanceof PDFArray) {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < contents.size(); i++) {
      const b = decodeStream(contents.lookup(i));
      if (b) { parts.push(b); parts.push(new Uint8Array([0x0a])); }
    }
    return concat(parts);
  }
  return decodeStream(contents) ?? new Uint8Array(0);
}

export interface PageContent {
  ops: Op[];
  fonts: Map<string, FontMetrics>;
}

export async function readPageContent(page: PDFPage): Promise<PageContent> {
  const bytes = readPageContentBytes(page);
  return { ops: parseContentStream(bytes), fonts: await loadPageFonts(page) };
}

/**
 * Replace the page's content with `ops`, Flate-compressed. Any previous content
 * streams are dropped — the operator list already carries everything.
 */
export function writePageContent(doc: PDFDocument, page: PDFPage, ops: readonly Op[]): void {
  const raw = writeContentStream(ops);
  const packed = zlibSync(raw, { level: 6 });
  const stream = doc.context.stream(packed, { Filter: "FlateDecode" } as never);
  const ref = doc.context.register(stream);
  page.node.set(PDFName.of("Contents"), doc.context.obj([ref] as never));
}

/** Resolve an XObject resource name to its dictionary, for `Do` inspection. */
export function xobjectDict(page: PDFPage, name: string): PDFDict | null {
  const res = page.node.Resources();
  const xo = res?.lookup(PDFName.of("XObject"));
  if (!(xo instanceof PDFDict)) return null;
  const target = xo.lookup(PDFName.of(name));
  if (target instanceof PDFStream) {
    const d = (target as unknown as { dict?: PDFDict }).dict;
    return d ?? null;
  }
  return target instanceof PDFDict ? target : null;
}

/** True when the named XObject draws a bitmap (as opposed to a nested form). */
export function isImageXObject(page: PDFPage, name: string): boolean {
  const d = xobjectDict(page, name);
  const sub = d?.lookup(PDFName.of("Subtype"));
  return sub instanceof PDFName && sub.asString().replace(/^\//, "") === "Image";
}

// ---------------------------------------------------------------------------
// Glyph geometry inside a text-showing operator
// ---------------------------------------------------------------------------

export interface GlyphBox {
  /** Index of the character code within the operator's decoded codes. */
  index: number;
  code: number;
  /** Advance contributed by this glyph, in text space (already × Tz). */
  advance: number;
  /** Corners in PDF user space: [bottom-left, bottom-right, top-right, top-left]. */
  corners: [Pt2, Pt2, Pt2, Pt2];
}

interface Pt2 {
  x: number;
  y: number;
}

const GLYPH_TOP = 0.84;
const GLYPH_BOTTOM = -0.22;

function apply(m: Mat, x: number, y: number): Pt2 {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function mulMat(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

/**
 * Per-glyph boxes for one text-showing operator, in PDF user space.
 * `tjOffsets[i]` is the TJ numeric adjustment that precedes glyph `i`.
 */
export function glyphBoxes(
  codes: readonly number[],
  font: FontMetrics | undefined,
  size: number,
  charSpacing: number,
  wordSpacing: number,
  hScale: number,
  rise: number,
  tm: Mat,
  ctm: Mat,
  tjOffsets?: ReadonlyMap<number, number>,
): GlyphBox[] {
  const full = mulMat(tm, ctm);
  const out: GlyphBox[] = [];
  let off = 0;
  for (let i = 0; i < codes.length; i++) {
    const adjust = tjOffsets?.get(i);
    if (adjust) off += (-adjust / 1000) * size * hScale;
    const code = codes[i];
    const w1000 = font ? font.widthOf(code) : 500;
    const isSpace = code === 32 && (font?.codeBytes ?? 1) === 1;
    const advance = ((w1000 / 1000) * size + charSpacing + (isSpace ? wordSpacing : 0)) * hScale;
    const y0 = GLYPH_BOTTOM * size + rise;
    const y1 = GLYPH_TOP * size + rise;
    out.push({
      index: i,
      code,
      advance,
      corners: [
        apply(full, off, y0),
        apply(full, off + advance, y0),
        apply(full, off + advance, y1),
        apply(full, off, y1),
      ],
    });
    off += advance;
  }
  return out;
}

/** Axis-aligned bounds of a glyph box (enough for rectangle hit-testing). */
export function boundsOf(corners: readonly Pt2[]): { x: number; y: number; w: number; h: number } {
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
