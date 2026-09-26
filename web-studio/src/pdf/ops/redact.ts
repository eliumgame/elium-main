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
import type { PDFDocument, PDFPage } from "pdf-lib";
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
  /** Paths (line art, text drawn as outlines) removed from under the areas. */
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
 * (also inside form XObjects, which are copied first — another page may draw
 * the same form), the covered pixels of pictures, line art under the areas,
 * and the annotations and form fields there. The caller paints the boxes.
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
    let resources = page.node.Resources();
    if (!(resources instanceof PDFDict)) {
      resources = doc.context.obj({}) as PDFDict;
      page.node.set(PDFName.of("Resources"), resources);
    }
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

/** The operators with what lies in `rects` removed; null when nothing was. */
async function redactOps(ops: readonly Op[], scope: Scope, rects: readonly Rect[], start: Mat): Promise<Op[] | null> {
  const { fonts, result } = scope;
  const replacements = new Map<number, Op | null>();

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

  // --- line art: a path mostly under an area goes (text drawn as outlines,
  // a shape carrying meaning); a large one crossing it stays, hidden by the box.
  for (const path of walkPaths(ops, start)) {
    const box = { x: path.box.x0, y: path.box.y0, w: path.box.x1 - path.box.x0, h: path.box.y1 - path.box.y0 };
    const area = Math.max(box.w, 0.01) * Math.max(box.h, 0.01);
    const covered = rects.reduce(
      (sum, r) => sum + overlaps({ ...box, w: Math.max(box.w, 0.01), h: Math.max(box.h, 0.01) }, r) * area,
      0,
    );
    if (covered / area < 0.5) continue;
    for (let i = path.from; i <= path.to; i++) if (PATH_OPS.has(ops[i].op)) replacements.set(i, null);
    result.pathsRemoved++;
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
    const edited = await redactImage(scope.doc, xo, place.ctm, rects);
    if (edited) {
      const name = addXObject(scope, edited);
      replacements.set(place.opIndex, { op: "Do", args: [{ t: "name", v: name }] });
      result.imagesEdited++;
    } else {
      replacements.set(place.opIndex, null);
      result.imagesRemoved++;
      const note =
        "Une image n'a pas pu être modifiée pixel par pixel (format non pris en charge) : elle est retirée entière.";
      if (!result.warnings.includes(note)) result.warnings.push(note);
    }
  }

  if (!replacements.size) return null;
  const next: Op[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (!replacements.has(i)) {
      next.push(ops[i]);
      continue;
    }
    const rep = replacements.get(i);
    if (rep) next.push(rep);
  }
  return next;
}

const PATH_OPS = new Set(["m", "l", "c", "v", "y", "h", "re", "S", "s", "f", "F", "f*", "B", "B*", "b", "b*"]);

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

/** Name `ref` in the scope's /XObject resources (a fresh name; the dictionary copied, never shared). */
function addXObject(scope: Scope, ref: PDFRef): string {
  const ctx = scope.doc.context;
  const current = scope.resources.lookup(PDFName.of("XObject"));
  const dict = current instanceof PDFDict ? current.clone(ctx) : (ctx.obj({}) as PDFDict);
  let n = 1;
  while (dict.get(PDFName.of(`Rd${n}`))) n++;
  dict.set(PDFName.of(`Rd${n}`), ref);
  scope.resources.set(PDFName.of("XObject"), dict);
  return `Rd${n}`;
}

