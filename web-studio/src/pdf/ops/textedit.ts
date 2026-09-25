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
  /** Characters no available font could show (dropped from the file). */
  missing: string[];
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
    if (wide) {
      out[i * 2] = (c >> 8) & 0xff;
      out[i * 2 + 1] = c & 0xff;
    } else out[i] = c & 0xff;
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
    if (!para) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const candidate = line + word;
      const w = measureNative(font, candidate, size);
      if (w === null) return null;
      if (w <= maxWidth || !line.trim()) line = candidate;
      else {
        out.push(line.replace(/\s+$/, ""));
        line = word.trimStart();
      }
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
  const report: TextEditReport = { native: 0, substituted: 0, skipped: 0, missing: [] };
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
    // Added text: nothing to remove, set in the chosen face where it was placed.
    if (edit.isNew) {
      if (edit.deleted || !edit.text.trim()) continue;
      const at = frame.rectToPdf(edit.placement ?? edit.rect);
      fallbacks.push({ edit, box: at, size: edit.fontSize > 0 ? edit.fontSize : 12, color: edit.color ?? "#000000" });
      continue;
    }
    const original = frame.rectToPdf(edit.rect);
    // The new text goes where the block now is (moved / resized), the old glyphs from where it was.
    const target = edit.placement ? frame.rectToPdf(edit.placement) : original;
    const box: Rect = { x: target.x, y: target.y, w: target.w, h: target.h };
    // A little slack: glyph boxes use nominal ascent/descent, not real metrics.
    const hit: Rect = { x: original.x - 1.5, y: original.y - 1.5, w: original.w + 3, h: original.h + 3 };

    const members = shows.filter((s) => {
      const b = boundsOf([
        { x: s.origin.x, y: s.origin.y },
        { x: s.end.x, y: s.end.y },
      ]);
      const probe: Rect = {
        x: b.x,
        y: b.y - s.effectiveSize * 0.25,
        w: Math.max(b.w, 0.5),
        h: Math.max(b.h, 0.5) + s.effectiveSize,
      };
      return overlapRatio(probe, hit) > 0.3;
    });

    if (!members.length) {
      report.skipped++;
      continue;
    }

    // Remove the block's glyphs, exactly like a redaction would.
    let removedAny = false;
    for (const show of members) {
      const font = show.state.font ? fonts.get(show.state.font) : undefined;
      const { codes, tj } = analyse(ops[show.opIndex], font);
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
      const keep: number[] = [];
      let removed = 0;
      for (const g of boxes) {
        const gb = boundsOf(g.corners);
        if (overlapRatio(gb, hit) >= GLYPH_HIT) removed++;
        else keep.push(g.index);
      }
      if (!removed) continue;
      removedAny = true;
      if (!keep.length) {
        doomedOps.set(show.opIndex, null);
        continue;
      }
      const items: Operand[] = [];
      let run: number[] = [];
      let skip = 0;
      const denom = show.state.size * show.state.hScale || 1;
      const flushRun = () => {
        if (run.length) {
          items.push({ t: "hex", v: encodeCodes(run, font) });
          run = [];
        }
      };
      const flushSkip = () => {
        if (Math.abs(skip) < 1e-6) return;
        items.push({ t: "num", v: -(skip * 1000) / denom });
        skip = 0;
      };
      const keepSet = new Set(keep);
      for (const g of boxes) {
        const adj = tj.get(g.index);
        if (adj) {
          flushRun();
          skip += (-adj / 1000) * show.state.size * show.state.hScale;
        }
        if (keepSet.has(g.index)) {
          flushSkip();
          run.push(g.code);
        } else {
          flushRun();
          skip += g.advance;
        }
      }
      flushRun();
      flushSkip();
      doomedOps.set(show.opIndex, { op: "TJ", args: [{ t: "arr", v: items }] });
    }

    if (!removedAny) {
      report.skipped++;
      continue;
    }
    if (edit.deleted || !edit.text.trim()) continue;

    // --- re-emit the new text ------------------------------------------------
    const first = members.reduce((best, s) => (s.origin.y > best.origin.y ? s : best), members[0]);
    const resource = edit.fontResource ?? first.state.font;
    const font = resource ? fonts.get(resource) : undefined;
    const size = edit.fontSize > 0 ? edit.fontSize : first.effectiveSize || first.state.size || 11;
    const rotated = Math.abs(first.tm[1]) > 0.01 || Math.abs(first.tm[2]) > 0.01;
    const colour = edit.color ?? rgbHex(first.state.fill);
    const leading = edit.leading > 0 ? edit.leading : size * 1.2;

    // A restyled block is set in the face the user chose, never in the original one.
    const lines = font && !rotated && !edit.restyled ? wrapNative(font, edit.text, size, box.w) : null;
    if (font && lines && !rotated) {
      const startY = target.y + target.h - size * 0.84;
      const ops2: Op[] = [
        { op: "q", args: [] },
        { op: "BT", args: [] },
        {
          op: "Tf",
          args: [
            { t: "name", v: resource! },
            { t: "num", v: round(size, 3) },
          ],
        },
        { op: "rg", args: rgbOperands(colour) },
      ];
      let ok = true;
      lines.forEach((line, i) => {
        if (!ok) return;
        const bytes = line ? font.encode(line) : new Uint8Array(0);
        if (bytes === null) {
          ok = false;
          return;
        }
        const w = measureNative(font, line, size) ?? 0;
        const x =
          edit.align === "center" ? box.x + (box.w - w) / 2 : edit.align === "right" ? box.x + box.w - w : box.x;
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

  // Rewrite the operator list. What is drawn after it assumes the default
  // graphics state: a stream left with a `cm` in force (Chromium's) is closed off first.
  const isolate = !leavesDefaultState(ops) && (emitted.length > 0 || fallbacks.length > 0);
  if (doomedOps.size || emitted.length || isolate) {
    const next: Op[] = [];
    for (let i = 0; i < ops.length; i++) {
      if (doomedOps.has(i)) {
        const rep = doomedOps.get(i);
        if (rep) next.push(rep);
        continue;
      }
      next.push(ops[i]);
    }
    writePageContent(doc, page, isolate ? [...isolated(next), ...emitted] : [...next, ...emitted]);
  }

  // Blocks the original font could not encode: draw with a substituted face.
  if (fallbacks.length) {
    const res = new PageResources(page);
    const painter = new Painter(res);
    for (const f of fallbacks) {
      const { font, unicode, missing } = await fontBook.forText(
        f.edit.fontFamily,
        !!f.edit.bold,
        !!f.edit.italic,
        f.edit.text,
      );
      if (missing) report.missing.push(missing);
      const body = sanitiseForFont(f.edit.text, unicode);
      const lines = wrapText(font, body, f.size, f.box.w);
      const leading = f.edit.leading > 0 ? f.edit.leading : f.size * 1.2;
      painter.save().fillColor(hexToRgb(f.color));
      lines.forEach((line, i) => {
        if (!line) return;
        const w = measure(font, line, f.size);
        const x =
          f.edit.align === "center"
            ? f.box.x + (f.box.w - w) / 2
            : f.edit.align === "right"
              ? f.box.x + f.box.w - w
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
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function rgbOperands(hex: string): Operand[] {
  const c = hexToRgb(hex);
  return [c.r, c.g, c.b].map((v) => ({ t: "num", v: round(v, 4) }) as Operand);
}

/**
 * True when the content ends as it began: no `q` left open, no `cm`, clip or
 * extended state still in force. Anything appended to such a stream is drawn in plain page space.
 */
export function leavesDefaultState(ops: readonly Op[]): boolean {
  // Operators whose effect outlives them and would move, clip or blend what follows.
  const LASTING = new Set(["cm", "W", "W*", "gs"]);
  let depth = 0;
  let dirty = false;
  for (const { op } of ops) {
    if (op === "q") depth++;
    else if (op === "Q") depth = Math.max(0, depth - 1);
    else if (depth === 0 && LASTING.has(op)) dirty = true;
  }
  return depth === 0 && !dirty;
}

/** `ops` inside `q … Q`, so what follows starts from the default state. */
export function isolated(ops: readonly Op[]): Op[] {
  return [{ op: "q", args: [] }, ...ops, { op: "Q", args: [] }];
}

/** An XObject placement of a page, as the image editor lists it (same order as `ImageEdit.occurrence`). */
export interface PagePlacement {
  occurrence: number;
  name: string;
  /** An image (not a form XObject: those are not edited as pictures). */
  isImage: boolean;
  /** Corners in PDF user space (unit square under the CTM). */
  corners: { x: number; y: number }[];
}

/** Every named XObject drawn by the page's own content, in draw order. */
export async function pagePlacements(page: PDFPage): Promise<PagePlacement[]> {
  const { ops } = await readPageContent(page);
  const { walkPlacements } = await import("../core/contentstream");
  const { PDFDict, PDFName, PDFStream } = await import("pdf-lib");
  const xobjects = page.node.Resources()?.lookup(PDFName.of("XObject"));
  return walkPlacements(ops)
    .filter((p) => p.name !== null)
    .map((p, occurrence) => {
      const x = xobjects instanceof PDFDict ? xobjects.lookup(PDFName.of(p.name!)) : undefined;
      const isImage = x instanceof PDFStream && x.dict.lookup(PDFName.of("Subtype"))?.toString() === "/Image";
      return { occurrence, name: p.name!, isImage, corners: p.corners };
    });
}

/** The affine map taking PDF rect `a` onto PDF rect `b` (a scale + a shift: orientation kept). */
function rectToRect(a: Rect, b: Rect): number[] {
  const sx = a.w ? b.w / a.w : 1;
  const sy = a.h ? b.h / a.h : 1;
  return [sx, 0, 0, sy, b.x - a.x * sx, b.y - a.y * sy];
}

const num = (v: number): Operand => ({ t: "num", v: round(v, 5) });

/**
 * Edit the page's own images, and add new ones to its content: delete (the
 * `Do` goes), replace (a new XObject drawn with the same matrix), move /
 * resize (the draw wrapped in `q M cm … Q`, M taking the old frame onto the
 * new one — a rotated or mirrored original stays so), add (drawn last, over
 * the page content).
 */
export async function applyImageEdits(
  doc: PDFDocument,
  page: PDFPage,
  edits: readonly { occurrence: number; action: "delete" | "replace" | "move" | "add"; src?: string; rect?: Rect }[],
  embed: (src: string) => Promise<{ ref: import("pdf-lib").PDFRef } | null>,
): Promise<number> {
  if (!edits.length) return 0;
  const { ops } = await readPageContent(page);
  const { walkPlacements } = await import("../core/contentstream");
  const { pageFrame } = await import("./annots-pdf");
  const frame = pageFrame(page);
  const places = walkPlacements(ops).filter((p) => p.name !== null);
  let changed = 0;
  const replacements = new Map<number, Op[]>();
  const appended: Op[] = [];

  for (const edit of edits) {
    if (edit.action === "add") {
      if (!edit.src || !edit.rect) continue;
      const embedded = await embed(edit.src);
      if (!embedded) continue;
      const name = page.node.newXObject("Image", embedded.ref).asString().replace(/^\//, "");
      const r = frame.rectToPdf(edit.rect);
      appended.push(
        { op: "q", args: [] },
        { op: "cm", args: [r.w, 0, 0, r.h, r.x, r.y].map(num) },
        { op: "Do", args: [{ t: "name", v: name }] },
        { op: "Q", args: [] },
      );
      changed++;
      continue;
    }
    const place = places[edit.occurrence];
    if (!place) continue;
    if (edit.action === "delete") {
      replacements.set(place.opIndex, []);
      changed++;
      continue;
    }
    let name = place.name!;
    if (edit.action === "replace") {
      if (!edit.src) continue;
      const embedded = await embed(edit.src);
      if (!embedded) continue;
      name = page.node.newXObject("Image", embedded.ref).asString().replace(/^\//, "");
    }
    const draw: Op = { op: "Do", args: [{ t: "name", v: name }] };
    if (edit.rect) {
      const xs = place.corners.map((c) => c.x);
      const ys = place.corners.map((c) => c.y);
      const from: Rect = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
      };
      // The CTM at the Do is in user space: M is prepended in the same space.
      const m = rectToRect(from, frame.rectToPdf(edit.rect));
      replacements.set(place.opIndex, [
        { op: "q", args: [] },
        ...(await inverseCtm(place.ctm)),
        { op: "cm", args: m.map(num) },
        { op: "cm", args: place.ctm.map(num) },
        draw,
        { op: "Q", args: [] },
      ]);
    } else {
      replacements.set(place.opIndex, [draw]);
    }
    changed++;
  }

  if (replacements.size || appended.length) {
    const next: Op[] = [];
    for (let i = 0; i < ops.length; i++) {
      const rep = replacements.get(i);
      if (rep) next.push(...rep);
      else next.push(ops[i]);
    }
    // Added pictures are placed in page space, whatever state the content leaves.
    const body = appended.length && !leavesDefaultState(next) ? isolated(next) : next;
    writePageContent(doc, page, [...body, ...appended]);
  }
  return changed;
}

/**
 * `cm` operators cancelling the CTM in force at a placement: moving an image
 * is expressed in user space, from the identity — whatever the page's content
 * had set before the `Do`.
 */
async function inverseCtm(ctm: readonly number[]): Promise<Op[]> {
  const [a, b, c, d, e, f] = ctm;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [];
  const inv = [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
  return [{ op: "cm", args: inv.map(num) }];
}
