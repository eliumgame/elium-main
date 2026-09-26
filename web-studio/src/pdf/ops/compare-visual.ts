/**
 * Comparing two PDFs as pictures — the part of « Comparer des fichiers » that
 * text cannot see: a replaced logo, a moved stamp, a redrawn chart, a scan.
 *
 * Both pages of a pair are rasterised at ~100 dpi in page space (rotation 0),
 * compared pixel by pixel with a tolerance (and a one-pixel neighbourhood, so
 * the anti-aliasing of an edge shifted by a sub-pixel is not a change), the
 * changed pixels are gathered on a coarse grid and the connected blocks of
 * changed cells become rectangles. Text lines are kept out of it (text is
 * compared as text, with its formatting) and a rectangle touching a text
 * change is already explained by it; what is left is « image / dessin
 * modifié ». A page without text (a scan) is compared this way only.
 *
 * The rasteriser is injected, so tests hand in synthetic bitmaps; the browser
 * one (`canvasRasteriser`) draws through pdf.js into a detached canvas —
 * no network, CSP-safe.
 */

import type { Rect, Size } from "../core/coords";
import type { PdfEngine, TextContentLike } from "../core/engine";
import { pdfjs } from "../core/pdfjs";
import { compareLayouts, type DetailedPage, type DetailedReport, type DiffItem } from "./compare";
import { extractLayout } from "./export";

