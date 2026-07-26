/**
 * Editing the PDF's own text — for real.
 *
 * The paragraph's original glyphs are removed from the content stream (exactly
 * as redaction does), then the replacement text is re-laid-out **in the page's
 * own font resource** so the typeface, size and colour are preserved and the
 * result stays selectable, searchable and copy-pasteable.
 *
 * When the original font cannot encode the new characters — a subsetted font
 * that simply has no glyph for "€", say — we fall back to embedding a
 * substitute face and report it, rather than silently dropping characters.
 */

import type { PDFDocument, PDFPage } from "pdf-lib";
import type { Op, Operand } from "../core/contentstream";
import { walkText } from "../core/contentstream";
import type { FontMetrics } from "../core/fontmetrics";
import { widthFnFor } from "../core/fontmetrics";
import type { Rect } from "../core/coords";
import { round } from "../core/coords";
import type { ContentEdit } from "../model/types";
import { boundsOf, glyphBoxes, readPageContent, writePageContent } from "./content";
import type { PageFrame } from "./annots-pdf";
import type { FontBook } from "./fonts";
import { sanitiseForFont } from "./fonts";
import { PageResources, Painter, hexToRgb, measure, wrapText } from "./painter";

/** How much of a glyph must sit in the block before it counts as part of it. */
const GLYPH_HIT = 0.35;

export interface TextEditReport {
  /** Blocks rewritten using the document's own font. */
  native: number;
  /** Blocks that needed a substituted font. */
  substituted: number;
  /** Blocks whose original text could no longer be located (page changed). */
  skipped: number;
}

function overlapRatio(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(a.w * a.h, 1e-6);
}

/** Re-encode codes into show bytes for a font. */
function encodeCodes(codes: readonly number[], font: FontMetrics | undefined): Uint8Array {
  const wide = (font?.codeBytes ?? 1) === 2;
  const out = new Uint8Array(codes.length * (wide ? 2 : 1));
  codes.forEach((c, i) => {
    if (wide) { out[i * 2] = (c >> 8) & 0xff; out[i * 2 + 1] = c & 0xff; }
    else out[i] = c & 0xff;
  });
  return out;
}

function analyse(op: Op, font: FontMetrics | undefined): { codes: number[]; tj: Map<number, number> } {
  const codes: number[] = [];
  const tj = new Map<number, number>();
  const push = (bytes: Uint8Array) => codes.push(...(font ? font.decode(bytes) : Array.from(bytes)));
  if (op.op === "TJ") {
    const arr = op.args[op.args.length - 1];
    if (arr?.t === "arr") {
      for (const el of arr.v) {
        if (el.t === "str" || el.t === "hex") push(el.v);
        else if (el.t === "num") tj.set(codes.length, (tj.get(codes.length) ?? 0) + el.v);
      }
    }
  } else {
    const s = op.args[op.args.length - 1];
    if (s && (s.t === "str" || s.t === "hex")) push(s.v);
  }
  return { codes, tj };
}

/** Width of a string in points, using the ORIGINAL font's real metrics. */
function measureNative(font: FontMetrics, text: string, size: number): number | null {
  let total = 0;
  for (const ch of text) {
    const bytes = font.encode(ch);
    if (!bytes) return null;
    const codes = font.decode(bytes);
    for (const c of codes) total += (font.widthOf(c) / 1000) * size;
  }
  return total;
}

/** Greedy wrap using the original font's metrics. Returns null if unencodable. */
function wrapNative(font: FontMetrics, text: string, size: number, maxWidth: number): string[] | null {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const candidate = line + word;
      const w = measureNative(font, candidate, size);
      if (w === null) return null;
      if (w <= maxWidth || !line.trim()) line = candidate;
      else { out.push(line.replace(/\s+$/, "")); line = word.trimStart(); }
    }
    out.push(line.replace(/\s+$/, ""));
  }
  return out;
}

/**
 * Apply every content edit belonging to `page`. Coordinates in the edits are
 * page space; `frame` converts them to the PDF user space the operators use.
 */
