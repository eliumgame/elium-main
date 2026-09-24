/**
 * Pure page layout for the virtualised viewer — no DOM, no React, no pdf.js.
 *
 * Given every page's size (in points, ALREADY rotated into view orientation)
 * and the zoom, it places the pages the way Acrobat's page-display modes do:
 *
 *  - `continuous`        one page per row, all rows stacked (default);
 *  - `single`            one page per row, only the current row is shown;
 *  - `facingContinuous`  two pages per row (a spread), all spreads stacked;
 *  - `facing`            two pages per row, only the current spread is shown.
 *
 * With `cover`, page 1 sits alone on the right of the spine (a book cover), so
 * even pages are on the left like in print. Rows are centred horizontally;
 * spreads are aligned on a common spine so a lone page never "jumps".
 *
 * Offsets are prefix sums, so finding what is on screen is a binary search —
 * O(log n) per scroll frame whatever the page count — and the scroll position
 * can be re-anchored exactly when the zoom or some page's size changes.
 */

import type { ViewMode } from "../../ui/state";

/** A page's extent in view orientation, in points. */
export interface PageBox {
  w: number;
  h: number;
}

export interface LayoutOptions {
  mode: ViewMode;
  /** Two-up modes: page 1 alone, as a cover. */
  cover: boolean;
  /** CSS pixels per point. */
  scale: number;
  /** Width of the scroll viewport (CSS px) — rows are centred in it. */
  viewportWidth: number;
  /** Paged modes (`single`, `facing`): the row to show. Ignored in continuous modes. */
  row?: number;
  /** Vertical gap between rows (CSS px). */
  gap?: number;
  /** Horizontal gap between the two pages of a spread (CSS px). */
  spreadGap?: number;
  padTop?: number;
  padBottom?: number;
  padX?: number;
}

export const LAYOUT_DEFAULTS = {
  gap: 18,
  spreadGap: 10,
  padTop: 22,
  padBottom: 60,
  padX: 24,
} as const;

export interface Row {
  /** First page index of the row. */
  start: number;
  /** One past the last page index. */
  end: number;
  top: number;
  height: number;
}

export interface Layout {
  count: number;
  scale: number;
  mode: ViewMode;
  /** True for `single` / `facing`: only `rows[shownRow]` is placed. */
  paged: boolean;
  /** Paged modes: the row on screen. Continuous modes: -1. */
  shownRow: number;
  /** Every row of the document (placement is only meaningful for placed rows). */
  rows: Row[];
  /** Page → row. */
  rowOf: Int32Array;
  /** Page boxes in CSS px, relative to the content origin; NaN when not placed. */
  x: Float64Array;
  y: Float64Array;
  w: Float64Array;
  h: Float64Array;
  contentWidth: number;
  contentHeight: number;
  /** Row tops/bottoms of the placed rows, ascending (binary-search index). */
  placedRows: number[];
}

export const isPagedMode = (mode: ViewMode): boolean => mode === "single" || mode === "facing";
export const isTwoUpMode = (mode: ViewMode): boolean => mode === "facing" || mode === "facingContinuous";

/** Group page indices into rows for a mode. */
export function buildRows(count: number, mode: ViewMode, cover: boolean): [number, number][] {
  const rows: [number, number][] = [];
  if (!isTwoUpMode(mode)) {
    for (let i = 0; i < count; i++) rows.push([i, i + 1]);
    return rows;
  }
  let i = 0;
  if (cover && count > 0) {
    rows.push([0, 1]);
    i = 1;
  }
  for (; i < count; i += 2) rows.push([i, Math.min(count, i + 2)]);
  return rows;
}

/**
 * In a spread, is page `index` on the left of the spine? With a cover, odd
 * indices (pages 2, 4, …) are left pages; without, even indices are.
 */
function isLeftPage(index: number, cover: boolean): boolean {
  return cover ? index % 2 === 1 : index % 2 === 0;
}