/** An RGBA picture of a page, rows top to bottom (ImageData's layout). */
export interface Bitmap {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Draws page `pageIndex` (0-based) of `engine` at `scale` (1 = 72 dpi), unrotated, on white. */
export type PageRasteriser = (engine: PdfEngine, pageIndex: number, scale: number) => Promise<Bitmap>;

export interface BitmapDiffOptions {
  /** Largest per-channel difference (0..255) still counted as equal. */
  tolerance?: number;
  /** Grid cell, in pixels, on which changed pixels are gathered. */
  cell?: number;
  /** Changed pixels a cell needs to count (isolated specks are noise). */
  minCellPixels?: number;
  /** Changed pixels a region needs to be reported. */
  minRegionPixels?: number;
  /** Empty cells bridged between two changed blocks (1 = a one-cell gap still joins them). */
  join?: number;
  /** Pixel rectangles left out of the comparison (text lines). */
  mask?: readonly Rect[];
}

const DEFAULTS = { tolerance: 48, cell: 8, minCellPixels: 3, minRegionPixels: 12, join: 1 };

/**
 * Rectangles (pixels, in the bitmaps' shared top-left-aligned frame) where
 * `a` and `b` differ. Bitmaps of different sizes are compared over the larger
 * extent, the missing part counting as white.
 */
export function diffBitmaps(a: Bitmap, b: Bitmap, opts: BitmapDiffOptions = {}): Rect[] {
  const tol = opts.tolerance ?? DEFAULTS.tolerance;
  const cell = Math.max(1, Math.round(opts.cell ?? DEFAULTS.cell));
  const minCell = opts.minCellPixels ?? DEFAULTS.minCellPixels;
  const minRegion = opts.minRegionPixels ?? DEFAULTS.minRegionPixels;
  const join = Math.max(0, Math.round(opts.join ?? DEFAULTS.join));
  const W = Math.max(a.width, b.width);
  const H = Math.max(a.height, b.height);
  if (!W || !H) return [];

  let mask: Uint8Array | null = null;
  if (opts.mask?.length) {
    mask = new Uint8Array(W * H);
    for (const r of opts.mask) {
      const x0 = Math.max(0, Math.floor(r.x));
      const y0 = Math.max(0, Math.floor(r.y));
      const x1 = Math.min(W, Math.ceil(r.x + r.w));
      const y1 = Math.min(H, Math.ceil(r.y + r.h));
      for (let y = y0; y < y1; y++) mask.fill(1, y * W + x0, Math.max(y * W + x0, y * W + x1));
    }
  }

  /** Channel `c` of pixel (x, y), composited on white; white outside the bitmap. */
  const px = (bm: Bitmap, x: number, y: number, c: number): number => {
    if (x < 0 || y < 0 || x >= bm.width || y >= bm.height) return 255;
    const o = (y * bm.width + x) * 4;
    const alpha = bm.data[o + 3];
    const v = bm.data[o + c];
    return alpha === 255 ? v : 255 - ((255 - v) * alpha) / 255;
  };
  const close = (p: Bitmap, px0: number, py0: number, q: Bitmap, qx: number, qy: number): boolean =>
    Math.abs(px(p, px0, py0, 0) - px(q, qx, qy, 0)) <= tol &&
    Math.abs(px(p, px0, py0, 1) - px(q, qx, qy, 1)) <= tol &&
    Math.abs(px(p, px0, py0, 2) - px(q, qx, qy, 2)) <= tol;
  /**
   * Pixel (x, y) of `p` lies within the range of colours of `q` around (x, y):
   * an anti-aliased edge moved by a sub-pixel blends its neighbours.
   */
  const nearby = (p: Bitmap, q: Bitmap, x: number, y: number): boolean => {
    for (let c = 0; c < 3; c++) {
      let lo = 255;
      let hi = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const v = px(q, x + dx, y + dy, c);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      const v = px(p, x, y, c);
      if (v < lo - tol || v > hi + tol) return false;
    }
    return true;
  };

  const gw = Math.ceil(W / cell);
  const gh = Math.ceil(H / cell);
  const count = new Uint32Array(gw * gh);
  // Tight bounds of the changed pixels of each cell.
  const minX = new Int32Array(gw * gh).fill(W);
  const minY = new Int32Array(gw * gh).fill(H);
  const maxX = new Int32Array(gw * gh).fill(-1);
  const maxY = new Int32Array(gw * gh).fill(-1);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask && mask[y * W + x]) continue;
      if (close(a, x, y, b, x, y)) continue;
      // An anti-aliased edge moved by less than a pixel: each side's colour is a blend of the other's neighbours.
      if (nearby(a, b, x, y) && nearby(b, a, x, y)) continue;
      const k = Math.floor(y / cell) * gw + Math.floor(x / cell);
      count[k]++;
      if (x < minX[k]) minX[k] = x;
      if (y < minY[k]) minY[k] = y;
      if (x > maxX[k]) maxX[k] = x;
      if (y > maxY[k]) maxY[k] = y;
    }
  }

  // Connected blocks of changed cells (8-neighbourhood, widened by `join`).
  const seen = new Uint8Array(gw * gh);
  const out: Rect[] = [];
  const reach = join + 1;
  for (let start = 0; start < gw * gh; start++) {
    if (seen[start] || count[start] < minCell) continue;
    seen[start] = 1;
    const stack = [start];
    let pixels = 0;
    let x0 = W;
    let y0 = H;
    let x1 = -1;
    let y1 = -1;
    while (stack.length) {
      const k = stack.pop()!;
      pixels += count[k];
      x0 = Math.min(x0, minX[k]);
      y0 = Math.min(y0, minY[k]);
      x1 = Math.max(x1, maxX[k]);
      y1 = Math.max(y1, maxY[k]);
      const cx = k % gw;
      const cy = (k - cx) / gw;
      for (let dy = -reach; dy <= reach; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= gh) continue;
        for (let dx = -reach; dx <= reach; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= gw) continue;
          const n = ny * gw + nx;
          if (seen[n] || count[n] < minCell) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (pixels >= minRegion) out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return out.sort((p, q) => p.y - q.y || p.x - q.x);
}

const scaleRect = (r: Rect, s: number): Rect => ({ x: r.x * s, y: r.y * s, w: r.w * s, h: r.h * s });
const grow = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by });
const meets = (p: Rect, q: Rect) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;