export async function applyTextEdits(
  doc: PDFDocument,
  page: PDFPage,
  edits: readonly ContentEdit[],
  frame: PageFrame,
  fontBook: FontBook,
): Promise<TextEditReport> {
  const report: TextEditReport = { native: 0, substituted: 0, skipped: 0 };
  if (!edits.length) return report;

  const { ops, fonts } = await readPageContent(page);
  if (!ops.length) {
    report.skipped = edits.length;
    return report;
  }
  const shows = walkText(ops, widthFnFor(fonts));
  const doomedOps = new Map<number, Op | null>();
  /** Text to re-emit, appended after the original content. */
  const emitted: Op[] = [];
  /** Blocks that need the slower substituted-font path. */
  const fallbacks: { edit: ContentEdit; box: Rect; size: number; color: string }[] = [];

  for (const edit of edits) {
    const target = frame.rectToPdf(edit.rect);
    const box: Rect = { x: target.x, y: target.y, w: target.w, h: target.h };
    // A little slack: glyph boxes use nominal ascent/descent, not real metrics.
    const hit: Rect = { x: box.x - 1.5, y: box.y - 1.5, w: box.w + 3, h: box.h + 3 };

    const members = shows.filter((s) => {
      const b = boundsOf([
        { x: s.origin.x, y: s.origin.y },
        { x: s.end.x, y: s.end.y },
      ]);
      const probe: Rect = { x: b.x, y: b.y - s.effectiveSize * 0.25, w: Math.max(b.w, 0.5), h: Math.max(b.h, 0.5) + s.effectiveSize };
      return overlapRatio(probe, hit) > 0.3;
    });

    if (!members.length) { report.skipped++; continue; }

    // Remove the block's glyphs, exactly like a redaction would.
    let removedAny = false;
    for (const show of members) {
      const font = show.state.font ? fonts.get(show.state.font) : undefined;
      const { codes, tj } = analyse(ops[show.opIndex], font);
      if (!codes.length) continue;
      const boxes = glyphBoxes(
        codes, font, show.state.size, show.state.charSpacing, show.state.wordSpacing,
        show.state.hScale, show.state.rise, show.tm, show.ctm, tj,
      );
      const keep: number[] = [];
      let removed = 0;
      for (const g of boxes) {
        const gb = boundsOf(g.corners);
        if (overlapRatio(gb, hit) >= GLYPH_HIT) removed++;
        else keep.push(g.index);
      }
      if (!removed) continue;
      removedAny = true;
      if (!keep.length) { doomedOps.set(show.opIndex, null); continue; }
      const items: Operand[] = [];
      let run: number[] = [];
      let skip = 0;
      const denom = show.state.size * show.state.hScale || 1;
      const flushRun = () => { if (run.length) { items.push({ t: "hex", v: encodeCodes(run, font) }); run = []; } };
      const flushSkip = () => {
        if (Math.abs(skip) < 1e-6) return;
        items.push({ t: "num", v: -(skip * 1000) / denom });
        skip = 0;
      };
      const keepSet = new Set(keep);
      for (const g of boxes) {
        const adj = tj.get(g.index);
        if (adj) { flushRun(); skip += (-adj / 1000) * show.state.size * show.state.hScale; }
        if (keepSet.has(g.index)) { flushSkip(); run.push(g.code); }
        else { flushRun(); skip += g.advance; }
      }
      flushRun();
      flushSkip();
      doomedOps.set(show.opIndex, { op: "TJ", args: [{ t: "arr", v: items }] });
    }

    if (!removedAny) { report.skipped++; continue; }
    if (edit.deleted || !edit.text.trim()) continue;

    // --- re-emit the new text ------------------------------------------------
    const first = members.reduce((best, s) => (s.origin.y > best.origin.y ? s : best), members[0]);
    const resource = edit.fontResource ?? first.state.font;
    const font = resource ? fonts.get(resource) : undefined;
    const size = edit.fontSize > 0 ? edit.fontSize : first.effectiveSize || first.state.size || 11;
    const rotated = Math.abs(first.tm[1]) > 0.01 || Math.abs(first.tm[2]) > 0.01;
    const colour = edit.color ?? rgbHex(first.state.fill);
    const leading = edit.leading > 0 ? edit.leading : size * 1.2;

    const lines = font && !rotated ? wrapNative(font, edit.text, size, box.w) : null;
    if (font && lines && !rotated) {
      const startY = target.y + target.h - size * 0.84;
      const ops2: Op[] = [
        { op: "q", args: [] },
        { op: "BT", args: [] },
        { op: "Tf", args: [{ t: "name", v: resource! }, { t: "num", v: round(size, 3) }] },
        { op: "rg", args: rgbOperands(colour) },
      ];
      let ok = true;
      lines.forEach((line, i) => {
        if (!ok) return;
        const bytes = line ? font.encode(line) : new Uint8Array(0);
        if (bytes === null) { ok = false; return; }
        const w = measureNative(font, line, size) ?? 0;
        const x =
          edit.align === "center" ? box.x + (box.w - w) / 2
            : edit.align === "right" ? box.x + box.w - w
              : box.x;
        const y = startY - i * leading;
        ops2.push({ op: "Tm", args: [1, 0, 0, 1, round(x, 3), round(y, 3)].map((v) => ({ t: "num", v }) as Operand) });
        if (bytes.length) ops2.push({ op: "Tj", args: [{ t: "hex", v: bytes }] });
      });
      if (ok) {
        ops2.push({ op: "ET", args: [] }, { op: "Q", args: [] });
        emitted.push(...ops2);
        report.native++;
        continue;
      }
    }

    fallbacks.push({ edit, box, size, color: colour });
  }

  // Rewrite the operator list.
  if (doomedOps.size || emitted.length) {
    const next: Op[] = [];
    for (let i = 0; i < ops.length; i++) {
      if (doomedOps.has(i)) {
        const rep = doomedOps.get(i);
        if (rep) next.push(rep);
        continue;
      }
      next.push(ops[i]);
    }
    next.push(...emitted);
    writePageContent(doc, page, next);
  }

  // Blocks the original font could not encode: draw with a substituted face.
  if (fallbacks.length) {
    const res = new PageResources(page);
    const painter = new Painter(res);
    for (const f of fallbacks) {
      const { font, unicode } = await fontBook.get(f.edit.fontFamily, f.edit.bold, f.edit.italic);
      const body = sanitiseForFont(f.edit.text, unicode);
      const lines = wrapText(font, body, f.size, f.box.w);
      const leading = f.edit.leading > 0 ? f.edit.leading : f.size * 1.2;
      painter.save().fillColor(hexToRgb(f.color));
      lines.forEach((line, i) => {
        if (!line) return;
        const w = measure(font, line, f.size);
        const x =
          f.edit.align === "center" ? f.box.x + (f.box.w - w) / 2
            : f.edit.align === "right" ? f.box.x + f.box.w - w
              : f.box.x;
        painter.text(font, f.size, { x, y: f.box.y + f.box.h - f.size * 0.84 - i * leading }, line);
      });
      painter.restore();
      report.substituted++;
    }
    if (!painter.isEmpty) {
      const stream = doc.context.stream(`q\n${painter.toString()}\nQ\n`);
      page.node.addContentStream(doc.context.register(stream));
    }
  }

  return report;
}