/** XObject names the new operators no longer draw: out of the resources (their objects can then go). */
function dropUnusedXObjects(doc: PDFDocument, resources: PDFDict, ops: readonly Op[]): void {
  const current = resources.lookup(PDFName.of("XObject"));
  if (!(current instanceof PDFDict)) return;
  const used = new Set(
    ops.filter((o) => o.op === "Do" && o.args[0]?.t === "name").map((o) => (o.args[0] as { v: string }).v),
  );
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
  const key = ref instanceof PDFRef ? `${ref.objectNumber} ${ref.generationNumber}` : "";
  if (scope.depth >= MAX_FORM_DEPTH || (key && scope.seen.has(key))) return null;
  const ctx = scope.doc.context;
  const mArr = xo.dict.lookup(PDFName.of("Matrix"));
  const num = (a: PDFArray, i: number) => {
    const v = a.lookup(i);
    return v instanceof PDFNumber ? v.asNumber() : 0;
  };
  const matrix: Mat =
    mArr instanceof PDFArray && mArr.size() === 6 ? ([0, 1, 2, 3, 4, 5].map((i) => num(mArr, i)) as Mat) : IDENTITY;
  const inner = mul(matrix, ctm);
  // Its box on the page: nothing to do when no area reaches it.
  const bb = xo.dict.lookup(PDFName.of("BBox"));
  if (bb instanceof PDFArray && bb.size() === 4) {
    const [x0, y0, x1, y1] = [0, 1, 2, 3].map((i) => num(bb, i));
    const box = boundsOf([apply(inner, x0, y0), apply(inner, x1, y0), apply(inner, x1, y1), apply(inner, x0, y1)]);
    if (!rects.some((r) => intersects(box, r))) return null;
  }
  let content: Uint8Array;
  try {
    content = decodePDFRawStream(xo).decode();
  } catch {
    return null;
  }
  const ownRes = xo.dict.lookup(PDFName.of("Resources"));
  const baseRes = ownRes instanceof PDFDict ? ownRes : scope.resources;
  const resources = baseRes.clone(ctx);
  const sub: Scope = {
    ...scope,
    resources,
    fonts: await loadFontsFrom(resources),
    depth: scope.depth + 1,
    seen: new Set([...scope.seen, key]),
  };
  const ops = parseContentStream(content);
  const next = await redactOps(ops, sub, rects, inner);
  if (!next) return null;
  dropUnusedXObjects(scope.doc, resources, next);
  const dict: Record<string, unknown> = {};
  for (const [k, v] of xo.dict.entries()) {
    const name = k.asString();
    if (name !== "/Length" && name !== "/Filter" && name !== "/DecodeParms") dict[name.slice(1)] = v;
  }
  dict.Resources = resources;
  const copy = ctx.register(ctx.flateStream(writeContentStream(next), dict as never));
  return addXObject(scope, copy);
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
function unPng(data: Uint8Array, rowBytes: number, bpp: number, rows: number): Uint8Array {
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
 * Remove the hidden information chosen in `opts` — what may still carry text
 * a redaction removed, or what a document should not take with it. Returns
 * what was actually found and removed (never a category that had nothing).
 */
export function removeHiddenInfo(doc: PDFDocument, opts: HiddenInfoOptions): { removed: string[] } {
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
      }
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
    if (opts.hiddenLayers && props instanceof PDFDict) {
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
    for (const page of doc.getPages()) {
      const n = cleanPageContent(doc, page, opts, off);
      if (n.text) removed.add("texte invisible");
      if (n.layers) removed.add("contenu des calques masqués");
      if (n.alt) removed.add("textes de remplacement");
    }
    if (opts.hiddenLayers && props instanceof PDFDict) {
      cat.delete(PDFName.of("OCProperties"));
      removed.add("calques (fusionnés)");
    }
  }
  return { removed: [...removed] };
}

/**
 * One page's content without invisible text, hidden layers' content, or the
 * replacement text of its marked content. Returns what it removed.
 */
function cleanPageContent(
  doc: PDFDocument,
  page: PDFPage,
  opts: HiddenInfoOptions,
  offLayers: ReadonlySet<string>,
): { text: number; layers: number; alt: number } {
  const count = { text: 0, layers: 0, alt: 0 };
  const bytes = readPageContentBytes(page);
  if (!bytes.length) return count;
  const ops = parseContentStream(bytes);
  const resources = page.node.Resources();
  const properties = resources instanceof PDFDict ? resources.lookup(PDFName.of("Properties")) : undefined;
  const xobjects = resources instanceof PDFDict ? resources.lookup(PDFName.of("XObject")) : undefined;
  const drop = new Set<number>();
  const replace = new Map<number, Op>();

  if (opts.hiddenText) {
    for (const show of walkText(ops)) {
      if (show.state.renderMode !== 3) continue;
      // Keep the caret where the text left it.
      replace.set(show.opIndex, shiftOnly(show.advance, show.state.size, show.state.hScale));
      count.text++;
    }
  }
  if (offLayers.size) {
    const layerOf = (name: string) => {
      const p = properties instanceof PDFDict ? properties.get(PDFName.of(name)) : undefined;
      return p ? String(p) : "";
    };
    const stack: { at: number; hidden: boolean }[] = [];
    ops.forEach((o, i) => {
      if (o.op === "BDC" || o.op === "BMC") {
        const tag = o.args[0];
        const prop = o.args[1];
        const hidden =
          o.op === "BDC" && tag?.t === "name" && tag.v === "OC" && prop?.t === "name" && offLayers.has(layerOf(prop.v));
        stack.push({ at: i, hidden });
      } else if (o.op === "EMC") {
        const top = stack.pop();
        if (top?.hidden) {
          for (let k = top.at; k <= i; k++) drop.add(k);
          count.layers++;
        }
      } else if (o.op === "Do" && o.args[0]?.t === "name" && xobjects instanceof PDFDict) {
        const xo = xobjects.lookup(PDFName.of(o.args[0].v));
        const oc = xo instanceof PDFRawStream ? xo.dict.get(PDFName.of("OC")) : undefined;
        if (oc && offLayers.has(String(oc))) {
          drop.add(i);
          count.layers++;
        }
      }
    });
  }
  if (opts.structure) {
    ops.forEach((o, i) => {
      const prop = o.op === "BDC" ? o.args[1] : undefined;
      if (prop?.t !== "dict") return;
      const kept = new Map([...prop.v].filter(([k]) => k !== "ActualText" && k !== "Alt" && k !== "E"));
      if (kept.size !== prop.v.size) {
        replace.set(i, { op: "BDC", args: [o.args[0], { t: "dict", v: kept }] });
        count.alt++;
      }
    });
  }
  if (!drop.size && !replace.size) return count;
  writePageContent(
    doc,
    page,
    ops.flatMap((o, i) => (drop.has(i) ? [] : [replace.get(i) ?? o])),
  );
  return count;
}

/** Everything (Acrobat's « Nettoyer le document »). */
export function sanitiseDocument(doc: PDFDocument): { removed: string[] } {
  return removeHiddenInfo(doc, ALL_HIDDEN_INFO);
}
