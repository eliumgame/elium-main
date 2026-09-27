/**
 * Print imposition (Acrobat's « Taille et gestion des pages »): turns the
 * print-ready PDF the workspace builds into the sheets that go to the printer.
 *
 *  - page choice: all / current page / range (accepts page labels), odd or
 *    even pages only, reverse order;
 *  - « Taille »: one page per sheet — fit, shrink oversized pages, actual size
 *    or a custom scale, on the page's own paper or a standard one, with
 *    automatic orientation or rotation and centring;
 *  - « Multiple »: several pages per sheet (2, 4, 6, 9, 16 or rows × columns);
 *  - « Livret »: saddle-stitched booklet, pages reordered, blanks padded;
 *  - « Affiche »: one page tiled over several sheets, with overlap, cut marks
 *    and labels.
 *
 * Pure pdf-lib: source pages are embedded as Form XObjects (`embedPages`) and
 * placed with one `cm` each. The source's remaining printable annotations
 * (imported ones kept byte for byte, form widgets) are baked into their page
 * first, since an embedded page carries its content stream only.
 *
 * What goes into the source (document, markups, stamps, form fields) is the
 * caller's business — see `contentState` / `keepFormFieldsOnly` — and so is
 * « Imprimer comme image » (rasterised after imposition).
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  StandardFonts,
  clip,
  concatTransformationMatrix,
  drawObject,
  endPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setLineWidth,
  setStrokingGrayscaleColor,
  stroke,
} from "pdf-lib";
import type { PDFEmbeddedPage, PDFFont, PDFOperator, PDFPage } from "pdf-lib";
import type { AnnotKind, PdfState } from "../model/types";
import { PAGE_SIZES, parsePageRange } from "./organize";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type PrintPages = "all" | "current" | "range";
export type PageSubset = "all" | "odd" | "even";
/** "page": each sheet takes the size of the page printed on it. */
export type PrintPaper = "page" | "A4" | "A3" | "A5" | "Letter" | "Legal";
export type PrintOrientation = "auto" | "portrait" | "landscape";
export type PrintLayout = "size" | "multiple" | "booklet" | "poster";
export type SizeScaling = "fit" | "shrink" | "actual" | "custom";
export type NupOrder = "horizontal" | "horizontalReversed" | "vertical" | "verticalReversed";
export type NupPreset = 2 | 4 | 6 | 9 | 16 | "custom";
export type BookletSides = "both" | "front" | "back";
/**
 * Acrobat's « Commentaires et formulaires »:
 *  - document: the page content and form fields, no comments;
 *  - markups: the document and its comments (as shown);
 *  - stamps: the document and its stamps only;
 *  - forms: the form field values alone, on blank pages.
 */
export type ContentMode = "document" | "markups" | "stamps" | "forms";

export interface PrintOptions {
  pages: PrintPages;
  /** « 1-3, 5, 8- »; page labels are accepted when `labels` is given. */
  range: string;
  /** 0-based index of the current page (for `pages: "current"`). */
  currentPage: number;
  /** The document's page labels, by page (optional). */
  labels?: readonly string[];
  subset: PageSubset;
  reverse: boolean;
  paper: PrintPaper;
  orientation: PrintOrientation;
  layout: PrintLayout;
  size: {
    scaling: SizeScaling;
    /** Percentage, for `scaling: "custom"`. */
    scale: number;
    /** Fixed orientation only: turn a page by 90° when it fits the sheet better that way. */
    autoRotate: boolean;
    /** Centre the page on the sheet (otherwise: top-left corner). */
    center: boolean;
  };
  multiple: {
    perSheet: NupPreset;
    rows: number;
    cols: number;
    order: NupOrder;
    border: boolean;
    /** Sheet margin and gap between pages, in millimetres. */
    marginMm: number;
    autoRotate: boolean;
  };
  booklet: {
    sides: BookletSides;
    binding: "left" | "right";
    /** 1-based sheet range; `sheetTo` 0 = to the last sheet. */
    sheetFrom: number;
    sheetTo: number;
  };
  poster: {
    /** Percentage the page is enlarged to before tiling. */
    scale: number;
    overlapMm: number;
    cutMarks: boolean;
    labels: boolean;
    /** Pages that already fit the paper are printed normally, at 100 %. */
    largeOnly: boolean;
  };
  content: ContentMode;
  /** « Imprimer comme image »: the caller rasterises the imposed result. */
  asImage: boolean;
}