export function computeLayout(boxes: readonly PageBox[], opts: LayoutOptions): Layout {
  const gap = opts.gap ?? LAYOUT_DEFAULTS.gap;
  const spreadGap = opts.spreadGap ?? LAYOUT_DEFAULTS.spreadGap;
  const padTop = opts.padTop ?? LAYOUT_DEFAULTS.padTop;
  const padBottom = opts.padBottom ?? LAYOUT_DEFAULTS.padBottom;
  const padX = opts.padX ?? LAYOUT_DEFAULTS.padX;
  const scale = opts.scale > 0 && Number.isFinite(opts.scale) ? opts.scale : 1;
  const count = boxes.length;
  const twoUp = isTwoUpMode(opts.mode);
  const paged = isPagedMode(opts.mode);

  const x = new Float64Array(count).fill(Number.NaN);
  const y = new Float64Array(count).fill(Number.NaN);
  const w = new Float64Array(count);
  const h = new Float64Array(count);
  const rowOf = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    w[i] = Math.max(1, boxes[i].w) * scale;
    h[i] = Math.max(1, boxes[i].h) * scale;
  }

  const groups = buildRows(count, opts.mode, opts.cover);
  const shownRow = paged ? Math.max(0, Math.min(groups.length - 1, opts.row ?? 0)) : -1;

  // Content width: widest row, or — for spreads — twice the widest half so the
  // spine stays put whichever spread is on screen.
  let maxLeft = 0;
  let maxRight = 0;
  let maxSingle = 0;
  const consider = (r: number) => {
    const [s, e] = groups[r];
    if (!twoUp) {
      maxSingle = Math.max(maxSingle, w[s]);
      return;
    }
    for (let i = s; i < e; i++) {
      if (e - s === 1 && i === 0 && opts.cover) maxRight = Math.max(maxRight, w[i]);
      else if (isLeftPage(i, opts.cover)) maxLeft = Math.max(maxLeft, w[i]);
      else maxRight = Math.max(maxRight, w[i]);
    }
  };
  if (paged && groups.length) consider(shownRow);
  else for (let r = 0; r < groups.length; r++) consider(r);
  const needed = twoUp ? 2 * Math.max(maxLeft, maxRight) + spreadGap : maxSingle;
  const contentWidth = Math.max(opts.viewportWidth, needed + 2 * padX);
  const spine = contentWidth / 2;

  const rows: Row[] = [];
  const placedRows: number[] = [];
  let top = padTop;
  for (let r = 0; r < groups.length; r++) {
    const [s, e] = groups[r];
    let rowH = 0;
    for (let i = s; i < e; i++) {
      rowOf[i] = r;
      rowH = Math.max(rowH, h[i]);
    }
    const placed = !paged || r === shownRow;
    const rowTop = paged ? padTop : top;
    rows.push({ start: s, end: e, top: rowTop, height: rowH });
    if (placed) {
      placedRows.push(r);
      for (let i = s; i < e; i++) {
        y[i] = rowTop + (rowH - h[i]) / 2;
        if (!twoUp) x[i] = (contentWidth - w[i]) / 2;
        else if (e - s === 1 && i === 0 && opts.cover) x[i] = spine + spreadGap / 2;
        else if (isLeftPage(i, opts.cover)) x[i] = spine - spreadGap / 2 - w[i];
        else x[i] = spine + spreadGap / 2;
      }
    }
    if (!paged) top += rowH + (r < groups.length - 1 ? gap : 0);
  }
  const lastBottom = paged
    ? padTop + (rows[shownRow]?.height ?? 0)
    : rows.length
      ? rows[rows.length - 1].top + rows[rows.length - 1].height
      : padTop;
  return {
    count,
    scale,
    mode: opts.mode,
    paged,
    shownRow,
    rows,
    rowOf,
    x,
    y,
    w,
    h,
    contentWidth,
    contentHeight: lastBottom + padBottom,
    placedRows,
  };
}

/** Is page `index` placed (on the content) in this layout? */
export const isPlaced = (layout: Layout, index: number): boolean =>
  index >= 0 && index < layout.count && !Number.isNaN(layout.y[index]);