function rgbHex(c: { r: number; g: number; b: number }): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function rgbOperands(hex: string): Operand[] {
  const c = hexToRgb(hex);
  return [c.r, c.g, c.b].map((v) => ({ t: "num", v: round(v, 4) }) as Operand);
}

/**
 * Delete or replace the page's own images.
 * A deleted image's `Do` operator is dropped; a replacement is embedded and
 * drawn with the same transformation matrix so it lands exactly in place.
 */
export async function applyImageEdits(
  doc: PDFDocument,
  page: PDFPage,
  edits: readonly { occurrence: number; action: "delete" | "replace"; src?: string }[],
  embed: (src: string) => Promise<{ ref: import("pdf-lib").PDFRef } | null>,
): Promise<number> {
  if (!edits.length) return 0;
  const { ops } = await readPageContent(page);
  const { walkPlacements } = await import("../core/contentstream");
  const places = walkPlacements(ops).filter((p) => p.name !== null);
  let changed = 0;
  const replacements = new Map<number, Op | null>();

  for (const edit of edits) {
    const place = places[edit.occurrence];
    if (!place) continue;
    if (edit.action === "delete") {
      replacements.set(place.opIndex, null);
      changed++;
      continue;
    }
    if (!edit.src) continue;
    const embedded = await embed(edit.src);
    if (!embedded) continue;
    const name = page.node.newXObject("Image", embedded.ref).asString().replace(/^\//, "");
    replacements.set(place.opIndex, { op: "Do", args: [{ t: "name", v: name }] });
    changed++;
  }

  if (replacements.size) {
    const next: Op[] = [];
    for (let i = 0; i < ops.length; i++) {
      if (replacements.has(i)) {
        const rep = replacements.get(i);
        if (rep) next.push(rep);
        continue;
      }
      next.push(ops[i]);
    }
    writePageContent(doc, page, next);
  }
  return changed;
}