export const DEFAULT_PRINT_OPTIONS: PrintOptions = {
  pages: "all",
  range: "",
  currentPage: 0,
  subset: "all",
  reverse: false,
  paper: "page",
  orientation: "auto",
  layout: "size",
  size: { scaling: "fit", scale: 100, autoRotate: true, center: true },
  multiple: { perSheet: 2, rows: 2, cols: 2, order: "horizontal", border: false, marginMm: 0, autoRotate: true },
  booklet: { sides: "both", binding: "left", sheetFrom: 1, sheetTo: 0 },
  poster: { scale: 100, overlapMm: 10, cutMarks: true, labels: true, largeOnly: false },
  content: "markups",
  asImage: false,
};

export const PRINT_PAPERS: readonly PrintPaper[] = ["page", "A4", "A3", "A5", "Letter", "Legal"];

const MM = 72 / 25.4;
const EPS = 1e-6;
/** Room around a poster tile for its cut marks and label. */
const POSTER_MARGIN = 18;

// ---------------------------------------------------------------------------
// Page choice
// ---------------------------------------------------------------------------

/**
 * Resolve a page spec into 0-based indices, in the order written. With
 * `labels`, every page named in the spec (alone or as a range end) is first
 * looked up among the page labels (« iv », « A-2 »); a number that is no label
 * is the physical page of that number. So with labels i, ii, iii, 1, 2…,
 * « 1-3 » is labels 1 to 3, « ii-2 » runs from label ii to label 2, and « 9 »
 * (no such label) is the ninth page. Without labels: `parsePageRange`.
 */
export function resolvePageSpec(spec: string, total: number, labels?: readonly string[]): number[] {
  if (total <= 0) return [];
  const byLabel = new Map<string, number>();
  if (labels) {
    labels.slice(0, total).forEach((l, i) => {
      const k = l.trim().toLowerCase();
      if (k && !byLabel.has(k)) byLabel.set(k, i);
    });
  }
  if (!byLabel.size) return parsePageRange(spec, total);
  const text = spec.trim();
  if (!text || /^(all|tout|toutes|odd|even|impaires?|paires?)$/i.test(text)) return parsePageRange(text, total);
  const page = (t: string): number | undefined => {
    const k = t.trim().toLowerCase();
    const l = byLabel.get(k);
    if (l !== undefined) return l;
    if (/^\d+$/.test(k)) {
      const n = Number(k);
      if (n >= 1 && n <= total) return n - 1;
    }
    return undefined;
  };
  const out: number[] = [];
  for (const raw of text.split(/[,;]/)) {
    const tok = raw.trim();
    if (!tok) continue;
    const whole = page(tok);
    if (whole !== undefined) {
      out.push(whole);
      continue;
    }
    // A range: the first separator whose two sides both name a page (a label may hold a dash: « A-2 »).
    for (const m of tok.matchAll(/\s*(?:-|–|\bà\b)\s*/g)) {
      const a = tok.slice(0, m.index).trim();
      const b = tok.slice(m.index! + m[0].length).trim();
      if (!a && !b) continue;
      const ia = a ? page(a) : 0;
      const ib = b ? page(b) : total - 1;
      if (ia === undefined || ib === undefined) continue;
      const step = ia <= ib ? 1 : -1;
      for (let i = ia; step > 0 ? i <= ib : i >= ib; i += step) out.push(i);
      break;
    }
  }
  return out;
}

/** The pages to print, in print order (0-based). A booklet ignores the subset and the reverse order. */
export function selectPages(opts: PrintOptions, pageCount: number): number[] {
  if (pageCount <= 0) return [];
  let list: number[];
  if (opts.pages === "current") list = [Math.max(0, Math.min(pageCount - 1, opts.currentPage))];
  else if (opts.pages === "range") list = resolvePageSpec(opts.range, pageCount, opts.labels);
  else list = Array.from({ length: pageCount }, (_, i) => i);
  if (opts.layout === "booklet") return list;
  // Odd / even page *numbers*: page 1 is odd.
  if (opts.subset === "odd") list = list.filter((i) => i % 2 === 0);
  else if (opts.subset === "even") list = list.filter((i) => i % 2 === 1);
  if (opts.reverse) list = list.slice().reverse();
  return list;
}

