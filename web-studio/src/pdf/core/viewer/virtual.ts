/**
 * Pure windowing maths for the long lists of the PDF module (the thumbnail
 * pane, the page organiser grid): rows of known heights stacked with a gap,
 * prefix-sum offsets, and a binary search for the rows intersecting the
 * scrolled band — so a 5 000-page document keeps only a screenful of items in
 * the DOM. No DOM, no React: tested in vitest.
 */

export interface RowStack {
  /** Top of each row (px from the list's content origin). */
  tops: Float64Array;
  heights: Float64Array;
  gap: number;
  /** Height of all rows and the gaps between them. */
  total: number;
}

export function stackRows(heights: readonly number[], gap: number): RowStack {
  const n = heights.length;
  const tops = new Float64Array(n);
  const hs = new Float64Array(n);
  let y = 0;
  for (let i = 0; i < n; i++) {
    tops[i] = y;
    hs[i] = Math.max(0, heights[i] || 0);
    y += hs[i] + (i < n - 1 ? gap : 0);
  }
  return { tops, heights: hs, gap, total: n ? y : 0 };
}

/**
 * Inclusive range of rows intersecting `[top, bottom]`, widened by `overscan`
 * px on both sides; null for an empty list.
 */
export function rowRange(
  stack: RowStack,
  top: number,
  bottom: number,
  overscan = 0,
): { first: number; last: number } | null {
  const n = stack.tops.length;
  if (!n) return null;
  const a = top - overscan;
  const b = bottom + overscan;
  // First row whose bottom is below `a`.
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (stack.tops[mid] + stack.heights[mid] > a) hi = mid;
    else lo = mid + 1;
  }
  const first = Math.min(lo, n - 1);
  let last = first;
  while (last + 1 < n && stack.tops[last + 1] <= b) last++;
  return { first, last };
}

/**
 * Columns a fixed-width cell grid fits in `width` (CSS grid / flex-wrap rule:
 * `n` cells and `n - 1` gaps must fit), at least 1.
 */
export function gridColumns(width: number, cellWidth: number, gap: number): number {
  if (!(cellWidth > 0)) return 1;
  return Math.max(1, Math.floor((width + gap) / (cellWidth + gap)));
}

/** Row heights of a grid of `columns` cells per row: each row is as tall as its tallest cell. */
export function gridRowHeights(cellHeights: readonly number[], columns: number): number[] {
  const cols = Math.max(1, columns | 0);
  const out: number[] = [];
  for (let i = 0; i < cellHeights.length; i += cols) {
    let h = 0;
    for (let k = i; k < Math.min(cellHeights.length, i + cols); k++) h = Math.max(h, cellHeights[k]);
    out.push(h);
  }
  return out;
}

/**
 * The scroll offset that brings row `index` fully into a viewport showing
 * `[scrollTop, scrollTop + height]`, or null when it already is.
 */
export function scrollIntoRow(stack: RowStack, index: number, scrollTop: number, height: number, margin = 8): number | null {
  if (index < 0 || index >= stack.tops.length) return null;
  const top = stack.tops[index];
  const bottom = top + stack.heights[index];
  if (top >= scrollTop && bottom <= scrollTop + height) return null;
  if (top < scrollTop) return Math.max(0, top - margin);
  return Math.max(0, bottom - height + margin);
}
