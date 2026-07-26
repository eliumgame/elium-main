/**
 * Geometry and coordinate transforms for the whole PDF module.
 *
 * THREE SPACES, never mixed:
 *
 *  1. **Page space (PS)** — the canonical space every annotation, quad and
 *     redaction box is stored in. Origin top-left, y grows DOWN, unit = PDF
 *     point (1/72"), *unrotated* (the page's own /Rotate is not applied). Its
 *     extent is the page's crop box size, `{ w, h }`.
 *
 *  2. **PDF space** — what pdf-lib writes. Origin bottom-left, y grows UP.
 *     Conversion is a pure y-flip against the unrotated page height, plus the
 *     crop-box offset when the crop box does not start at (0,0).
 *
 *  3. **View space** — what the user sees: page space with the total rotation
 *     (page /Rotate + the user's extra rotation) applied, then multiplied by the
 *     zoom scale. Origin top-left, y down, unit = CSS pixel.
 *
 * Keeping annotations in page space means rotating or zooming a page never
 * touches stored data, and export needs one deterministic transform.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/**
 * A (possibly rotated) quadrilateral, corners in reading order:
 * top-left, top-right, bottom-right, bottom-left. Used for text markup so
 * highlights follow slanted or vertical text instead of a loose bounding box.
 */
export type Quad = [Pt, Pt, Pt, Pt];

/** Rotation applied to a page, always normalised to 0 / 90 / 180 / 270. */
export type Rotation = 0 | 90 | 180 | 270;

export function normRotation(deg: number): Rotation {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r as Rotation;
}

// ---------------------------------------------------------------------------
// Rectangles
// ---------------------------------------------------------------------------

/** Rect from two opposite corners (handles dragging up/left). */
export function rectFromPoints(a: Pt, b: Pt): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/** Rect with non-negative width/height (a drag may produce negatives). */
export function normRect(r: Rect): Rect {
  return {
    x: r.w < 0 ? r.x + r.w : r.x,
    y: r.h < 0 ? r.y + r.h : r.y,
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  };
}