// ---------------------------------------------------------------------------
// Layout arithmetic (shared by the imposition and the dialog's summary)
// ---------------------------------------------------------------------------

/** Rows × columns of a « Multiple » sheet, for a portrait or landscape sheet. */
export function nupGrid(m: PrintOptions["multiple"], landscape: boolean): { rows: number; cols: number } {
  if (m.perSheet === "custom") {
    return { rows: clampInt(m.rows, 1, 20), cols: clampInt(m.cols, 1, 20) };
  }
  const [long, short] = m.perSheet === 2 ? [2, 1] : m.perSheet === 6 ? [3, 2] : [Math.sqrt(m.perSheet), 0];
  const [a, b] = short ? [long, short] : [long, long];
  return landscape ? { rows: b, cols: a } : { rows: a, cols: b };
}

export function pagesPerSheet(m: PrintOptions["multiple"]): number {
  const g = nupGrid(m, false);
  return g.rows * g.cols;
}

/**
 * Saddle-stitch order: for each sheet, [front left, front right, back left,
 * back right] as 0-based positions in the page list (null: blank). 8 pages →
 * sheet 1: 8,1 / 2,7 — sheet 2: 6,3 / 4,5 (1-based).
 */
export function bookletOrder(count: number, binding: "left" | "right" = "left"): (number | null)[][] {
  const n = Math.max(4, Math.ceil(count / 4) * 4);
  const at = (i: number) => (i < count ? i : null);
  const sheets: (number | null)[][] = [];
  for (let s = 0; s < n / 4; s++) {
    const frontL = at(n - 1 - 2 * s);
    const frontR = at(2 * s);
    const backL = at(2 * s + 1);
    const backR = at(n - 2 - 2 * s);
    sheets.push(binding === "left" ? [frontL, frontR, backL, backR] : [frontR, frontL, backR, backL]);
  }
  return sheets;
}

/** The sheets of a booklet that get printed (0-based, inclusive range). */
function bookletSheetRange(b: PrintOptions["booklet"], total: number): [number, number] {
  const from = clampInt(b.sheetFrom || 1, 1, total) - 1;
  const to = b.sheetTo > 0 ? clampInt(b.sheetTo, from + 1, total) - 1 : total - 1;
  return [from, to];
}

function portraitPaper(paper: Exclude<PrintPaper, "page">): [number, number] {
  const [w, h] = PAGE_SIZES[paper];
  return [Math.min(w, h), Math.max(w, h)];
}

/** Paper for a page of this (displayed) size, before orientation. */
function paperFor(opts: PrintOptions, w: number, h: number): [number, number] {
  return opts.paper === "page" ? [w, h] : portraitPaper(opts.paper);
}

function orient([w, h]: [number, number], landscape: boolean): [number, number] {
  return landscape ? [Math.max(w, h), Math.min(w, h)] : [Math.min(w, h), Math.max(w, h)];
}

interface PosterGrid {
  /** Printed on one sheet at 100 % (« tile only large pages »). */
  single: boolean;
  cols: number;
  rows: number;
  paper: [number, number];
}

/** How a page of this displayed size is tiled. */
export function posterGrid(opts: PrintOptions, w: number, h: number): PosterGrid {
  const p = opts.poster;
  const base = paperFor(opts, w, h);
  const s = Math.max(1, p.scale) / 100;
  const margin = p.cutMarks || p.labels ? POSTER_MARGIN : 0;
  const count = (paper: [number, number]) => {
    const aw = paper[0] - 2 * margin;
    const ah = paper[1] - 2 * margin;
    const ov = Math.min(Math.max(0, p.overlapMm) * MM, aw / 2, ah / 2);
    const n = (len: number, area: number) => Math.max(1, Math.ceil((len - ov) / (area - ov) - EPS));
    return { cols: n(w * s, aw), rows: n(h * s, ah) };
  };
  const candidates: [number, number][] =
    opts.orientation === "auto"
      ? [orient(base, false), orient(base, true)]
      : [orient(base, opts.orientation === "landscape")];
  let best: PosterGrid | null = null;
  for (const paper of candidates) {
    const fits = w <= paper[0] + EPS && h <= paper[1] + EPS;
    if (p.largeOnly && fits) return { single: true, cols: 1, rows: 1, paper };
    const g = count(paper);
    if (!best || g.cols * g.rows < best.cols * best.rows) best = { single: false, ...g, paper };
  }
  return best!;
}

