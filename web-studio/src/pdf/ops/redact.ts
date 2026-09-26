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

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";
import type { PDFDocument, PDFObject, PDFPage } from "pdf-lib";
import type { Mat, Op, Operand } from "../core/contentstream";
import {
  IDENTITY,
  mul,
  parseContentStream,
  walkPaths,
  walkPlacements,
  walkText,
  writeContentStream,
} from "../core/contentstream";
import type { FontMetrics } from "../core/fontmetrics";
import { loadFontsFrom, widthFnFor } from "../core/fontmetrics";
import type { Rect } from "../core/coords";
import { readPageContent, readPageContentBytes, writePageContent, glyphBoxes, boundsOf } from "./content";

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
  /** Pictures whose covered pixels were destroyed (the rest kept). */
  imagesEdited?: number;
  /** Subpaths (line art, text drawn as outlines) removed or cut back under the areas. */
  pathsRemoved?: number;
  /** What could only be done coarsely (an image removed whole…). */
  warnings?: string[];
}

interface Scope {
  doc: PDFDocument;
  /** Where the operators' resources are, and where new XObjects are named. */
  resources: PDFDict;
  fonts: Map<string, FontMetrics>;
  depth: number;
  /** Forms being rewritten (a form drawing itself must not loop). */
  seen: Set<string>;
  result: Required<RedactionResult>;
}

const MAX_FORM_DEPTH = 8;

/**
 * Strip everything inside `rects` (PDF user space) from one page: glyphs
 * (also inside form XObjects, tiling patterns and soft-mask groups, which are
 * copied first — another page may draw them), the covered pixels of pictures
 * and of their masks, line art under the areas, and the annotations and form
 * fields there. The caller paints the boxes.
 */
export async function applyRedactions(
  doc: PDFDocument,
  page: PDFPage,
  rects: readonly Rect[],
): Promise<RedactionResult> {
  const result: Required<RedactionResult> = {
    glyphsRemoved: 0,
    imagesRemoved: 0,
    annotsRemoved: 0,
    imagesEdited: 0,
    pathsRemoved: 0,
    warnings: [],
  };
  if (!rects.length) return result;

  const { ops, fonts } = await readPageContent(page);
  if (ops.length) {
    // The page's own copy of its resources: they may be shared with other
    // pages, or inherited from /Pages, and are about to change.
    const current = page.node.Resources();
    const resources = current instanceof PDFDict ? current.clone(doc.context) : (doc.context.obj({}) as PDFDict);
    page.node.set(PDFName.of("Resources"), resources);
    const scope: Scope = { doc, resources, fonts, depth: 0, seen: new Set(), result };
    const next = await redactOps(ops, scope, rects, IDENTITY);
    if (next) {
      writePageContent(doc, page, next);
      dropUnusedXObjects(doc, resources, next);
    }
  }
  result.annotsRemoved = removeAnnotsIn(doc, page, rects);
  return result;
}

/** What replaces an operator: another, several, or nothing (null). */
type Replacement = Op | Op[] | null;

/**
 * The operators that redo what `'` and `"` do before showing text (a line
 * move, and `"`'s spacings), for the show that replaces them.
 */
function lineMoveOf(op: Op): Op[] {
  if (op.op === "'") return [{ op: "T*", args: [] }];
  if (op.op === '"' && op.args.length >= 3)
    return [
      { op: "Tw", args: [op.args[0]] },
      { op: "Tc", args: [op.args[1]] },
      { op: "T*", args: [] },
    ];
  return [];
}

/** The operators with what lies in `rects` removed; null when nothing was. */
async function redactOps(ops: readonly Op[], scope: Scope, rects: readonly Rect[], start: Mat): Promise<Op[] | null> {
  const { fonts, result } = scope;
  const replacements = new Map<number, Replacement>();

  // --- text -----------------------------------------------------------------
  for (const show of walkText(ops, widthFnFor(fonts), start)) {
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
      replacements.set(show.opIndex, [...lineMoveOf(op), shiftOnly(skipped, show.state.size, show.state.hScale)]);
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

    replacements.set(show.opIndex, [...lineMoveOf(op), { op: "TJ", args: [{ t: "arr", v: items }] }]);
  }

  // Patterns and soft masks first: they look at the paths as drawn.
  let resourcesChanged = await redactPatterns(ops, scope, rects, start);
  if (await redactSoftMasks(ops, scope, rects, start)) resourcesChanged = true;

  // --- line art: every subpath that meets an area goes (text drawn as
  // outlines, a shape carrying meaning); the others stay. A filled rectangle
  // only partly covered keeps its visible part.
  for (const path of walkPaths(ops, start)) {
    if (!rects.some((r) => meets(rectOf(path.box), r))) continue;
    const rebuilt = redactPath(ops, path, rects);
    if (!rebuilt) continue;
    replacements.set(path.from, rebuilt.ops);
    for (let i = path.from + 1; i <= path.to; i++) replacements.set(i, null);
    result.pathsRemoved += rebuilt.removed;
  }

  // --- pictures and forms ------------------------------------------------------
  const xobjects = scope.resources.lookup(PDFName.of("XObject"));
  for (const place of walkPlacements(ops, start)) {
    const b = boundsOf(place.corners);
    const hit = rects.some((r) => intersects(b, r));
    if (!place.name) {
      // An inline image: small by nature; removed when touched.
      if (hit) {
        replacements.set(place.opIndex, null);
        result.imagesRemoved++;
      }
      continue;
    }
    const target = xobjects instanceof PDFDict ? xobjects.get(PDFName.of(place.name)) : undefined;
    const xo = target instanceof PDFRef ? scope.doc.context.lookup(target) : target;
    if (!(xo instanceof PDFRawStream)) {
      if (hit) {
        replacements.set(place.opIndex, null);
        result.imagesRemoved++;
      }
      continue;
    }
    const subtype = xo.dict.lookup(PDFName.of("Subtype"))?.toString();
    if (subtype === "/Form") {
      const renamed = await redactForm(xo, target, place.ctm, scope, rects);
      if (renamed) replacements.set(place.opIndex, { op: "Do", args: [{ t: "name", v: renamed }] });
      continue;
    }
    if (!hit) continue;
    const edited = await redactImage(scope.doc, xo, place.ctm, rects, result.warnings);
    if (edited) {
      const name = addXObject(scope, edited);
      replacements.set(place.opIndex, { op: "Do", args: [{ t: "name", v: name }] });
      result.imagesEdited++;
    } else {
      replacements.set(place.opIndex, null);
      result.imagesRemoved++;
      warn(
        result,
        "Une image n'a pas pu être modifiée pixel par pixel (format non pris en charge) : elle est retirée entière.",
      );
    }
  }

  if (!replacements.size && !resourcesChanged) return null;
  const next: Op[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (!replacements.has(i)) {
      next.push(ops[i]);
      continue;
    }
    const rep = replacements.get(i);
    if (Array.isArray(rep)) next.push(...rep);
    else if (rep) next.push(rep);
  }
  return next;
}

function warn(result: Required<RedactionResult>, note: string): void {
  if (!result.warnings.includes(note)) result.warnings.push(note);
}

const CONSTRUCT = new Set(["m", "l", "c", "v", "y", "h", "re"]);
const FILL_ONLY = new Set(["f", "F", "f*"]);

/** How far a subpath may reach into an area and still be kept (a shared edge, rounding). */
const EDGE = 0.05;

/**
 * Whether `a` really reaches into `b` — more than an edge's width; a flat box
 * (a horizontal or vertical line) when it runs inside it.
 */
