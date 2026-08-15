/**
 * Real redaction.
 *
 * A black rectangle drawn over text is not redaction — the words are still in
 * the file and any "copy text" reveals them. This module deletes the content:
 * the glyphs whose boxes fall inside a marked area are removed from the page's
 * operator list (with compensating `TJ` offsets so surrounding text does not
 * shift), images that intersect are dropped, intersecting annotations and links
 * are unlinked, and only then is the opaque box painted on top.
 */

import { PDFArray, PDFDict, PDFName, PDFRef } from "pdf-lib";
import type { PDFDocument, PDFPage } from "pdf-lib";
import type { Op, Operand } from "../core/contentstream";
import { walkPlacements, walkText } from "../core/contentstream";
import type { FontMetrics } from "../core/fontmetrics";
import { widthFnFor } from "../core/fontmetrics";
import type { Rect } from "../core/coords";
import { readPageContent, writePageContent, glyphBoxes, boundsOf } from "./content";

/** Fraction of a glyph that must be covered before it is deleted. */
const GLYPH_HIT = 0.22;

function overlaps(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const area = Math.max(a.w * a.h, 1e-6);
  return (w * h) / area;
}

/** Decompose a show operator into character codes and their `TJ` adjustments. */
function analyse(
  op: Op,
  font: FontMetrics | undefined,
): { codes: number[]; tj: Map<number, number>; parts: Operand[] } {
  const codes: number[] = [];
  const tj = new Map<number, number>();
  const parts: Operand[] = [];
  const push = (bytes: Uint8Array) => {
    const decoded = font ? font.decode(bytes) : Array.from(bytes);
    codes.push(...decoded);
  };
  if (op.op === "TJ") {
    const arr = op.args[op.args.length - 1];
    if (arr?.t === "arr") {
      for (const el of arr.v) {
        if (el.t === "str" || el.t === "hex") {
          parts.push(el);
          push(el.v);
        } else if (el.t === "num") tj.set(codes.length, (tj.get(codes.length) ?? 0) + el.v);
      }
    }
  } else {
    const s = op.args[op.args.length - 1];
    if (s && (s.t === "str" || s.t === "hex")) {
      parts.push(s);
      push(s.v);
    }
  }
  return { codes, tj, parts };
}

/** Re-encode kept character codes back into raw show bytes. */
function encodeCodes(codes: readonly number[], font: FontMetrics | undefined): Uint8Array {
  const wide = (font?.codeBytes ?? 1) === 2;
  const out = new Uint8Array(codes.length * (wide ? 2 : 1));
  codes.forEach((c, i) => {
    if (wide) {
      out[i * 2] = (c >> 8) & 0xff;
      out[i * 2 + 1] = c & 0xff;
    } else out[i] = c & 0xff;
  });
  return out;
}

export interface RedactionResult {
  glyphsRemoved: number;
  imagesRemoved: number;
  annotsRemoved: number;
}

/**
 * Strip everything inside `rects` (PDF user space) from one page.
 * The caller paints the redaction boxes afterwards.
 */
export async function applyRedactions(
  doc: PDFDocument,
  page: PDFPage,
  rects: readonly Rect[],
): Promise<RedactionResult> {
  const result: RedactionResult = { glyphsRemoved: 0, imagesRemoved: 0, annotsRemoved: 0 };
  if (!rects.length) return result;

  const { ops, fonts } = await readPageContent(page);
  if (!ops.length) return result;

  const shows = walkText(ops, widthFnFor(fonts));
  const replacements = new Map<number, Op | null>();

  for (const show of shows) {
    const font = show.state.font ? fonts.get(show.state.font) : undefined;
    const op = ops[show.opIndex];
    const { codes, tj } = analyse(op, font);
    if (!codes.length) continue;

    const boxes = glyphBoxes(
      codes,
      font,
      show.state.size,
      show.state.charSpacing,
      show.state.wordSpacing,
      show.state.hScale,
      show.state.rise,
      show.tm,
      show.ctm,
      tj,
    );

    const doomed = new Set<number>();
    for (const g of boxes) {
      const b = boundsOf(g.corners);
      if (b.w <= 0 && b.h <= 0) continue;
      for (const r of rects) {
        if (overlaps(b, r) >= GLYPH_HIT) {
          doomed.add(g.index);
          break;
        }
      }
    }
    if (!doomed.size) continue;
    result.glyphsRemoved += doomed.size;

    if (doomed.size === codes.length) {
      // Whole operator gone. Keep the caret moving so later text stays put.
      const skipped = boxes.reduce((s, g) => s + g.advance, 0) + sumTj(tj, show.state.size, show.state.hScale);
      replacements.set(show.opIndex, shiftOnly(skipped, show.state.size, show.state.hScale));
      continue;
    }

    // Rebuild as a TJ: runs of kept glyphs, numeric jumps over deleted ones.
    const items: Operand[] = [];
    let run: number[] = [];
    let pendingSkip = 0;
    const flushRun = () => {
      if (!run.length) return;
      items.push({ t: "hex", v: encodeCodes(run, font) });
      run = [];
    };
    const flushSkip = () => {
      if (Math.abs(pendingSkip) < 1e-6) return;
      // tx = -t/1000 · Tfs · Th  ⇒  t = -tx · 1000 / (Tfs · Th)
      const denom = show.state.size * show.state.hScale || 1;
      items.push({ t: "num", v: -(pendingSkip * 1000) / denom });
      pendingSkip = 0;
    };

    for (const g of boxes) {
      const adjust = tj.get(g.index);
      if (adjust) {
        flushRun();
        pendingSkip += (-adjust / 1000) * show.state.size * show.state.hScale;
      }
      if (doomed.has(g.index)) {
        flushRun();
        pendingSkip += g.advance;
      } else {
        flushSkip();
        run.push(g.code);
      }
    }
    flushRun();
    flushSkip();

    replacements.set(show.opIndex, { op: "TJ", args: [{ t: "arr", v: items }] });
  }

  // --- images ---------------------------------------------------------------
  for (const place of walkPlacements(ops)) {
    const b = boundsOf(place.corners);
    if (b.w < 0.01 || b.h < 0.01) continue;
    if (!rects.some((r) => overlaps(b, r) > 0.02)) continue;
    replacements.set(place.opIndex, null);
    result.imagesRemoved++;
  }

  if (replacements.size) {
    const next: Op[] = [];
    for (let i = 0; i < ops.length; i++) {
      if (!replacements.has(i)) {
        next.push(ops[i]);
        continue;
      }
      const rep = replacements.get(i);
      if (rep) next.push(rep);
    }
    writePageContent(doc, page, next);
  }

  result.annotsRemoved = removeAnnotsIn(doc, page, rects);
  return result;
}