export interface SheetSummary {
  /** Pages selected for printing. */
  pages: number;
  /** Sheet sides in the output (pages of the imposed PDF). */
  sheets: number;
  /** Physical sheets of paper (a two-sided booklet sheet counts once). */
  paperSheets: number;
}

/**
 * The dialog's « N feuilles » summary. `sizes` (displayed page sizes, in
 * points) is only needed for posters; without it every page is taken as A4.
 */
export function describeSheets(
  opts: PrintOptions,
  pageCount: number,
  sizes?: readonly (readonly [number, number])[],
): SheetSummary {
  const pages = selectPages(opts, pageCount);
  const n = pages.length;
  if (!n) return { pages: 0, sheets: 0, paperSheets: 0 };
  switch (opts.layout) {
    case "multiple": {
      const sheets = Math.ceil(n / pagesPerSheet(opts.multiple));
      return { pages: n, sheets, paperSheets: sheets };
    }
    case "booklet": {
      const total = Math.max(1, Math.ceil(n / 4));
      const [from, to] = bookletSheetRange(opts.booklet, total);
      const count = to - from + 1;
      const both = opts.booklet.sides === "both";
      return { pages: n, sheets: both ? count * 2 : count, paperSheets: count };
    }
    case "poster": {
      let sheets = 0;
      for (const i of pages) {
        const [w, h] = sizes?.[i] ?? PAGE_SIZES.A4;
        const g = posterGrid(opts, w, h);
        sheets += g.cols * g.rows;
      }
      return { pages: n, sheets, paperSheets: sheets };
    }
    default:
      return { pages: n, sheets: n, paperSheets: n };
  }
}

// ---------------------------------------------------------------------------
// Imposition
// ---------------------------------------------------------------------------

interface Source {
  page: PDFPage;
  /** Displayed size (after /Rotate). */
  w: number;
  h: number;
  /** Unrotated crop box size. */
  bw: number;
  bh: number;
  rotate: number;
  embedded?: PDFEmbeddedPage;
}

type Matrix = [number, number, number, number, number, number];

/**
 * Matrix placing an embedded page (form space 0..bw × 0..bh) turned by
 * `rot` degrees clockwise and scaled by `s`, its displayed lower-left corner
 * at (x, y).
 */
function placement(src: Source, rot: number, s: number, x: number, y: number): Matrix {
  const { bw, bh } = src;
  let m: Matrix;
  switch (((rot % 360) + 360) % 360) {
    case 90:
      m = [0, -1, 1, 0, 0, bw];
      break;
    case 180:
      m = [-1, 0, 0, -1, bw, bh];
      break;
    case 270:
      m = [0, 1, -1, 0, bh, 0];
      break;
    default:
      m = [1, 0, 0, 1, 0, 0];
  }
  return [m[0] * s, m[1] * s, m[2] * s, m[3] * s, m[4] * s + x, m[5] * s + y];
}

/** Scale at which a w × h box fits a W × H one. */
function fitScale(w: number, h: number, W: number, H: number): number {
  return Math.min(W / w, H / h);
}

/** An extra quarter turn (counter-clockwise, as Acrobat) when it fits the box better. */
function bestTurn(src: Source, W: number, H: number, allowed: boolean): { turn: number; w: number; h: number } {
  const straight = fitScale(src.w, src.h, W, H);
  const turned = fitScale(src.h, src.w, W, H);
  if (allowed && turned > straight + EPS) return { turn: 270, w: src.h, h: src.w };
  return { turn: 0, w: src.w, h: src.h };
}

class Sheets {
  private font: PDFFont | null = null;
  constructor(readonly out: PDFDocument) {}

  add(w: number, h: number): PDFPage {
    return this.out.addPage([w, h]);
  }