function meets(a: Rect, b: Rect): boolean {
  const along = (a0: number, al: number, b0: number, bl: number) => {
    if (al <= EDGE) {
      const mid = a0 + al / 2;
      return mid > b0 && mid < b0 + bl;
    }
    return Math.min(a0 + al, b0 + bl) - Math.max(a0, b0) > EDGE;
  };
  return along(a.x, a.w, b.x, b.w) && along(a.y, a.h, b.y, b.h);
}

const rectOf = (b: { x0: number; y0: number; x1: number; y1: number }): Rect => ({
  x: b.x0,
  y: b.y0,
  w: b.x1 - b.x0,
  h: b.y1 - b.y0,
});

/** `p` without `cut`: up to four rectangles that do not overlap. */
function subtract(p: Rect, cut: Rect): Rect[] {
  const x0 = Math.max(p.x, cut.x);
  const x1 = Math.min(p.x + p.w, cut.x + cut.w);
  const y0 = Math.max(p.y, cut.y);
  const y1 = Math.min(p.y + p.h, cut.y + cut.h);
  if (x1 <= x0 || y1 <= y0) return [p];
  const out: Rect[] = [];
  if (y0 > p.y) out.push({ x: p.x, y: p.y, w: p.w, h: y0 - p.y });
  if (p.y + p.h > y1) out.push({ x: p.x, y: y1, w: p.w, h: p.y + p.h - y1 });
  if (x0 > p.x) out.push({ x: p.x, y: y0, w: x0 - p.x, h: y1 - y0 });
  if (p.x + p.w > x1) out.push({ x: x1, y: y0, w: p.x + p.w - x1, h: y1 - y0 });
  return out;
}

interface Subpath {
  /** Its construction operators. */
  ops: Op[];
  /** Its box in user space (control points included: on the safe side). */
  box: Rect;
  /** A lone `re`: its rectangle in the path's own space. */
  rect?: [number, number, number, number];
}

/**
 * One painted path without its subpaths that meet an area. Null when every
 * subpath is clear, or when the path holds operators it does not know.
 */