function sumTj(tj: ReadonlyMap<number, number>, size: number, hScale: number): number {
  let total = 0;
  for (const v of tj.values()) total += (-v / 1000) * size * hScale;
  return total;
}

/** An empty show with a single TJ jump — moves the caret without drawing. */
function shiftOnly(displacement: number, size: number, hScale: number): Op {
  const denom = size * hScale || 1;
  return {
    op: "TJ",
    args: [{ t: "arr", v: [{ t: "num", v: -(displacement * 1000) / denom }] }],
  };
}

/**
 * Unlink annotations (including links, which can leak a URL) that sit inside a
 * redacted area, and delete their objects.
 */
function removeAnnotsIn(doc: PDFDocument, page: PDFPage, rects: readonly Rect[]): number {
  const annots = page.node.Annots();
  if (!(annots instanceof PDFArray)) return 0;
  let removed = 0;
  for (let i = annots.size() - 1; i >= 0; i--) {
    const ref = annots.get(i);
    const dict = annots.lookup(i);
    if (!(dict instanceof PDFDict)) continue;
    const rectArr = dict.lookup(PDFName.of("Rect"));
    if (!(rectArr instanceof PDFArray) || rectArr.size() < 4) continue;
    const nums = [0, 1, 2, 3].map((k) => {
      const v = rectArr.lookup(k) as unknown as { asNumber?: () => number } | undefined;
      return typeof v?.asNumber === "function" ? v.asNumber() : 0;
    });
    const box: Rect = {
      x: Math.min(nums[0], nums[2]),
      y: Math.min(nums[1], nums[3]),
      w: Math.abs(nums[2] - nums[0]),
      h: Math.abs(nums[3] - nums[1]),
    };
    if (!rects.some((r) => overlaps(box, r) > 0.25)) continue;
    annots.remove(i);
    if (ref instanceof PDFRef) doc.context.delete(ref);
    removed++;
  }
  return removed;
}

/**
 * Strip document-level metadata that could still carry redacted wording:
 * `/Info`, the XMP packet, and any embedded files or JavaScript. This is what
 * Acrobat's "Sanitise document" does alongside redaction.
 */
export function sanitiseDocument(doc: PDFDocument): { removed: string[] } {
  const removed: string[] = [];
  const catalog = doc.catalog;

  if (catalog.lookup(PDFName.of("Metadata"))) {
    catalog.delete(PDFName.of("Metadata"));
    removed.push("métadonnées XMP");
  }

  const names = catalog.lookup(PDFName.of("Names"));
  if (names instanceof PDFDict) {
    if (names.lookup(PDFName.of("EmbeddedFiles"))) {
      names.delete(PDFName.of("EmbeddedFiles"));
      removed.push("fichiers incorporés");
    }
    if (names.lookup(PDFName.of("JavaScript"))) {
      names.delete(PDFName.of("JavaScript"));
      removed.push("JavaScript");
    }
  }
  if (catalog.lookup(PDFName.of("OpenAction"))) {
    catalog.delete(PDFName.of("OpenAction"));
    removed.push("action à l'ouverture");
  }
  if (catalog.lookup(PDFName.of("AA"))) {
    catalog.delete(PDFName.of("AA"));
    removed.push("actions automatiques");
  }

  // Per-page automatic actions and file attachments.
  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of("AA"));
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const dict = annots.lookup(i);
      if (!(dict instanceof PDFDict)) continue;
      const sub = dict.lookup(PDFName.of("Subtype"));
      const name = sub instanceof PDFName ? sub.asString().replace(/^\//, "") : "";
      if (name === "FileAttachment" || name === "Movie" || name === "Screen" || name === "RichMedia") {
        annots.remove(i);
        if (!removed.includes("contenus multimédias")) removed.push("contenus multimédias");
      } else {
        dict.delete(PDFName.of("AA"));
      }
    }
  }

  const info = doc.context.trailerInfo.Info;
  if (info) {
    const infoDict = doc.context.lookup(info);
    if (infoDict instanceof PDFDict) {
      for (const key of ["Author", "Subject", "Keywords", "Creator", "Producer", "Title"]) {
        infoDict.delete(PDFName.of(key));
      }
      removed.push("propriétés du document");
    }
  }

  return { removed };
}