  place(sheet: PDFPage, src: Source, turn: number, s: number, x: number, y: number, clipTo?: number[]): void {
    if (!src.embedded) return;
    const name = sheet.node.newXObject("Pg", src.embedded.ref);
    const ops: PDFOperator[] = [pushGraphicsState()];
    if (clipTo) ops.push(rectangle(clipTo[0], clipTo[1], clipTo[2], clipTo[3]), clip(), endPath());
    ops.push(concatTransformationMatrix(...placement(src, src.rotate + turn, s, x, y)), drawObject(name));
    ops.push(popGraphicsState());
    sheet.pushOperators(...ops);
  }

  frame(sheet: PDFPage, x: number, y: number, w: number, h: number): void {
    sheet.pushOperators(
      pushGraphicsState(),
      setLineWidth(0.5),
      setStrokingGrayscaleColor(0),
      rectangle(x, y, w, h),
      stroke(),
      popGraphicsState(),
    );
  }

  lines(sheet: PDFPage, segments: number[][]): void {
    const ops: PDFOperator[] = [pushGraphicsState(), setLineWidth(0.3), setStrokingGrayscaleColor(0)];
    for (const [x1, y1, x2, y2] of segments) ops.push(moveTo(x1, y1), lineTo(x2, y2));
    ops.push(stroke(), popGraphicsState());
    sheet.pushOperators(...ops);
  }

  async text(sheet: PDFPage, text: string, x: number, y: number, size: number): Promise<void> {
    this.font ??= await this.out.embedFont(StandardFonts.Helvetica);
    sheet.drawText(text, { x, y, size, font: this.font, color: rgb(0.2, 0.2, 0.2) });
  }
}

/**
 * Impose the print-ready PDF according to the print options. Returns the
 * input untouched when the options change nothing (every page, on its own
 * paper, at 100 %).
 */
export async function imposeForPrint(bytes: Uint8Array, opts: PrintOptions): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const total = src.getPageCount();
  const picked = selectPages(opts, total);
  if (!picked.length) throw new Error("Aucune page à imprimer.");
  const identity =
    opts.layout === "size" &&
    opts.paper === "page" &&
    opts.orientation === "auto" &&
    (opts.size.scaling !== "custom" || opts.size.scale === 100) &&
    picked.length === total &&
    picked.every((p, i) => p === i);
  if (identity) return bytes;

  bakeAnnotations(src);
  const pages = src.getPages();
  const sources = new Map<number, Source>();
  for (const i of new Set(picked)) {
    const page = pages[i];
    if (!page.node.Contents()) page.node.set(PDFName.of("Contents"), src.context.obj([]));
    const box = page.getCropBox();
    const rotate = (((Math.round(page.getRotation().angle / 90) * 90) % 360) + 360) % 360;
    const turned = rotate === 90 || rotate === 270;
    sources.set(i, {
      page,
      bw: box.width,
      bh: box.height,
      w: turned ? box.height : box.width,
      h: turned ? box.width : box.height,
      rotate,
    });
  }

  const out = await PDFDocument.create({ updateMetadata: false });
  const title = src.getTitle();
  if (title) out.setTitle(title);
  const order = [...sources.keys()];
  const embedded = await out.embedPages(
    order.map((i) => sources.get(i)!.page),
    order.map((i) => {
      const b = sources.get(i)!.page.getCropBox();
      return { left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height };
    }),
  );
  order.forEach((i, k) => (sources.get(i)!.embedded = embedded[k]));

  const sheets = new Sheets(out);
  const list = picked.map((i) => sources.get(i)!);
  switch (opts.layout) {
    case "multiple":
      imposeMultiple(sheets, list, opts);
      break;
    case "booklet":
      imposeBooklet(sheets, list, opts);
      break;
    case "poster":
      await imposePoster(sheets, list, picked, opts);
      break;
    default:
      imposeSize(sheets, list, opts);
  }
  return out.save({ useObjectStreams: false });
}