function redactPath(
  ops: readonly Op[],
  path: { from: number; to: number; ctm: Mat },
  rects: readonly Rect[],
): { ops: Op[]; removed: number } | null {
  const num = (o: Operand | undefined) => (o && o.t === "num" ? o.v : 0);
  const paint = ops[path.to];
  const clip: Op[] = [];
  const subs: Subpath[] = [];
  let pts: { x: number; y: number }[] = [];
  let current: Subpath | null = null;
  const close = () => {
    if (current && pts.length) current.box = boundsOf(pts);
    pts = [];
  };
  for (let i = path.from; i < path.to; i++) {
    const o = ops[i];
    if (o.op === "W" || o.op === "W*") {
      clip.push(o);
      continue;
    }
    if (!CONSTRUCT.has(o.op)) return null;
    const coords: [number, number][] = [];
    for (let k = 0; k + 1 < o.args.length; k += 2) coords.push([num(o.args[k]), num(o.args[k + 1])]);
    if (o.op === "re") {
      const [x, y, w, h] = [num(o.args[0]), num(o.args[1]), num(o.args[2]), num(o.args[3])];
      coords.splice(0, coords.length, [x, y], [x + w, y], [x + w, y + h], [x, y + h]);
    }
    if (o.op === "m" || o.op === "re" || !current) {
      close();
      current = { ops: [], box: { x: 0, y: 0, w: 0, h: 0 } };
      subs.push(current);
      if (o.op === "re") current.rect = [num(o.args[0]), num(o.args[1]), num(o.args[2]), num(o.args[3])];
    } else if (current.rect) current.rect = undefined; // a segment after `re`: no longer a plain rectangle
    current.ops.push(o);
    for (const [x, y] of coords) pts.push(apply(path.ctm, x, y));
  }
  close();

  const inv = invert(path.ctm);
  const straight = Math.abs(path.ctm[1]) < 1e-9 && Math.abs(path.ctm[2]) < 1e-9;
  const quarter = Math.abs(path.ctm[0]) < 1e-9 && Math.abs(path.ctm[3]) < 1e-9;
  const kept: Op[] = [];
  let removed = 0;
  for (const sp of subs) {
    if (!rects.some((r) => meets(sp.box, r))) {
      kept.push(...sp.ops);
      continue;
    }
    removed++;
    // A filled rectangle keeps what lies outside the areas (exact: the pieces do not overlap).
    if (sp.rect && FILL_ONLY.has(paint.op) && inv && (straight || quarter)) {
      let pieces = [sp.box];
      for (const r of rects) pieces = pieces.flatMap((p) => subtract(p, r));
      for (const p of pieces) {
        if (p.w <= EDGE || p.h <= EDGE) continue;
        const a = apply(inv, p.x, p.y);
        const b = apply(inv, p.x + p.w, p.y + p.h);
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        kept.push({
          op: "re",
          args: [x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y)].map((v) => ({ t: "num" as const, v })),
        });
      }
    }
  }
  if (!removed) return null;
  const out: Op[] = [];
  // A clipping path keeps clipping, whatever is left to paint.
  if (clip.length) out.push(...ops.slice(path.from, path.to), { op: "n", args: [] });
  if (kept.length) out.push(...kept, { op: paint.op, args: [] });
  return { ops: out, removed };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function invert(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

const apply = (m: Mat, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

/** A resource dictionary's entry, with `key` → `value` set in a copy of its category (never shared). */
function setResource(scope: Scope, category: string, key: string, value: PDFObject): void {
  const ctx = scope.doc.context;
  const current = scope.resources.lookup(PDFName.of(category));
  const dict = current instanceof PDFDict ? current.clone(ctx) : (ctx.obj({}) as PDFDict);
  dict.set(PDFName.of(key), value);
  scope.resources.set(PDFName.of(category), dict);
}

/** Name `ref` in the scope's /XObject resources (a fresh name; the dictionary copied, never shared). */
function addXObject(scope: Scope, ref: PDFRef): string {
  const current = scope.resources.lookup(PDFName.of("XObject"));
  let n = 1;
  while (current instanceof PDFDict && current.get(PDFName.of(`Rd${n}`))) n++;
  setResource(scope, "XObject", `Rd${n}`, ref);
  return `Rd${n}`;
}

/** Decoded operators of a content stream; null when it cannot be read. */
function streamOps(s: unknown): Op[] | null {
  if (!(s instanceof PDFRawStream)) return null;
  try {
    return parseContentStream(decodePDFRawStream(s).decode());
  } catch {
    return null;
  }
}

/**
 * XObject names the new operators no longer draw: out of the resources (their
 * objects can then go). What draws with these resources without its own —
 * a form, a pattern, a soft-mask group, a Type 3 glyph — counts as drawing.
 */
function dropUnusedXObjects(doc: PDFDocument, resources: PDFDict, ops: readonly Op[]): void {
  const current = resources.lookup(PDFName.of("XObject"));
  if (!(current instanceof PDFDict)) return;
  const noResources = (s: unknown): s is PDFRawStream =>
    s instanceof PDFRawStream && !(s.dict.lookup(PDFName.of("Resources")) instanceof PDFDict);
  const queue: (readonly Op[])[] = [ops];
  const seen = new Set<unknown>();
  const visit = (s: unknown) => {
    if (seen.has(s) || !noResources(s)) return;
    seen.add(s);
    const inner = streamOps(s);
    // Unreadable, it may draw anything: nothing is pruned.
    if (!inner) throw new Error("unreadable");
    queue.push(inner);
  };
  const each = (category: string, fn: (v: unknown) => void) => {
    const d = resources.lookup(PDFName.of(category));
    if (d instanceof PDFDict) for (const k of d.keys()) fn(d.lookup(k));
  };
  const used = new Set<string>();
  try {
    each("Pattern", visit);
    each("ExtGState", (g) => {
      const sm = g instanceof PDFDict ? g.lookup(PDFName.of("SMask")) : undefined;
      if (sm instanceof PDFDict) visit(sm.lookup(PDFName.of("G")));
    });
    each("Font", (f) => {
      if (!(f instanceof PDFDict) || f.lookup(PDFName.of("Resources")) instanceof PDFDict) return;
      const procs = f.lookup(PDFName.of("CharProcs"));
      if (procs instanceof PDFDict) for (const k of procs.keys()) visit(procs.lookup(k));
    });
    while (queue.length) {
      for (const o of queue.pop()!) {
        if (o.op !== "Do" || o.args[0]?.t !== "name") continue;
        used.add(o.args[0].v);
        const xo = current.lookup(PDFName.of(o.args[0].v));
        if (xo instanceof PDFRawStream && xo.dict.lookup(PDFName.of("Subtype"))?.toString() === "/Form") visit(xo);
      }
    }
  } catch {
    return;
  }
  const dict = current.clone(doc.context);
  let changed = false;
  for (const key of dict.keys()) {
    if (!used.has(key.asString().replace(/^\//, ""))) {
      dict.delete(key);
      changed = true;
    }
  }
  if (changed) resources.set(PDFName.of("XObject"), dict);
}

/** A form's /Matrix (identity when absent or malformed). */
function matrixOf(d: PDFDict): Mat {
  const mArr = d.lookup(PDFName.of("Matrix"));
  if (!(mArr instanceof PDFArray) || mArr.size() !== 6) return IDENTITY;
  return [0, 1, 2, 3, 4, 5].map((i) => {
    const v = mArr.lookup(i);
    return v instanceof PDFNumber ? v.asNumber() : 0;
  }) as Mat;
}

/** A /BBox as a rectangle (normalised), or null. */
function bboxOf(d: PDFDict): Rect | null {
  const bb = d.lookup(PDFName.of("BBox"));
  if (!(bb instanceof PDFArray) || bb.size() !== 4) return null;
  const [x0, y0, x1, y1] = [0, 1, 2, 3].map((i) => {
    const v = bb.lookup(i);
    return v instanceof PDFNumber ? v.asNumber() : 0;
  });
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/** A content stream's copy with `ops` as its content and `resources` as its resources. */
function copyStream(doc: PDFDocument, of: PDFRawStream, ops: readonly Op[], resources: PDFDict): PDFRef {
  const ctx = doc.context;
  const dict: Record<string, unknown> = {};
  for (const [k, v] of of.dict.entries()) {
    const name = k.asString();
    if (name !== "/Length" && name !== "/Filter" && name !== "/DecodeParms") dict[name.slice(1)] = v;
  }
  dict.Resources = resources;
  return ctx.register(ctx.flateStream(writeContentStream(ops), dict as never));
}

/**
 * A form XObject under an area: its content redacted in a copy (the form may
 * be drawn elsewhere, untouched). Returns the copy's name, or null when the
 * form is untouched.
 */
async function redactForm(
  xo: PDFRawStream,
  ref: unknown,
  ctm: Mat,
  scope: Scope,
  rects: readonly Rect[],
): Promise<string | null> {
  const copy = await redactFormCopy(xo, ref, ctm, scope, rects);
  return copy ? addXObject(scope, copy) : null;
}

/** A form (or a soft-mask group) drawn with `ctm`, redacted in a copy; null when untouched. */
async function redactFormCopy(
  xo: PDFRawStream,
  ref: unknown,
  ctm: Mat,
  scope: Scope,
  rects: readonly Rect[],
): Promise<PDFRef | null> {
  const key = ref instanceof PDFRef ? `${ref.objectNumber} ${ref.generationNumber}` : "";
  if (scope.depth >= MAX_FORM_DEPTH || (key && scope.seen.has(key))) return null;
  const inner = mul(matrixOf(xo.dict), ctm);
  // Its box on the page: nothing to do when no area reaches it.
  const bb = bboxOf(xo.dict);
  if (bb) {
    const box = boundsOf([
      apply(inner, bb.x, bb.y),
      apply(inner, bb.x + bb.w, bb.y),
      apply(inner, bb.x + bb.w, bb.y + bb.h),
      apply(inner, bb.x, bb.y + bb.h),
    ]);
    if (!rects.some((r) => intersects(box, r))) return null;
  }
  const ops = streamOps(xo);
  if (!ops) return null;
  const ownRes = xo.dict.lookup(PDFName.of("Resources"));
  const resources = (ownRes instanceof PDFDict ? ownRes : scope.resources).clone(scope.doc.context);
  const sub: Scope = {
    ...scope,
    resources,
    fonts: await loadFontsFrom(resources),
    depth: scope.depth + 1,
    seen: new Set([...scope.seen, key]),
  };
  const next = await redactOps(ops, sub, rects, inner);
  if (!next) return null;
  dropUnusedXObjects(scope.doc, resources, next);
  return copyStream(scope.doc, xo, next, resources);
}

/** Path painting operators that fill, and those that stroke. */
const FILLS = new Set(["f", "F", "f*", "B", "B*", "b", "b*"]);
const STROKES = new Set(["S", "s", "B", "B*", "b", "b*"]);

/** The pattern (resource name) each painting operator fills and strokes with. */
function patternsAt(ops: readonly Op[]): Map<number, { fill: string | null; stroke: string | null }> {
  const out = new Map<number, { fill: string | null; stroke: string | null }>();
  let cur = { fill: null as string | null, stroke: null as string | null };
  const stack: (typeof cur)[] = [];
  ops.forEach((o, i) => {
    const last = o.args[o.args.length - 1];
    switch (o.op) {
      case "q":
        stack.push(cur);
        break;
      case "Q":
        cur = stack.pop() ?? { fill: null, stroke: null };
        break;
      case "cs":
      case "g":
      case "rg":
      case "k":
      case "sc":
        cur = { ...cur, fill: null };
        break;
      case "CS":
      case "G":
      case "RG":
      case "K":
      case "SC":
        cur = { ...cur, stroke: null };
        break;
      case "scn":
        cur = { ...cur, fill: last?.t === "name" ? last.v : null };
        break;
      case "SCN":
        cur = { ...cur, stroke: last?.t === "name" ? last.v : null };
        break;
      default:
        if (FILLS.has(o.op) || STROKES.has(o.op)) out.set(i, cur);
    }
  });
  return out;
}

/** Tiles of a tiling pattern beyond which a pattern under an area is emptied rather than redacted. */
const MAX_TILE_RECTS = 4096;

/**
 * The areas in a tiling pattern's cell: every place of the cell that one of
 * its repetitions puts inside an area. Null when there would be too many.
 */
function tileRects(rects: readonly Rect[], toUser: Mat, cell: Rect, xStep: number, yStep: number): Rect[] | null {
  const inv = invert(toUser);
  if (!inv) return null;
  const out: Rect[] = [];
  const xs = Math.abs(xStep);
  const ys = Math.abs(yStep);
  for (const r of rects) {
    const p = boundsOf([
      apply(inv, r.x, r.y),
      apply(inv, r.x + r.w, r.y),
      apply(inv, r.x + r.w, r.y + r.h),
      apply(inv, r.x, r.y + r.h),
    ]);
    // Along an axis the area spans a whole step: every column (row) of the cell is under it.
    const xFull = !xs || p.w >= xs;
    const yFull = !ys || p.h >= ys;
    const range = (a0: number, al: number, c0: number, cl: number, step: number, full: boolean) => {
      if (full || !step) return [0];
      const out: number[] = [];
      for (let i = Math.floor((a0 - (c0 + cl)) / step); i <= Math.ceil((a0 + al - c0) / step); i++) out.push(i);
      return out;
    };
    const is = range(p.x, p.w, cell.x, cell.w, xs, xFull);
    const js = range(p.y, p.h, cell.y, cell.h, ys, yFull);
    if (is.length * js.length + out.length > MAX_TILE_RECTS) return null;
    for (const i of is) {
      for (const j of js) {
        const shifted: Rect = {
          x: xFull && xs ? cell.x : p.x - i * xs,
          y: yFull && ys ? cell.y : p.y - j * ys,
          w: xFull && xs ? cell.w : p.w,
          h: yFull && ys ? cell.h : p.h,
        };
        if (intersects(shifted, cell) || (xFull && yFull)) out.push(shifted);
      }
    }
  }
  return out;
}

/**
 * Tiling patterns painted over an area: their cell redacted in a copy —
 * wherever one of its repetitions falls under an area, in every repetition —
 * or emptied when that cannot be worked out. True when a pattern changed.
 */
async function redactPatterns(ops: readonly Op[], scope: Scope, rects: readonly Rect[], start: Mat): Promise<boolean> {
  const patterns = scope.resources.lookup(PDFName.of("Pattern"));
  if (!(patterns instanceof PDFDict)) return false;
  const using = patternsAt(ops);
  const hits = new Map<string, Rect[]>();
  for (const path of walkPaths(ops, start)) {
    const st = using.get(path.to);
    if (!st) continue;
    const paint = ops[path.to].op;
    const names = [FILLS.has(paint) ? st.fill : null, STROKES.has(paint) ? st.stroke : null];
    // The painted box, with room for a stroke's width.
    const pad = STROKES.has(paint) ? 5 : 0;
    const box = rectOf({ x0: path.box.x0 - pad, y0: path.box.y0 - pad, x1: path.box.x1 + pad, y1: path.box.y1 + pad });
    for (const name of names) {
      if (!name) continue;
      for (const r of rects) {
        const x0 = Math.max(box.x, r.x);
        const y0 = Math.max(box.y, r.y);
        const x1 = Math.min(box.x + box.w, r.x + r.w);
        const y1 = Math.min(box.y + box.h, r.y + r.h);
        if (x1 > x0 && y1 > y0) hits.set(name, [...(hits.get(name) ?? []), { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }]);
      }
    }
  }
  let changed = false;
  for (const [name, areas] of hits) {
    const ref = patterns.get(PDFName.of(name));
    const pat = ref instanceof PDFRef ? scope.doc.context.lookup(ref) : ref;
    if (!(pat instanceof PDFRawStream)) continue;
    const type = pat.dict.lookup(PDFName.of("PatternType"));
    if (!(type instanceof PDFNumber) || type.asNumber() !== 1) continue; // a shading: nothing written in it
    const n = (k: string) => {
      const v = pat.dict.lookup(PDFName.of(k));
      return v instanceof PDFNumber ? v.asNumber() : 0;
    };
    const cell = bboxOf(pat.dict);
    const key = ref instanceof PDFRef ? `${ref.objectNumber} ${ref.generationNumber}` : "";
    const own = pat.dict.lookup(PDFName.of("Resources"));
    const resources = own instanceof PDFDict ? own.clone(scope.doc.context) : (scope.doc.context.obj({}) as PDFDict);
    const inCell =
      cell && scope.depth < MAX_FORM_DEPTH && !scope.seen.has(key)
        ? tileRects(areas, mul(matrixOf(pat.dict), start), cell, n("XStep"), n("YStep"))
        : null;
    const ops = streamOps(pat);
    let next: Op[] | null;
    if (inCell && ops) {
      const sub: Scope = {
        ...scope,
        resources,
        fonts: await loadFontsFrom(resources),
        depth: scope.depth + 1,
        seen: new Set([...scope.seen, key]),
      };
      next = await redactOps(ops, sub, inCell, IDENTITY);
      if (!next) continue;
      dropUnusedXObjects(scope.doc, resources, next);
      warn(
        scope.result,
        "Un motif de remplissage passait sous une zone caviardée : ce qui s'y trouvait est retiré de chacune de ses répétitions.",
      );
    } else {
      next = [];
      warn(
        scope.result,
        "Un motif de remplissage sous une zone caviardée n'a pas pu être caviardé précisément : il est vidé entièrement.",
      );
    }
    setResource(scope, "Pattern", name, copyStream(scope.doc, pat, next, resources));
    changed = true;
  }
  return changed;
}

/**
 * Soft masks (graphics states' /SMask /G groups) set over an area: the group
 * redacted in a copy, in the space in force where the state is set. True when
 * one changed.
 */
async function redactSoftMasks(ops: readonly Op[], scope: Scope, rects: readonly Rect[], start: Mat): Promise<boolean> {
  const states = scope.resources.lookup(PDFName.of("ExtGState"));
  if (!(states instanceof PDFDict)) return false;
  const num = (o: Operand | undefined) => (o && o.t === "num" ? o.v : 0);
  const uses = new Map<string, Mat[]>();
  let ctm = start;
  const stack: Mat[] = [];
  for (const o of ops) {
    if (o.op === "q") stack.push(ctm);
    else if (o.op === "Q") ctm = stack.pop() ?? start;
    else if (o.op === "cm")
      ctm = mul([num(o.args[0]), num(o.args[1]), num(o.args[2]), num(o.args[3]), num(o.args[4]), num(o.args[5])], ctm);
    else if (o.op === "gs" && o.args[0]?.t === "name") uses.set(o.args[0].v, [...(uses.get(o.args[0].v) ?? []), ctm]);
  }
  let changed = false;
  for (const [name, ctms] of uses) {
    const gs = states.lookup(PDFName.of(name));
    const smask = gs instanceof PDFDict ? gs.lookup(PDFName.of("SMask")) : undefined;
    if (!(gs instanceof PDFDict) || !(smask instanceof PDFDict)) continue;
    let ref: unknown = smask.get(PDFName.of("G"));
    let group = ref instanceof PDFRef ? scope.doc.context.lookup(ref) : ref;
    let copied = false;
    for (const at of ctms) {
      if (!(group instanceof PDFRawStream)) break;
      const copy = await redactFormCopy(group, ref, at, scope, rects);
      if (!copy) continue;
      ref = copy;
      group = scope.doc.context.lookup(copy);
      copied = true;
    }
    if (!copied) continue;
    const mask = smask.clone(scope.doc.context);
    mask.set(PDFName.of("G"), ref as PDFRef);
    const state = gs.clone(scope.doc.context);
    state.set(PDFName.of("SMask"), mask);
    setResource(scope, "ExtGState", name, state);
    changed = true;
  }
  return changed;
}

/**
 * A picture under an area, with the covered pixels destroyed (a copy: the
 * picture may be drawn elsewhere). Raw and Flate pictures (PNG predictors
 * included) are edited in place; JPEG ones are decoded where the platform can
 * (a browser) and written back losslessly. Null when the picture cannot be
 * edited: the caller removes it whole.
 */
async function redactImage(
  doc: PDFDocument,
  xo: PDFRawStream,
  ctm: Mat,
  rects: readonly Rect[],
  warnings: string[],
  depth = 0,
): Promise<PDFRef | null> {
  const d = xo.dict;
  const n = (k: string) => {
    const v = d.lookup(PDFName.of(k));
    return v instanceof PDFNumber ? v.asNumber() : 0;
  };
  const W = n("Width");
  const H = n("Height");
  const inv = invert(ctm);
  if (!W || !H || !inv) return null;
  // The areas in pixels (a turned picture: their bounding boxes, on the safe side).
  const boxes = rects.flatMap((r) => {
    const pts = [
      apply(inv, r.x, r.y),
      apply(inv, r.x + r.w, r.y),
      apply(inv, r.x + r.w, r.y + r.h),
      apply(inv, r.x, r.y + r.h),
    ];
    const us = pts.map((p) => p.x * W);
    const vs = pts.map((p) => (1 - p.y) * H);
    const x0 = Math.max(0, Math.floor(Math.min(...us)));
    const x1 = Math.min(W, Math.ceil(Math.max(...us)));
    const y0 = Math.max(0, Math.floor(Math.min(...vs)));
    const y1 = Math.min(H, Math.ceil(Math.max(...vs)));
    return x1 > x0 && y1 > y0 ? [{ x0, x1, y0, y1 }] : [];
  });
  if (!boxes.length) return null;

  const filterObj = d.lookup(PDFName.of("Filter"));
  const filters =
    filterObj instanceof PDFName
      ? [filterObj.asString()]
      : filterObj instanceof PDFArray
        ? filterObj.asArray().map((f) => String(f))
        : [];
  const entries: Record<string, unknown> = {};
  for (const [k, v] of d.entries()) {
    const name = k.asString();
    if (name !== "/Length" && name !== "/Filter" && name !== "/DecodeParms") entries[name.slice(1)] = v;
  }
  // Its soft mask (alpha) and stencil mask are pictures of the same place:
  // their covered pixels go too (a copy each), or the mask goes.
  const redactMasks = async () => {
    for (const key of depth ? [] : ["SMask", "Mask"]) {
      const m = d.lookup(PDFName.of(key));
      if (!(m instanceof PDFRawStream)) continue; // a colour-key /Mask array holds no picture
      const edited = await redactImage(doc, m, ctm, rects, warnings, depth + 1);
      if (edited) entries[key] = edited;
      else {
        delete entries[key];
        const note =
          "Le masque de transparence d'une image caviardée n'a pas pu être modifié : il est retiré (l'image peut apparaître opaque).";
        if (!warnings.includes(note)) warnings.push(note);
      }
    }
  };

  if (filters.length === 1 && filters[0] === "/DCTDecode") {
    const rgba = await decodeJpeg(xo.getContents());
    if (!rgba || rgba.width !== W || rgba.height !== H) return null;
    const px = new Uint8Array(W * H * 3);
    for (let i = 0, j = 0; i < rgba.data.length; i += 4, j += 3) {
      px[j] = rgba.data[i];
      px[j + 1] = rgba.data[i + 1];
      px[j + 2] = rgba.data[i + 2];
    }
    for (const b of boxes) for (let y = b.y0; y < b.y1; y++) px.fill(0, (y * W + b.x0) * 3, (y * W + b.x1) * 3);
    delete entries.Decode;
    entries.ColorSpace = PDFName.of("DeviceRGB");
    entries.BitsPerComponent = 8;
    await redactMasks();
    return doc.context.register(doc.context.flateStream(px, entries as never));
  }
  if (filters.some((f) => f !== "/FlateDecode")) return null;

  const mask = d.lookup(PDFName.of("ImageMask"))?.toString() === "true";
  const bpc = mask ? 1 : n("BitsPerComponent");
  const comps = mask ? 1 : componentsOf(d.lookup(PDFName.of("ColorSpace")), doc);
  if (!bpc || !comps || ![1, 2, 4, 8, 16].includes(bpc)) return null;
  const rowBytes = Math.ceil((W * comps * bpc) / 8);
  let data: Uint8Array;
  try {
    data = filters.length ? decodePDFRawStream(xo).decode() : xo.getContents().slice();
  } catch {
    return null;
  }
  const parms = d.lookup(PDFName.of("DecodeParms"));
  const pred = parms instanceof PDFDict ? parms.lookup(PDFName.of("Predictor")) : undefined;
  const predictor = pred instanceof PDFNumber ? pred.asNumber() : 1;
  if (predictor >= 10) data = unPng(data, rowBytes, Math.max(1, Math.ceil((comps * bpc) / 8)), H);
  else if (predictor !== 1) return null;
  if (data.length < rowBytes * H) return null;
  // Black: every component 0, except CMYK's black (and a stencil's « not painted »: the box covers it).
  const cmyk = comps === 4;
  for (const b of boxes) {
    for (let y = b.y0; y < b.y1; y++) {
      for (let x = b.x0; x < b.x1; x++) {
        for (let c = 0; c < comps; c++) {
          const value = cmyk && c === 3 ? (1 << bpc) - 1 : 0;
          setSample(data, y * rowBytes, (x * comps + c) * bpc, bpc, value);
        }
      }
    }
  }
  await redactMasks();
  return doc.context.register(doc.context.flateStream(data.subarray(0, rowBytes * H), entries as never));
}

function setSample(data: Uint8Array, rowStart: number, bit: number, bpc: number, value: number): void {
  if (bpc === 8) data[rowStart + bit / 8] = value;
  else if (bpc === 16) {
    data[rowStart + bit / 8] = (value >> 8) & 255;
    data[rowStart + bit / 8 + 1] = value & 255;
  } else {
    const byte = rowStart + (bit >> 3);
    const shift = 8 - bpc - (bit & 7);
    const maskBits = ((1 << bpc) - 1) << shift;
    data[byte] = (data[byte] & ~maskBits) | ((value << shift) & maskBits);
  }
}

/** Components of a colour space (Indexed, Separation: one sample per pixel). */
function componentsOf(cs: unknown, doc: PDFDocument): number {
  const v = cs instanceof PDFRef ? doc.context.lookup(cs) : cs;
  if (v instanceof PDFName) {
    const s = v.asString();
    return s === "/DeviceGray" || s === "/CalGray"
      ? 1
      : s === "/DeviceRGB" || s === "/CalRGB"
        ? 3
        : s === "/DeviceCMYK"
          ? 4
          : 0;
  }
  if (v instanceof PDFArray && v.size()) {
    const kind = String(v.lookup(0));
    if (kind === "/Indexed" || kind === "/Separation") return 1;
    if (kind === "/DeviceN") {
      const names = v.lookup(1);
      return names instanceof PDFArray ? names.size() : 0;
    }
    if (kind === "/ICCBased") {
      const s = v.lookup(1);
      const nn = s instanceof PDFRawStream ? s.dict.lookup(PDFName.of("N")) : undefined;
      return nn instanceof PDFNumber ? nn.asNumber() : 0;
    }
    if (kind === "/Lab" || kind === "/CalRGB") return 3;
    if (kind === "/CalGray") return 1;
  }
  return 0;
}

/** PNG predictors (10-15) undone: raw rows. */
export function unPng(data: Uint8Array, rowBytes: number, bpp: number, rows: number): Uint8Array {
  const out = new Uint8Array(rowBytes * rows);
  const stride = rowBytes + 1;
  for (let r = 0; r < rows && (r + 1) * stride <= data.length; r++) {
    const type = data[r * stride];
    const src = r * stride + 1;
    const dst = r * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = data[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = r ? out[dst - rowBytes + i] : 0;
      const c = r && i >= bpp ? out[dst - rowBytes + i - bpp] : 0;
      let v = x;
      if (type === 1) v = x + a;
      else if (type === 2) v = x + b;
      else if (type === 3) v = x + ((a + b) >> 1);
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[dst + i] = v & 255;
    }
  }
  return out;
}

/** A JPEG decoded to RGBA where the platform offers it (browsers); null elsewhere. */
async function decodeJpeg(
  bytes: Uint8Array,
): Promise<{ width: number; height: number; data: Uint8ClampedArray } | null> {
  const g = globalThis as unknown as {
    createImageBitmap?: (b: Blob) => Promise<ImageBitmap>;
    OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvas;
  };
  if (!g.createImageBitmap || !g.OffscreenCanvas) return null;
  try {
    const bitmap = await g.createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
    const canvas = new g.OffscreenCanvas(bitmap.width, bitmap.height);
    const c2d = canvas.getContext("2d");
    if (!c2d) return null;
    c2d.drawImage(bitmap, 0, 0);
    bitmap.close();
    return c2d.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
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
 * Annotations under a redacted area go — any overlap: a comment's text, a
 * link's URL, a field's value are what redaction is about. A form field whose
 * widgets all went leaves the form with its value; one that keeps others
 * loses only those widgets.
 */
function removeAnnotsIn(doc: PDFDocument, page: PDFPage, rects: readonly Rect[]): number {
  const annots = page.node.Annots();
  if (!(annots instanceof PDFArray)) return 0;
  const ctx = doc.context;
  let removed = 0;
  for (let i = annots.size() - 1; i >= 0; i--) {
    const ref = annots.get(i);
    const dict = annots.lookup(i);
    if (!(dict instanceof PDFDict)) continue;
    const rectArr = dict.lookup(PDFName.of("Rect"));
    if (!(rectArr instanceof PDFArray) || rectArr.size() < 4) continue;
    const nums = [0, 1, 2, 3].map((k) => {
      const v = rectArr.lookup(k);
      return v instanceof PDFNumber ? v.asNumber() : 0;
    });
    const box: Rect = {
      x: Math.min(nums[0], nums[2]),
      y: Math.min(nums[1], nums[3]),
      w: Math.abs(nums[2] - nums[0]),
      h: Math.abs(nums[3] - nums[1]),
    };
    if (!rects.some((r) => intersects(box, r))) continue;
    annots.remove(i);
    // Its pop-up goes with it.
    const popup = dict.get(PDFName.of("Popup"));
    if (popup instanceof PDFRef) {
      for (let k = annots.size() - 1; k >= 0; k--) if (annots.get(k) === popup) annots.remove(k);
      ctx.delete(popup);
    }
    if (dict.lookup(PDFName.of("Subtype"))?.toString() === "/Widget" && ref instanceof PDFRef)
      detachWidget(doc, ref, dict);
    if (ref instanceof PDFRef) ctx.delete(ref);
    removed++;
  }
  return removed;
}

/** A widget out of its field; a field left without widgets out of its parent (and of /Fields). */
function detachWidget(doc: PDFDocument, ref: PDFRef, widget: PDFDict): void {
  const ctx = doc.context;
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  const fields = acro instanceof PDFDict ? acro.lookup(PDFName.of("Fields")) : undefined;
  const without = (arr: unknown, gone: PDFRef) => {
    if (!(arr instanceof PDFArray)) return;
    for (let i = arr.size() - 1; i >= 0; i--) {
      const v = arr.get(i);
      if (
        v === gone ||
        (v instanceof PDFRef && v.objectNumber === gone.objectNumber && v.generationNumber === gone.generationNumber)
      )
        arr.remove(i);
    }
  };
  let node: PDFRef = ref;
  let dict: PDFDict = widget;
  for (let guard = 0; guard < 32; guard++) {
    const parentRef = dict.get(PDFName.of("Parent"));
    const parent = parentRef instanceof PDFRef ? ctx.lookup(parentRef) : undefined;
    if (!(parentRef instanceof PDFRef) || !(parent instanceof PDFDict)) {
      // A root: out of the form.
      without(fields, node);
      return;
    }
    const kids = parent.lookup(PDFName.of("Kids"));
    without(kids, node);
    if (kids instanceof PDFArray && kids.size() > 0) return;
    // The field has nothing left: it goes too, value and all.
    ctx.delete(node);
    node = parentRef;
    dict = parent;
  }
}

/** What « Supprimer les informations masquées » removes (Acrobat's list). */
export interface HiddenInfoOptions {
  /** Document properties (all of /Info), XMP everywhere, private application data (/PieceInfo), thumbnails. */
  metadata: boolean;
  /** Attached files (/EmbeddedFiles, /AF, file attachment comments), multimedia. */
  attachments: boolean;
  /** Links, actions and JavaScript (document, pages, annotations, fields, bookmarks, XFA). */
  actions: boolean;
  bookmarks: boolean;
  /** Comments (every annotation that is not a form field or a link). */
  comments: boolean;
  /** Invisible text (rendering mode 3, e.g. an OCR layer). */
  hiddenText: boolean;
  /** Content of layers hidden by default; the layers themselves are merged. */
  hiddenLayers: boolean;
  /** Alternate and replacement text (/Alt, /ActualText, /E) of the structure and marked content. */
  structure: boolean;
}

export const ALL_HIDDEN_INFO: HiddenInfoOptions = {
  metadata: true,
  attachments: true,
  actions: true,
  bookmarks: true,
  comments: true,
  hiddenText: true,
  hiddenLayers: true,
  structure: true,
};

/** What follows a redaction by default: everything but the comments and the invisible (OCR) text. */
export const AFTER_REDACTION: HiddenInfoOptions = { ...ALL_HIDDEN_INFO, comments: false, hiddenText: false };

const MEDIA = new Set(["/FileAttachment", "/Movie", "/Screen", "/RichMedia", "/Sound", "/3D"]);

/**
 * The actions chained after a kept one (/Next, a dictionary or an array),
 * down to the last: only « go to a page » ones stay — a script or a launch
 * would otherwise run after it. True when one was removed.
 */
function stripNext(doc: PDFDocument, action: PDFDict, depth = 0): boolean {
  const raw = action.get(PDFName.of("Next"));
  if (!raw) return false;
  if (depth > 32) {
    action.delete(PDFName.of("Next"));
    return true;
  }
  const resolved = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
  const items = resolved instanceof PDFArray ? resolved.asArray() : [raw];
  let removed = false;
  const kept: PDFObject[] = [];
  for (const item of items) {
    const a = item instanceof PDFRef ? doc.context.lookup(item) : item;
    if (a instanceof PDFDict && a.lookup(PDFName.of("S"))?.toString() === "/GoTo") {
      if (stripNext(doc, a, depth + 1)) removed = true;
      kept.push(item);
    } else removed = true;
  }
  if (!removed) return false;
  if (!kept.length) action.delete(PDFName.of("Next"));
  else action.set(PDFName.of("Next"), kept.length === 1 ? kept[0] : doc.context.obj(kept));
  return true;
}

/**
 * Remove the hidden information chosen in `opts` — what may still carry text
 * a redaction removed, or what a document should not take with it. Returns
 * what was actually found and removed (never a category that had nothing).
 */
export async function removeHiddenInfo(doc: PDFDocument, opts: HiddenInfoOptions): Promise<{ removed: string[] }> {
  const removed = new Set<string>();
  const ctx = doc.context;
  const cat = doc.catalog;
  const del = (d: PDFDict, key: string, label: string) => {
    if (d.has(PDFName.of(key))) {
      d.delete(PDFName.of(key));
      removed.add(label);
    }
  };
  const names = cat.lookup(PDFName.of("Names"));
  const objects = ctx.enumerateIndirectObjects().map(([, o]) => (o instanceof PDFRawStream ? o.dict : o));

  if (opts.metadata) {
    const info = ctx.lookup(ctx.trailerInfo.Info);
    if (info instanceof PDFDict && info.keys().length) {
      for (const k of info.keys()) info.delete(k);
      removed.add("propriétés du document");
    }
    for (const o of objects) {
      if (!(o instanceof PDFDict)) continue;
      del(o, "Metadata", "métadonnées XMP");
      del(o, "PieceInfo", "données privées d'applications");
      del(o, "Thumb", "vignettes");
    }
  }

  if (opts.attachments) {
    if (names instanceof PDFDict) del(names, "EmbeddedFiles", "fichiers joints");
    for (const o of objects) if (o instanceof PDFDict) del(o, "AF", "fichiers joints");
  }

  if (opts.actions) {
    if (names instanceof PDFDict) del(names, "JavaScript", "JavaScript");
    del(cat, "OpenAction", "action à l'ouverture");
    del(cat, "AA", "actions automatiques");
    const acro = cat.lookup(PDFName.of("AcroForm"));
    if (acro instanceof PDFDict) del(acro, "XFA", "formulaire XFA (scripts)");
    for (const o of objects) {
      if (!(o instanceof PDFDict)) continue;
      del(o, "AA", "actions automatiques");
      // Bookmarks keep « go to a page »; any other action (script, launch, web…) goes.
      const a = o.lookup(PDFName.of("A"));
      if (a instanceof PDFDict && o.has(PDFName.of("Title")) && a.lookup(PDFName.of("S"))?.toString() !== "/GoTo") {
        o.delete(PDFName.of("A"));
        removed.add("actions des signets");
      } else if (a instanceof PDFDict && o.lookup(PDFName.of("Subtype"))?.toString() === "/Widget") {
        o.delete(PDFName.of("A"));
        removed.add("actions des champs");
      } else if (a instanceof PDFDict && stripNext(doc, a)) removed.add("actions enchaînées");
    }
  }

  // Annotations: links, comments, attachments — as chosen.
  for (const page of doc.getPages()) {
    if (opts.actions) del(page.node, "AA", "actions automatiques");
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const d = annots.lookup(i);
      if (!(d instanceof PDFDict)) continue;
      const sub = d.lookup(PDFName.of("Subtype"))?.toString() ?? "";
      const go =
        (opts.actions && sub === "/Link" && (removed.add("liens"), true)) ||
        (opts.attachments && MEDIA.has(sub) && (removed.add("fichiers joints et multimédia"), true)) ||
        (opts.comments &&
          sub !== "/Widget" &&
          sub !== "/Link" &&
          !MEDIA.has(sub) &&
          (removed.add("commentaires"), true));
      if (go) annots.remove(i);
    }
  }

  if (opts.bookmarks && cat.has(PDFName.of("Outlines"))) {
    cat.delete(PDFName.of("Outlines"));
    if (cat.lookup(PDFName.of("PageMode"))?.toString() === "/UseOutlines") cat.delete(PDFName.of("PageMode"));
    removed.add("signets");
  }

  if (opts.structure) {
    // Structure elements are often direct objects inside their parent's /K.
    const seen = new Set<unknown>();
    const strip = (v: unknown, depth: number) => {
      if (depth > 64 || seen.has(v)) return;
      seen.add(v);
      if (v instanceof PDFDict) {
        for (const k of ["Alt", "ActualText", "E"]) del(v, k, "textes de remplacement");
        for (const [, child] of v.entries()) if (!(child instanceof PDFRef)) strip(child, depth + 1);
      } else if (v instanceof PDFArray) {
        for (const child of v.asArray()) if (!(child instanceof PDFRef)) strip(child, depth + 1);
      }
    };
    for (const o of objects) strip(o, 0);
  }

  if (opts.hiddenLayers || opts.hiddenText || opts.structure) {
    const props = cat.lookup(PDFName.of("OCProperties"));
    const off = new Set<string>();
    const layers = opts.hiddenLayers && props instanceof PDFDict;
    if (layers) {
      const d = props.lookup(PDFName.of("D"));
      const base = d instanceof PDFDict ? d.lookup(PDFName.of("BaseState"))?.toString() : undefined;
      const list = (k: string) => {
        const a = d instanceof PDFDict ? d.lookup(PDFName.of(k)) : undefined;
        return a instanceof PDFArray ? a.asArray().map(String) : [];
      };
      const on = new Set(list("ON"));
      for (const r of list("OFF")) off.add(r);
      if (base === "/OFF") {
        const ocgs = props.lookup(PDFName.of("OCGs"));
        if (ocgs instanceof PDFArray) for (const r of ocgs.asArray()) if (!on.has(String(r))) off.add(String(r));
      }
    }
    const clean: CleanContext = {
      doc,
      opts,
      layers,
      visible: (oc) => ocVisible(doc, oc, off),
      done: new Set(),
      count: { text: 0, layers: 0, alt: 0 },
    };
    for (const page of doc.getPages()) {
      await cleanPage(page, clean);
    }
    if (clean.count.text) removed.add("texte invisible");
    if (clean.count.layers) removed.add("contenu des calques masqués");
    if (clean.count.alt) removed.add("textes de remplacement");
    if (layers) {
      cat.delete(PDFName.of("OCProperties"));
      removed.add("calques (fusionnés)");
    }
  }
  return { removed: [...removed] };
}

/**
 * Whether content tagged with `oc` (an optional content group, or a
 * membership dictionary: /OCGs with /P, or a /VE expression) shows when the
 * groups in `off` are off — the document's default view.
 */
function ocVisible(doc: PDFDocument, oc: unknown, off: ReadonlySet<string>): boolean {
  const groupOn = (v: unknown) => !(v instanceof PDFRef && off.has(String(v)));
  const expression = (e: unknown, depth: number): boolean => {
    const arr = e instanceof PDFRef ? doc.context.lookup(e) : e;
    if (!(arr instanceof PDFArray) || depth > 32) return groupOn(e);
    const op = arr.lookup(0)?.toString();
    const args = arr.asArray().slice(1);
    if (op === "/Not") return !expression(args[0], depth + 1);
    if (op === "/Or") return args.some((a) => expression(a, depth + 1));
    return args.every((a) => expression(a, depth + 1)); // /And
  };
  const d = oc instanceof PDFRef ? doc.context.lookup(oc) : oc;
  if (!(d instanceof PDFDict)) return true;
  if (d.lookup(PDFName.of("Type"))?.toString() !== "/OCMD" && !d.has(PDFName.of("OCGs"))) return groupOn(oc);
  const ve = d.lookup(PDFName.of("VE"));
  if (ve instanceof PDFArray) return expression(ve, 0);
  const raw = d.get(PDFName.of("OCGs"));
  const list = raw instanceof PDFArray ? raw.asArray() : raw instanceof PDFRef ? [raw] : [];
  const resolved =
    raw instanceof PDFRef && doc.context.lookup(raw) instanceof PDFArray
      ? (doc.context.lookup(raw) as PDFArray).asArray()
      : list;
  if (!resolved.length) return true;
  const states = resolved.map(groupOn);
  switch (d.lookup(PDFName.of("P"))?.toString()) {
    case "/AllOn":
      return states.every(Boolean);
    case "/AnyOff":
      return states.some((s) => !s);
    case "/AllOff":
      return states.every((s) => !s);
    default: // /AnyOn
      return states.some(Boolean);
  }
}

interface CleanContext {
  doc: PDFDocument;
  opts: HiddenInfoOptions;
  /** Hidden layers are being removed. */
  layers: boolean;
  visible: (oc: unknown) => boolean;
  /** Streams already cleaned (by object number): a form drawn twice is cleaned once. */
  done: Set<string>;
  count: { text: number; layers: number; alt: number };
}

/**
 * One page without invisible text, hidden layers' content, or the replacement
 * text of its marked content — in its content, the forms and patterns it
 * draws, and its annotations' appearances; annotations in a hidden layer go.
 */
async function cleanPage(page: PDFPage, c: CleanContext): Promise<void> {
  const bytes = readPageContentBytes(page);
  const resources = page.node.Resources();
  const res = resources instanceof PDFDict ? resources : undefined;
  if (bytes.length) {
    const next = await cleanOps(parseContentStream(bytes), res, c, 0);
    if (next) writePageContent(c.doc, page, next);
  }
  const annots = page.node.Annots();
  if (!(annots instanceof PDFArray)) return;
  const ctx = c.doc.context;
  for (let i = annots.size() - 1; i >= 0; i--) {
    const ref = annots.get(i);
    const dict = annots.lookup(i);
    if (!(dict instanceof PDFDict)) continue;
    const oc = dict.get(PDFName.of("OC"));
    if (c.layers && oc && !c.visible(oc)) {
      annots.remove(i);
      const popup = dict.get(PDFName.of("Popup"));
      if (popup instanceof PDFRef) {
        for (let k = annots.size() - 1; k >= 0; k--) if (annots.get(k) === popup) annots.remove(k);
        i = Math.min(i, annots.size());
      }
      if (popup instanceof PDFRef) ctx.delete(popup);
      if (dict.lookup(PDFName.of("Subtype"))?.toString() === "/Widget" && ref instanceof PDFRef)
        detachWidget(c.doc, ref, dict);
      if (ref instanceof PDFRef) ctx.delete(ref);
      c.count.layers++;
      continue;
    }
    const ap = dict.lookup(PDFName.of("AP"));
    if (!(ap instanceof PDFDict)) continue;
    for (const k of ["N", "R", "D"]) {
      const raw = ap.get(PDFName.of(k));
      const v = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
      if (v instanceof PDFRawStream) await cleanStream(v, raw, undefined, c, 0);
      else if (v instanceof PDFDict) {
        // Appearance states (a check box's /On and /Off).
        for (const s of v.keys()) {
          const sr = v.get(s);
          const sv = sr instanceof PDFRef ? ctx.lookup(sr) : sr;
          if (sv instanceof PDFRawStream) await cleanStream(sv, sr, undefined, c, 0);
        }
      }
    }
  }
}

/**
 * A form, pattern or appearance stream cleaned in place (hidden information
 * goes from the whole document, wherever the stream is drawn). A stream
 * without resources of its own uses `inherited`.
 */
async function cleanStream(
  stream: PDFRawStream,
  ref: unknown,
  inherited: PDFDict | undefined,
  c: CleanContext,
  depth: number,
): Promise<void> {
  if (!(ref instanceof PDFRef) || depth > MAX_FORM_DEPTH) return;
  const key = `${ref.objectNumber} ${ref.generationNumber}`;
  if (c.done.has(key)) return;
  c.done.add(key);
  const ops = streamOps(stream);
  if (!ops) return;
  const own = stream.dict.lookup(PDFName.of("Resources"));
  const next = await cleanOps(ops, own instanceof PDFDict ? own : inherited, c, depth + 1);
  if (!next) return;
  const dict: Record<string, unknown> = {};
  for (const [k, v] of stream.dict.entries()) {
    const name = k.asString();
    if (name !== "/Length" && name !== "/Filter" && name !== "/DecodeParms") dict[name.slice(1)] = v;
  }
  c.doc.context.assign(ref, c.doc.context.flateStream(writeContentStream(next), dict as never));
}

/** Operators without invisible text, hidden layers' content or replacement text; null when unchanged. */
async function cleanOps(
  ops: readonly Op[],
  resources: PDFDict | undefined,
  c: CleanContext,
  depth: number,
): Promise<Op[] | null> {
  const ctx = c.doc.context;
  const properties = resources?.lookup(PDFName.of("Properties"));
  const xobjects = resources?.lookup(PDFName.of("XObject"));
  const drop = new Set<number>();
  const replace = new Map<number, Op[]>();

  if (c.opts.hiddenText) {
    // Real widths: the caret must move by what the removed text advanced.
    const measure = widthFnFor(await loadFontsFrom(resources));
    for (const show of walkText(ops, measure)) {
      if (show.state.renderMode !== 3) continue;
      replace.set(show.opIndex, [
        ...lineMoveOf(ops[show.opIndex]),
        shiftOnly(show.advance, show.state.size, show.state.hScale),
      ]);
      c.count.text++;
    }
  }
  if (c.layers) {
    const layerOf = (name: string) => (properties instanceof PDFDict ? properties.get(PDFName.of(name)) : undefined);
    const stack: { at: number; hidden: boolean }[] = [];
    ops.forEach((o, i) => {
      if (o.op === "BDC" || o.op === "BMC") {
        const tag = o.args[0];
        const prop = o.args[1];
        const oc =
          o.op === "BDC" && tag?.t === "name" && tag.v === "OC" && prop?.t === "name" ? layerOf(prop.v) : undefined;
        stack.push({ at: i, hidden: !!oc && !c.visible(oc) });
      } else if (o.op === "EMC") {
        const top = stack.pop();
        if (top?.hidden) {
          for (let k = top.at; k <= i; k++) drop.add(k);
          c.count.layers++;
        }
      } else if (o.op === "Do" && o.args[0]?.t === "name" && xobjects instanceof PDFDict) {
        const xo = xobjects.lookup(PDFName.of(o.args[0].v));
        const oc = xo instanceof PDFRawStream ? xo.dict.get(PDFName.of("OC")) : undefined;
        if (oc && !c.visible(oc)) {
          drop.add(i);
          c.count.layers++;
        }
      }
    });
  }
  if (c.opts.structure) {
    ops.forEach((o, i) => {
      const prop = o.op === "BDC" ? o.args[1] : undefined;
      if (prop?.t !== "dict") return;
      const kept = new Map([...prop.v].filter(([k]) => k !== "ActualText" && k !== "Alt" && k !== "E"));
      if (kept.size !== prop.v.size) {
        replace.set(i, [{ op: "BDC", args: [o.args[0], { t: "dict", v: kept }] }]);
        c.count.alt++;
      }
    });
  }
  // The forms it still draws, and its patterns: cleaned too.
  if (xobjects instanceof PDFDict) {
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      if (drop.has(i) || o.op !== "Do" || o.args[0]?.t !== "name") continue;
      const raw = xobjects.get(PDFName.of(o.args[0].v));
      const xo = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
      if (xo instanceof PDFRawStream && xo.dict.lookup(PDFName.of("Subtype"))?.toString() === "/Form")
        await cleanStream(xo, raw, resources, c, depth);
    }
  }
  const patterns = resources?.lookup(PDFName.of("Pattern"));
  if (patterns instanceof PDFDict) {
    for (const k of patterns.keys()) {
      const raw = patterns.get(k);
      const pat = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
      if (pat instanceof PDFRawStream) await cleanStream(pat, raw, undefined, c, depth);
    }
  }
  if (!drop.size && !replace.size) return null;
  return ops.flatMap((o, i) => (drop.has(i) ? [] : (replace.get(i) ?? [o])));
}

/** Everything (Acrobat's « Nettoyer le document »). */
export async function sanitiseDocument(doc: PDFDocument): Promise<{ removed: string[] }> {
  return removeHiddenInfo(doc, ALL_HIDDEN_INFO);
}