/**
 * Picture regions (page space) that are not explained by a text change of the
 * page: a region touching a changed word's box, on either side, is dropped.
 */
export function unexplainedRegions(regions: readonly Rect[], textChanges: readonly DiffItem[], margin = 2): Rect[] {
  const boxes = textChanges
    .filter((it) => it.category === "text" || it.category === "format")
    .flatMap((it) => [...it.leftRects, ...it.rightRects])
    .map((r) => grow(r, margin));
  return regions.filter((r) => !boxes.some((b) => meets(r, b)));
}

export interface VisualOptions extends Omit<BitmapDiffOptions, "mask"> {
  render: PageRasteriser;
  /** Resolution of the comparison (default 100 dpi). */
  dpi?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Add the picture differences of every paired page to `report` (a new report
 * is returned). Pages without text are compared this way only.
 */
export async function compareVisual(
  left: PdfEngine,
  right: PdfEngine,
  report: DetailedReport,
  opts: VisualOptions,
): Promise<DetailedReport> {
  const scale = (opts.dpi ?? 100) / 72;
  const paired = report.pages.filter((p) => p.leftPage !== null && p.rightPage !== null);
  let done = 0;
  let imageChanges = 0;
  let pagesModified = report.pagesModified;
  let seq = report.pages.reduce((n, p) => n + p.items.length, 0);
  const pages: DetailedPage[] = [];
  for (const pg of report.pages) {
    if (pg.leftPage === null || pg.rightPage === null) {
      pages.push(pg);
      continue;
    }
    if (opts.signal?.aborted) throw new DOMException("Comparaison annulée", "AbortError");
    const li = pg.leftPage - 1;
    const ri = pg.rightPage - 1;
    let regions: Rect[];
    try {
      const [a, b] = [await opts.render(left, li, scale), await opts.render(right, ri, scale)];
      const mask = [...pg.leftText, ...pg.rightText].map((r) => grow(scaleRect(r, scale), 1));
      regions = diffBitmaps(a, b, { ...opts, mask }).map((r) => scaleRect(r, 1 / scale));
    } finally {
      left.releasePageResources?.(li);
      right.releasePageResources?.(ri);
    }
    const found = unexplainedRegions(regions, pg.items);
    opts.onProgress?.(++done, paired.length);
    if (!found.length) {
      pages.push(pg);
      continue;
    }
    imageChanges += found.length;
    const items: DiffItem[] = found.map((r) => ({
      id: `c${++seq}`,
      category: "image",
      kind: "image",
      leftPage: pg.leftPage,
      rightPage: pg.rightPage,
      leftRects: [r],
      rightRects: [r],
      left: "",
      right: "",
      detail: pg.textless ? "Contenu modifié (page sans texte)" : "Image / dessin modifié",
    }));
    if (pg.status === "unchanged") pagesModified++;
    pages.push({ ...pg, status: "modified", items: [...pg.items, ...items] });
  }
  return { ...report, pages, imageChanges, pagesModified, visual: true };
}

/**
 * The fill colour of each text item of a page (by item index), read off the
 * operator list: pdf.js' text content does not carry it. The glyphs shown are
 * matched to the items' characters in order (whitespace ignored, resyncing
 * over what does not match — ligatures, synthesised spaces).
 */
export async function textItemColours(
  page: { getOperatorList(o?: object): Promise<{ fnArray: number[]; argsArray: unknown[][] }> },
  tc: TextContentLike,
): Promise<(string | undefined)[]> {
  // Same options as `pageFontFacts`: pdf.js serves its cached list.
  const ops = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE });
  const OPS = pdfjs.OPS;
  const chars: string[] = [];
  const colours: string[] = [];
  const stack: string[] = [];
  let fill = "#000000";
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] ?? [];
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) stack.push(fill);
    else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) fill = stack.pop() ?? fill;
    else if (fn === OPS.setFillRGBColor) {
      const c = args[0];
      if (typeof c === "string") fill = c.toLowerCase();
      else if (args.length >= 3) fill = hex(args as number[]);
    } else if (fn === OPS.showText || fn === OPS.showSpacedText) {
      const glyphs = (args[0] ?? []) as unknown[];
      for (const g of glyphs) {
        const u = g && typeof g === "object" ? (g as { unicode?: string }).unicode : undefined;
        if (!u) continue;
        for (const ch of u)
          if (!/\s/u.test(ch)) {
            chars.push(ch);
            colours.push(fill);
          }
      }
    }
  }
  const out: (string | undefined)[] = [];
  let at = 0;
  for (const it of tc.items ?? []) {
    let colour: string | undefined;
    for (const ch of typeof it.str === "string" ? it.str : "") {
      if (/\s/u.test(ch)) continue;
      let k = at;
      while (k < chars.length && k < at + 64 && chars[k] !== ch) k++;
      if (k < chars.length && chars[k] === ch) {
        colour ??= colours[k];
        at = k + 1;
      }
    }
    out.push(colour);
  }
  return out;
}