function imposeSize(sheets: Sheets, list: Source[], opts: PrintOptions): void {
  const o = opts.size;
  for (const src of list) {
    const base = paperFor(opts, src.w, src.h);
    const fixed = opts.orientation !== "auto";
    const [W, H] = fixed ? orient(base, opts.orientation === "landscape") : orient(base, src.w > src.h);
    const { turn, w, h } = fixed ? bestTurn(src, W, H, o.autoRotate) : { turn: 0, w: src.w, h: src.h };
    const fit = fitScale(w, h, W, H);
    const s =
      o.scaling === "fit"
        ? fit
        : o.scaling === "shrink"
          ? Math.min(1, fit)
          : o.scaling === "custom"
            ? Math.max(1, o.scale) / 100
            : 1;
    const x = o.center ? (W - w * s) / 2 : 0;
    const y = o.center ? (H - h * s) / 2 : H - h * s;
    sheets.place(sheets.add(W, H), src, turn, s, x, y, [0, 0, W, H]);
  }
}

function imposeMultiple(sheets: Sheets, list: Source[], opts: PrintOptions): void {
  const m = opts.multiple;
  const first = list[0];
  const base = paperFor(opts, first.w, first.h);
  const margin = Math.max(0, m.marginMm) * MM;
  const gap = margin;
  const layoutFor = (landscape: boolean) => {
    const [W, H] = orient(base, landscape);
    const { rows, cols } = nupGrid(m, landscape);
    const cw = Math.max(1, (W - 2 * margin - (cols - 1) * gap) / cols);
    const ch = Math.max(1, (H - 2 * margin - (rows - 1) * gap) / rows);
    const t = bestTurn(first, cw, ch, m.autoRotate);
    // Pages kept upright win a tie (A4 2-up: landscape sheet rather than turned pages).
    return { W, H, rows, cols, cw, ch, score: fitScale(t.w, t.h, cw, ch) * (t.turn ? 0.999 : 1) };
  };
  const L =
    opts.orientation === "auto"
      ? [layoutFor(false), layoutFor(true)].sort((a, b) => b.score - a.score)[0]
      : layoutFor(opts.orientation === "landscape");
  const per = L.rows * L.cols;
  for (let start = 0; start < list.length; start += per) {
    const sheet = sheets.add(L.W, L.H);
    list.slice(start, start + per).forEach((src, k) => {
      const [r, c] = cellOf(k, L.rows, L.cols, m.order);
      const cx = margin + c * (L.cw + gap);
      const cy = L.H - margin - (r + 1) * L.ch - r * gap;
      const { turn, w, h } = bestTurn(src, L.cw, L.ch, m.autoRotate);
      const s = fitScale(w, h, L.cw, L.ch);
      const x = cx + (L.cw - w * s) / 2;
      const y = cy + (L.ch - h * s) / 2;
      sheets.place(sheet, src, turn, s, x, y, [cx, cy, L.cw, L.ch]);
      if (m.border) sheets.frame(sheet, x, y, w * s, h * s);
    });
  }
}

/** [row, column] of the k-th page on an n-up sheet (row 0 at the top). */
export function cellOf(k: number, rows: number, cols: number, order: NupOrder): [number, number] {
  switch (order) {
    case "horizontalReversed":
      return [Math.floor(k / cols), cols - 1 - (k % cols)];
    case "vertical":
      return [k % rows, Math.floor(k / rows)];
    case "verticalReversed":
      return [k % rows, cols - 1 - Math.floor(k / rows)];
    default:
      return [Math.floor(k / cols), k % cols];
  }
}

function imposeBooklet(sheets: Sheets, list: Source[], opts: PrintOptions): void {
  const b = opts.booklet;
  const first = list[0];
  // Side by side on a landscape sheet: on the page's own paper, two pages wide.
  const [W, H] = opts.paper === "page" ? [first.w * 2, first.h] : orient(portraitPaper(opts.paper), true);
  const order = bookletOrder(list.length, b.binding);
  const [from, to] = bookletSheetRange(b, order.length);
  const half = W / 2;
  const side = (pair: (number | null)[]) => {
    const sheet = sheets.add(W, H);
    pair.forEach((at, k) => {
      if (at === null) return;
      const src = list[at];
      const s = fitScale(src.w, src.h, half, H);
      const x = k * half + (half - src.w * s) / 2;
      const y = (H - src.h * s) / 2;
      sheets.place(sheet, src, 0, s, x, y, [k * half, 0, half, H]);
    });
  };
  for (let i = from; i <= to; i++) {
    const [fl, fr, bl, br] = order[i];
    if (b.sides !== "back") side([fl, fr]);
    if (b.sides !== "front") side([bl, br]);
  }
}