export function rectOfPoints(pts: readonly Pt[]): Rect {
  if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function rectUnion(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

export function rectContains(r: Rect, p: Pt): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Fraction of `inner`'s area that lies inside `outer` (0..1). */
export function overlapRatio(inner: Rect, outer: Rect): number {
  const w = Math.min(inner.x + inner.w, outer.x + outer.w) - Math.max(inner.x, outer.x);
  const h = Math.min(inner.y + inner.h, outer.y + outer.h) - Math.max(inner.y, outer.y);
  if (w <= 0 || h <= 0) return 0;
  const area = inner.w * inner.h;
  return area > 0 ? (w * h) / area : 0;
}

export function rectCenter(r: Rect): Pt {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

// ---------------------------------------------------------------------------
// Quads
// ---------------------------------------------------------------------------

export function quadFromRect(r: Rect): Quad {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

export function rectOfQuad(q: Quad): Rect {
  return rectOfPoints(q);
}

export function rectOfQuads(quads: readonly Quad[]): Rect {
  return rectOfPoints(quads.flat());
}

/**
 * PDF `/QuadPoints` order is *not* the reading order used above: the spec lists
 * upper-left, upper-right, LOWER-LEFT, lower-right. Emitting them in the wrong
 * order is the classic reason a highlight shows as an hourglass in Acrobat.
 */
export function quadToPdfQuadPoints(q: Quad, pageHeight: number): number[] {
  const [tl, tr, br, bl] = q;
  const f = (p: Pt) => [p.x, pageHeight - p.y];
  return [...f(tl), ...f(tr), ...f(bl), ...f(br)];
}

// ---------------------------------------------------------------------------
// Page space <-> PDF space (y-flip)
// ---------------------------------------------------------------------------

export function ptToPdf(p: Pt, pageHeight: number): Pt {
  return { x: p.x, y: pageHeight - p.y };
}

/** Page-space rect to a pdf-lib draw box (its y is the BOTTOM edge). */
export function rectToPdf(r: Rect, pageHeight: number): Rect {
  return { x: r.x, y: pageHeight - r.y - r.h, w: r.w, h: r.h };
}

/** Page-space rect to a PDF `/Rect` array [x1, y1, x2, y2]. */
export function rectToPdfRect(r: Rect, pageHeight: number): [number, number, number, number] {
  return [r.x, pageHeight - r.y - r.h, r.x + r.w, pageHeight - r.y];
}

/** PDF `/Rect` array back to a page-space rect. */
export function pdfRectToRect(a: readonly number[], pageHeight: number): Rect {
  const x1 = Math.min(a[0], a[2]);
  const x2 = Math.max(a[0], a[2]);
  const y1 = Math.min(a[1], a[3]);
  const y2 = Math.max(a[1], a[3]);
  return { x: x1, y: pageHeight - y2, w: x2 - x1, h: y2 - y1 };
}

// ---------------------------------------------------------------------------
// Page space <-> view space (rotation + zoom)
// ---------------------------------------------------------------------------

/** Size of a page once rotated (90/270 swap the axes). */
export function rotatedSize(size: Size, rotation: Rotation): Size {
  return rotation % 180 === 0 ? { w: size.w, h: size.h } : { w: size.h, h: size.w };
}

/** Page-space point to unscaled view space under `rotation`. */
export function psToView(p: Pt, size: Size, rotation: Rotation): Pt {
  switch (rotation) {
    case 90: return { x: size.h - p.y, y: p.x };
    case 180: return { x: size.w - p.x, y: size.h - p.y };
    case 270: return { x: p.y, y: size.w - p.x };
    default: return { x: p.x, y: p.y };
  }
}

/** Unscaled view-space point back to page space. */
export function viewToPs(p: Pt, size: Size, rotation: Rotation): Pt {
  switch (rotation) {
    case 90: return { x: p.y, y: size.h - p.x };
    case 180: return { x: size.w - p.x, y: size.h - p.y };
    case 270: return { x: size.w - p.y, y: p.x };
    default: return { x: p.x, y: p.y };
  }
}

/**
 * Axis-aligned page-space rect to an axis-aligned view rect. A rotation of
 * 90/270 turns the rect on its side, so width and height swap too.
 */
export function rectToView(r: Rect, size: Size, rotation: Rotation): Rect {
  const a = psToView({ x: r.x, y: r.y }, size, rotation);
  const b = psToView({ x: r.x + r.w, y: r.y + r.h }, size, rotation);
  return rectFromPoints(a, b);
}

export function rectFromView(r: Rect, size: Size, rotation: Rotation): Rect {
  const a = viewToPs({ x: r.x, y: r.y }, size, rotation);
  const b = viewToPs({ x: r.x + r.w, y: r.y + r.h }, size, rotation);
  return rectFromPoints(a, b);
}

export function quadToView(q: Quad, size: Size, rotation: Rotation): Quad {
  return q.map((p) => psToView(p, size, rotation)) as Quad;
}

// ---------------------------------------------------------------------------
// 2×3 affine matrices (pdf.js reports text placement as one)
// ---------------------------------------------------------------------------

export type Matrix = [number, number, number, number, number, number];

export function applyMatrix(m: Matrix, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function matrixScale(m: Matrix): { sx: number; sy: number } {
  return { sx: Math.hypot(m[0], m[1]), sy: Math.hypot(m[2], m[3]) };
}

/** Rotation of a text run in radians, from its placement matrix. */
export function matrixAngle(m: Matrix): number {
  return Math.atan2(m[1], m[0]);
}

// ---------------------------------------------------------------------------
// Misc numeric helpers
// ---------------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Round to `dp` decimals — keeps exported PDF numbers short and stable. */
export function round(v: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

export const MM_PER_PT = 25.4 / 72;
export const PT_PER_INCH = 72;

/** Convert a length in points to a display unit. */
export function fromPoints(pts: number, unit: "pt" | "mm" | "cm" | "in"): number {
  switch (unit) {
    case "mm": return pts * MM_PER_PT;
    case "cm": return (pts * MM_PER_PT) / 10;
    case "in": return pts / PT_PER_INCH;
    default: return pts;
  }
}

export function toPoints(value: number, unit: "pt" | "mm" | "cm" | "in"): number {
  switch (unit) {
    case "mm": return value / MM_PER_PT;
    case "cm": return (value * 10) / MM_PER_PT;
    case "in": return value * PT_PER_INCH;
    default: return value;
  }
}