function hex(c: readonly number[]): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n <= 1 ? n * 255 : n)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/** The browser rasteriser: pdf.js into a detached canvas, read back. */
export const canvasRasteriser: PageRasteriser = async (engine, pageIndex, scale) => {
  const { renderToCanvas } = await import("../core/render");
  const canvas = await renderToCanvas(await engine.page(pageIndex), { scale, rotation: 0, background: "#ffffff" });
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // Let the backing store go now rather than at the next collection.
  canvas.width = canvas.height = 0;
  return { width: img.width, height: img.height, data: img.data };
};

export interface CompareFilesOptions {
  /** Rasteriser for the visual comparison; omitted = text only. */
  render?: PageRasteriser;
  dpi?: number;
  tolerance?: number;
  /** Read text colours off the operator lists (default true). */
  colours?: boolean;
  onProgress?: (phase: "texte" | "images", done: number, total: number) => void;
  signal?: AbortSignal;
}

async function sizesOf(engine: PdfEngine): Promise<Size[]> {
  const out: Size[] = [];
  for (let i = 0; i < engine.pageCount; i++) {
    const info = await engine.pageInfo(i);
    out.push({ w: info.w, h: info.h });
  }
  return out;
}

async function coloursOf(engine: PdfEngine): Promise<(string | undefined)[][]> {
  const out: (string | undefined)[][] = [];
  for (let i = 0; i < engine.pageCount; i++) {
    try {
      out.push(await textItemColours(await engine.page(i), await engine.text(i)));
    } catch {
      out.push([]);
    }
  }
  return out;
}

/**
 * The whole comparison of two open documents: layout, words, formatting,
 * moved pages, then (with a rasteriser) the picture differences.
 */
export async function compareFiles(
  left: PdfEngine,
  right: PdfEngine,
  opts: CompareFilesOptions = {},
): Promise<DetailedReport> {
  const total = left.pageCount + right.pageCount;
  const aborted = () => {
    if (opts.signal?.aborted) throw new DOMException("Comparaison annulée", "AbortError");
  };
  const leftLayout = await extractLayout(left, (d) => opts.onProgress?.("texte", d, total));
  aborted();
  const rightLayout = await extractLayout(right, (d) => opts.onProgress?.("texte", left.pageCount + d, total));
  aborted();
  const withColours = opts.colours !== false;
  const report = compareLayouts(leftLayout, rightLayout, {
    leftSizes: await sizesOf(left),
    rightSizes: await sizesOf(right),
    leftColours: withColours ? await coloursOf(left) : undefined,
    rightColours: withColours ? await coloursOf(right) : undefined,
  });
  aborted();
  if (!opts.render) return report;
  return compareVisual(left, right, report, {
    render: opts.render,
    dpi: opts.dpi,
    tolerance: opts.tolerance,
    signal: opts.signal,
    onProgress: (d, t) => opts.onProgress?.("images", d, t),
  });
}