/** « A », « B »… « Z », « AA »: the column of a poster tile. */
export function tileColumnName(c: number): string {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function imposePoster(sheets: Sheets, list: Source[], picked: number[], opts: PrintOptions): Promise<void> {
  const p = opts.poster;
  const s = Math.max(1, p.scale) / 100;
  for (const [k, src] of list.entries()) {
    const g = posterGrid(opts, src.w, src.h);
    const [W, H] = g.paper;
    if (g.single) {
      sheets.place(sheets.add(W, H), src, 0, 1, (W - src.w) / 2, (H - src.h) / 2, [0, 0, W, H]);
      continue;
    }
    const margin = p.cutMarks || p.labels ? POSTER_MARGIN : 0;
    const aw = W - 2 * margin;
    const ah = H - 2 * margin;
    const ov = Math.min(Math.max(0, p.overlapMm) * MM, aw / 2, ah / 2);
    const pw = src.w * s;
    const ph = src.h * s;
    const label = opts.labels?.[picked[k]] || String(picked[k] + 1);
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const sheet = sheets.add(W, H);
        // The tile shows the poster from (c·step, r·step), counted from its top-left corner.
        const x = margin - c * (aw - ov);
        const top = H - margin + r * (ah - ov);
        sheets.place(sheet, src, 0, s, x, top - ph, [margin, margin, aw, ah]);
        // A last tile only partly covered: marks stop where the poster does.
        const usedW = Math.min(aw, pw - c * (aw - ov));
        const usedH = Math.min(ah, ph - r * (ah - ov));
        if (p.cutMarks) {
          const x0 = margin;
          const x1 = margin + usedW;
          const y1 = H - margin;
          const y0 = H - margin - usedH;
          const l = margin * 0.7;
          sheets.lines(sheet, [
            [x0 - l, y0, x0 - 2, y0],
            [x0, y0 - l, x0, y0 - 2],
            [x1 + 2, y0, x1 + l, y0],
            [x1, y0 - l, x1, y0 - 2],
            [x0 - l, y1, x0 - 2, y1],
            [x0, y1 + 2, x0, y1 + l],
            [x1 + 2, y1, x1 + l, y1],
            [x1, y1 + 2, x1, y1 + l],
          ]);
        }
        if (p.labels) {
          const name = `${tileColumnName(c)}${r + 1}`;
          await sheets.text(
            sheet,
            `${name} — page ${label} (ligne ${r + 1}, colonne ${c + 1} ; ${g.rows} × ${g.cols})`,
            margin,
            margin / 2 - 2,
            7,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Annotation baking
// ---------------------------------------------------------------------------

const num = (v: unknown): number => (v instanceof PDFNumber ? v.asNumber() : 0);

function numbers(arr: unknown, n: number): number[] | null {
  if (!(arr instanceof PDFArray) || arr.size() < n) return null;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(num(arr.lookup(i)));
  return out;
}

/**
 * Draw every printable annotation's normal appearance into its page's
 * content (and drop the annotations): an embedded page keeps its content
 * stream only. Hidden or non-printing annotations and pop-ups are left out.
 */
export function bakeAnnotations(doc: PDFDocument, keep: (subtype: string) => boolean = () => true): void {
  const ctx = doc.context;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray) || !annots.size()) continue;
    const ops: string[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i);
      if (!(a instanceof PDFDict)) continue;
      const subtype = a.lookup(PDFName.of("Subtype"));
      const sub = subtype instanceof PDFName ? subtype.asString().slice(1) : "";
      if (sub === "Popup" || !keep(sub)) continue;
      const flags = num(a.lookup(PDFName.of("F")));
      if (flags & 2 || !(flags & 4)) continue;
      const ap = a.lookup(PDFName.of("AP"));
      if (!(ap instanceof PDFDict)) continue;
      let holder: PDFDict = ap;
      let key = PDFName.of("N");
      let n = ap.lookup(key);
      if (n instanceof PDFDict && !(n instanceof PDFStream)) {
        const as = a.lookup(PDFName.of("AS"));
        if (!(as instanceof PDFName)) continue;
        holder = n;
        key = as;
        n = n.lookup(as);
      }
      if (!(n instanceof PDFStream)) continue;
      const held = holder.get(key);
      const ref = held instanceof PDFRef ? held : ctx.register(n);
      if (ref !== held) holder.set(key, ref);
      if (!n.dict.get(PDFName.of("Subtype"))) n.dict.set(PDFName.of("Subtype"), PDFName.of("Form"));
      const rect = numbers(a.lookup(PDFName.of("Rect")), 4);
      const bbox = numbers(n.dict.lookup(PDFName.of("BBox")), 4);
      if (!rect || !bbox) continue;
      const mx = numbers(n.dict.lookup(PDFName.of("Matrix")), 6) ?? [1, 0, 0, 1, 0, 0];
      // PDF 32000 §12.5.5: the transformed BBox is mapped onto the Rect.
      const pts = [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[1]],
        [bbox[0], bbox[3]],
        [bbox[2], bbox[3]],
      ].map(([x, y]) => [mx[0] * x + mx[2] * y + mx[4], mx[1] * x + mx[3] * y + mx[5]]);
      const bx0 = Math.min(...pts.map((p) => p[0]));
      const bx1 = Math.max(...pts.map((p) => p[0]));
      const by0 = Math.min(...pts.map((p) => p[1]));
      const by1 = Math.max(...pts.map((p) => p[1]));
      const rx0 = Math.min(rect[0], rect[2]);
      const ry0 = Math.min(rect[1], rect[3]);
      const rw = Math.abs(rect[2] - rect[0]);
      const rh = Math.abs(rect[3] - rect[1]);
      if (bx1 - bx0 < EPS || by1 - by0 < EPS || rw < EPS || rh < EPS) continue;
      const sx = rw / (bx1 - bx0);
      const sy = rh / (by1 - by0);
      const name = page.node.newXObject("Ap", ref);
      ops.push(`q ${fmt([sx, 0, 0, sy, rx0 - bx0 * sx, ry0 - by0 * sy])} cm ${name.asString()} Do Q`);
    }
    // normalizedEntries() (via newXObject) already wrapped the page content in q … Q.
    if (ops.length) {
      const { Contents } = page.node.normalizedEntries();
      const stream = ctx.register(ctx.flateStream(ops.join("\n")));
      if (Contents) Contents.push(stream);
      else page.node.set(PDFName.of("Contents"), ctx.obj([stream]));
    }
    page.node.delete(PDFName.of("Annots"));
  }
}