/** First placed-row position (in `placedRows`) whose bottom is below `y`. */
function firstRowEndingAfter(layout: Layout, y: number): number {
  const list = layout.placedRows;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const row = layout.rows[list[mid]];
    if (row.top + row.height > y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Pages whose rows intersect the vertical band `[top, bottom]` (CSS px of
 * content), as an inclusive index range — the set to keep mounted.
 */
export function rangeInBand(layout: Layout, top: number, bottom: number): { first: number; last: number } | null {
  const list = layout.placedRows;
  let k = firstRowEndingAfter(layout, top);
  if (k >= list.length) k = list.length - 1;
  if (k < 0) return null;
  let first = -1;
  let last = -1;
  for (; k < list.length; k++) {
    const row = layout.rows[list[k]];
    if (row.top > bottom) break;
    if (first < 0) first = row.start;
    last = row.end - 1;
  }
  if (first < 0) {
    // Band beyond the content: keep the nearest row.
    const row = layout.rows[list[Math.max(0, Math.min(list.length - 1, firstRowEndingAfter(layout, top)))]];
    if (!row) return null;
    return { first: row.start, last: row.end - 1 };
  }
  return { first, last };
}

export interface Viewport {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface VisiblePage {
  index: number;
  /** Visible area in CSS px². */
  area: number;
  /** 0..100, share of the page that is on screen. */
  percent: number;
  /** The on-screen part in page-local CSS px, or null when the page is fully visible. */
  visibleArea: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

/**
 * The pages actually on screen, most visible first (ties → lower index) —
 * exactly what pdf.js' `getVisibleElements({ sortByVisibility: true })` gives
 * its rendering queue, including the `visibleArea` its detail (tile) canvas
 * needs at high zoom.
 */
export function visiblePages(layout: Layout, vp: Viewport): VisiblePage[] {
  const out: VisiblePage[] = [];
  const range = rangeInBand(layout, vp.top, vp.top + vp.height);
  if (!range) return out;
  const right = vp.left + vp.width;
  const bottom = vp.top + vp.height;
  for (let i = range.first; i <= range.last; i++) {
    if (!isPlaced(layout, i)) continue;
    const px = layout.x[i];
    const py = layout.y[i];
    const pw = layout.w[i];
    const ph = layout.h[i];
    const minX = Math.max(0, vp.left - px);
    const minY = Math.max(0, vp.top - py);
    const maxX = Math.min(pw, right - px);
    const maxY = Math.min(ph, bottom - py);
    if (maxX <= minX || maxY <= minY) continue;
    const area = (maxX - minX) * (maxY - minY);
    const percent = Math.floor((area / (pw * ph)) * 100);
    const full = minX <= 0 && minY <= 0 && maxX >= pw && maxY >= ph;
    out.push({ index: i, area, percent, visibleArea: full ? null : { minX, minY, maxX, maxY } });
  }
  out.sort((a, b) => b.percent - a.percent || a.index - b.index);
  return out;
}

/** The "current" page: the one covering the most of the viewport (ties → lower index). */
export function mostVisiblePage(layout: Layout, vp: Viewport): number {
  const vis = visiblePages(layout, vp);
  if (!vis.length) {
    const range = rangeInBand(layout, vp.top, vp.top + vp.height);
    return range ? range.first : 0;
  }
  let best = vis[0];
  for (const v of vis)
    if (v.area > best.area + 0.5 || (Math.abs(v.area - best.area) <= 0.5 && v.index < best.index)) best = v;
  return best.index;
}

// ---------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------

/**
 * A document point pinned to a viewport point: "the spot `(px, py)` points into
 * page `index` is shown at `(vx, vy)` pixels from the viewport's top-left".
 * Captured before a zoom / geometry change, resolved against the new layout,
 * it gives the scroll position that keeps what the reader looks at in place.
 */
export interface Anchor {
  index: number;
  /** Offset into the page, in points (view orientation). */
  px: number;
  py: number;
  /** Where that point is in the viewport, CSS px. */
  vx: number;
  vy: number;
}

export function captureAnchor(layout: Layout, scroll: { top: number; left: number }, vx: number, vy: number): Anchor {
  const docX = scroll.left + vx;
  const docY = scroll.top + vy;
  const list = layout.placedRows;
  if (!list.length) return { index: 0, px: 0, py: 0, vx, vy };
  let k = firstRowEndingAfter(layout, docY);
  if (k >= list.length) k = list.length - 1;
  const row = layout.rows[list[k]];
  // Inside a spread, the page horizontally closest to the point.
  let index = row.start;
  let bestD = Infinity;
  for (let i = row.start; i < row.end; i++) {
    const l = layout.x[i];
    const r = l + layout.w[i];
    const d = docX < l ? l - docX : docX > r ? docX - r : 0;
    if (d < bestD) {
      bestD = d;
      index = i;
    }
  }
  return {
    index,
    px: (docX - layout.x[index]) / layout.scale,
    py: (docY - layout.y[index]) / layout.scale,
    vx,
    vy,
  };
}

/** Scroll position (clamped to the content) that puts `anchor` back where it was. */
export function resolveAnchor(
  layout: Layout,
  anchor: Anchor,
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const i = Math.max(0, Math.min(layout.count - 1, anchor.index));
  if (!isPlaced(layout, i)) return { top: 0, left: 0 };
  const top = layout.y[i] + anchor.py * layout.scale - anchor.vy;
  const left = layout.x[i] + anchor.px * layout.scale - anchor.vx;
  return {
    top: clampScroll(top, layout.contentHeight, viewport.height),
    left: clampScroll(left, layout.contentWidth, viewport.width),
  };
}

export function clampScroll(v: number, content: number, viewport: number): number {
  const max = Math.max(0, content - viewport);
  return v < 0 ? 0 : v > max ? max : v;
}

/**
 * Scroll offset that brings page `index` to the top of the viewport, `topPt`
 * points below its top edge (e.g. a bookmark's destination), with `margin` px
 * of air above.
 */
export function scrollTopForPage(layout: Layout, index: number, topPt = 0, margin = 16): number {
  if (!isPlaced(layout, index)) return 0;
  return Math.max(0, layout.y[index] + topPt * layout.scale - margin);
}

// ---------------------------------------------------------------------------
// Fit-to-window zoom
// ---------------------------------------------------------------------------

export type FitMode = "fitWidth" | "fitPage" | "fitVisible";

/** Horizontal / vertical room reserved around a fitted page (CSS px). */
export const FIT_MARGIN_X = 2 * LAYOUT_DEFAULTS.padX + 16;
export const FIT_MARGIN_Y = LAYOUT_DEFAULTS.padTop + LAYOUT_DEFAULTS.gap + 16;

/**
 * The zoom that fits `page` (view-oriented points) in a viewport of the given
 * size. It depends ONLY on the viewport and the page — never on the content —
 * so re-fitting after the layout changed is a fixed point (the old "Largeur →
 * 1000 %" runaway came from a viewport that grew with its own content).
 */
export function fitScale(
  mode: FitMode,
  page: PageBox,
  viewport: { width: number; height: number },
  opts: { twoUp?: boolean; spreadGap?: number } = {},
): number {
  const availW = Math.max(40, viewport.width - FIT_MARGIN_X);
  const availH = Math.max(40, viewport.height - FIT_MARGIN_Y);
  const w = Math.max(1, page.w);
  const h = Math.max(1, page.h);
  const spanW = opts.twoUp ? 2 * w + (opts.spreadGap ?? LAYOUT_DEFAULTS.spreadGap) : w;
  switch (mode) {
    case "fitWidth":
      return availW / spanW;
    case "fitPage":
      return Math.min(availW / spanW, availH / h);
    case "fitVisible":
      // "Zone de texte": crop the typical ~7 % side margins.
      return availW / (spanW * 0.86);
  }
}