function fmt(values: number[]): string {
  return values.map((v) => String(Math.round(v * 1e5) / 1e5)).join(" ");
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : lo)));
}

// ---------------------------------------------------------------------------
// Content modes (« Commentaires et formulaires »)
// ---------------------------------------------------------------------------

/** Annotations that are page content rather than comments: they print with « Document ». */
const DOCUMENT_KINDS: readonly AnnotKind[] = ["image", "signature", "whiteout", "redact"];

/**
 * The state to build the print source from, for a content mode. « forms »
 * drops the page marks too: the caller then builds with
 * `flattenForms: false` and passes the result through `keepFormFieldsOnly`.
 */
export function contentState(state: PdfState, mode: ContentMode): PdfState {
  if (mode === "markups") return state;
  if (mode === "forms") {
    return {
      ...state,
      annots: [],
      watermark: { ...state.watermark, enabled: false },
      header: { ...state.header, enabled: false },
      footer: { ...state.footer, enabled: false },
      bates: { ...state.bates, enabled: false },
    };
  }
  const kinds: readonly AnnotKind[] = mode === "stamps" ? [...DOCUMENT_KINDS, "stamp"] : DOCUMENT_KINDS;
  return { ...state, annots: state.annots.filter((a) => kinds.includes(a.kind)) };
}

/**
 * « Champs de formulaire uniquement »: blank every page and keep the form
 * fields' appearances alone, drawn into the page. Input: a print build made
 * with `flattenForms: false` (widgets still annotations).
 */
export async function keepFormFieldsOnly(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  for (const page of doc.getPages()) page.node.set(PDFName.of("Contents"), doc.context.obj([]));
  bakeAnnotations(doc, (sub) => sub === "Widget");
  // The fields are now page content: no AcroForm left for the viewer to redraw over it.
  doc.catalog.delete(PDFName.of("AcroForm"));
  return doc.save({ useObjectStreams: false });
}
