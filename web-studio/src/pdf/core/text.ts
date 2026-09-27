/**
 * Text geometry: turning pdf.js text items into runs, words, lines and
 * paragraphs in page space, and turning a live DOM selection back into quads.
 *
 * Text selection itself is delegated to the browser (pdf.js paints transparent,
 * correctly-positioned spans and the user selects them natively — that is what
 * gives Acrobat-grade double-click-a-word / triple-click-a-line / shift-extend
 * behaviour for free). This module only converts *between* that DOM world and
 * the page-space geometry the model stores.
 */

import { pdfjs } from "./pdfjs";
import type { Matrix, Pt, Quad, Rect, Rotation, Size } from "./coords";
import { quadFromRect, rectFromView, rectOfPoints } from "./coords";
import type { FontFacts, TextContentLike, TextItemLike } from "./engine";

/** One text-showing operation, placed in page space. */
export interface TextRun {
  /** Index of the source item inside `getTextContent().items`. */
  index: number;
  str: string;
  /** Baseline start point, page space. */
  origin: Pt;
  /** Advance width in points. */
  width: number;
  /** Em size in points. */
  fontSize: number;
  /** Rotation of the run in radians (0 for ordinary horizontal text). */
  angle: number;
  /** Unit vector along the writing direction, page space. */
  dir: Pt;
  /** Unit vector from the baseline toward the ascender, page space. */
  up: Pt;
  fontName?: string;
  fontFamily?: string;
  bold: boolean;
  italic: boolean;
  quad: Quad;
  rect: Rect;
  hasEOL: boolean;
}

/** A visual line: runs sharing a baseline. */
export interface TextLine {
  key: string;
  runs: TextRun[];
  text: string;
  rect: Rect;
  quad: Quad;
  /** Baseline start of the first run. */
  origin: Pt;
  fontSize: number;
  angle: number;
  fontFamily?: string;
  bold: boolean;
  italic: boolean;
  /** Character offset of this line inside the page text built by `joinItems`. */
  charStart: number;
  charEnd: number;
}

/** A block of consecutive lines with compatible geometry — an editable paragraph. */
export interface TextBlock {
  key: string;
  lines: TextLine[];
  rect: Rect;
  text: string;
  fontSize: number;
  /** Median vertical distance between successive baselines. */
  leading: number;
  align: "left" | "center" | "right" | "justify";
  fontFamily?: string;
  bold: boolean;
  italic: boolean;
}

/** Fraction of the em box above/below the baseline a markup quad should cover. */
const ASCENT = 0.84;
const DESCENT = 0.22;

const norm = (p: Pt): Pt => {
  const m = Math.hypot(p.x, p.y) || 1;
  return { x: p.x / m, y: p.y / m };
};

/**
 * Build page-space runs. `pageSize` is the unrotated crop-box size; the caller
 * must pass the viewport transform of `getViewport({ scale: 1, rotation: 0 })`
 * so PDF space (y up) is flipped into page space (y down) exactly once.
 */
export function buildRuns(
  tc: TextContentLike,
  viewportTransform: number[],
  /** The page's real fonts (`PdfEngine.fonts`): without them bold / italic are guessed from ids. */
  fonts?: ReadonlyMap<string, FontFacts>,
): TextRun[] {
  const out: TextRun[] = [];
  const items = tc.items ?? [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as TextItemLike;
    if (typeof it.str !== "string" || !it.str.length || !it.transform) continue;
    const tx = pdfjs.Util.transform(viewportTransform, it.transform) as Matrix;
    const dir = norm({ x: tx[0], y: tx[1] });
    const up = norm({ x: tx[2], y: tx[3] });
    const fontSize = Math.hypot(tx[2], tx[3]) || Math.abs(tx[3]) || 12;
    const width = typeof it.width === "number" && it.width > 0 ? it.width : it.str.length * fontSize * 0.5;
    const origin: Pt = { x: tx[4], y: tx[5] };
    const a = ASCENT * fontSize;
    const d = DESCENT * fontSize;
    const tl: Pt = { x: origin.x + up.x * a, y: origin.y + up.y * a };
    const tr: Pt = { x: tl.x + dir.x * width, y: tl.y + dir.y * width };
    const bl: Pt = { x: origin.x - up.x * d, y: origin.y - up.y * d };
    const br: Pt = { x: bl.x + dir.x * width, y: bl.y + dir.y * width };
    const quad: Quad = [tl, tr, br, bl];
    const style = it.fontName ? tc.styles?.[it.fontName] : undefined;
    const facts = it.fontName ? fonts?.get(it.fontName) : undefined;
    const fontName = facts?.name || it.fontName || "";
    out.push({
      index: i,
      str: it.str,
      origin,
      width,
      fontSize,
      angle: Math.atan2(tx[1], tx[0]),
      dir,
      up,
      fontName: it.fontName,
      fontFamily: familyOf(facts?.name, style?.fontFamily),
      bold: facts ? facts.bold : /bold|black|heavy|semibold/i.test(fontName),
      italic: facts ? facts.italic : /italic|oblique/i.test(fontName),
      quad,
      rect: rectOfPoints(quad),
      hasEOL: !!it.hasEOL,
    });
  }
  return out;
}

/**
 * The Elium family closest to a PDF font (its BaseFont, subset prefix
 * stripped), else to pdf.js' generic fallback: what a rewritten paragraph is
 * set in when its own font cannot be reused, and what the editor shows.
 */
export function familyOf(baseFont: string | undefined, fallback: string | undefined): string {
  const name = (baseFont ?? "").replace(/^[A-Z]{6}\+/, "");
  if (/courier|mono|consol|menlo|fixed|typewriter/i.test(name)) return "Courier New";
  if (/georgia/i.test(name)) return "Georgia";
  if (/garamond/i.test(name)) return "Garamond";
  if (/cambria/i.test(name)) return "Cambria";
  if (
    /times|tinos|liberationserif|serif|roman|minion|palatino|book ?antiqua|century/i.test(name) &&
    !/sans/i.test(name)
  ) {
    return "Times New Roman";
  }
  if (/calibri|carlito/i.test(name)) return "Calibri";
  if (/verdana/i.test(name)) return "Verdana";
  if (/tahoma/i.test(name)) return "Tahoma";
  if (/arial|helvetica|arimo|liberationsans|sans/i.test(name)) return "Arial";
  if (!name) {
    if (/mono/i.test(fallback ?? "")) return "Courier New";
    if (/serif/i.test(fallback ?? "") && !/sans/i.test(fallback ?? "")) return "Times New Roman";
  }
  return "Arial";
}

/**
 * Group runs into visual lines. Runs join a line when they share a baseline
 * (within a fraction of the em) *and* the same writing angle — so rotated
 * stamps and vertical labels never get merged into body text.
 */
export function groupLines(runs: readonly TextRun[], items?: readonly TextItemLike[]): TextLine[] {
  // Character offsets are measured against the same join used for search.
  const offsets = items ? runOffsets(items) : null;

  const sorted = runs.slice().sort((a, b) => {
    const ay = a.origin.y,
      by = b.origin.y;
    if (Math.abs(ay - by) > 0.6) return ay - by;
    return a.origin.x - b.origin.x;
  });

  const lines: TextLine[] = [];

  const emit = (group: TextRun[]) => {
    // Leading / trailing blanks belong to no one.
    while (group.length && !group[0].str.trim()) group.shift();
    while (group.length && !group[group.length - 1].str.trim()) group.pop();
    if (!group.length) return;
    const text = group.map((r) => r.str).join("");
    if (!text.trim()) return;
    const visible = group.filter((r) => r.str.trim());
    const pts = group.flatMap((r) => r.quad);
    const rect = rectOfPoints(pts);
    const first = group[0];
    const fontSize = median(visible.map((r) => r.fontSize));
    const starts = group.map((r) => offsets?.get(r.index) ?? -1).filter((n) => n >= 0);
    const last = group[group.length - 1];
    const lastStart = offsets?.get(last.index) ?? -1;
    lines.push({
      key: `L${lines.length}`,
      runs: group,
      text,
      rect,
      quad: quadFromRect(rect),
      origin: first.origin,
      fontSize,
      angle: first.angle,
      fontFamily: visible[0].fontFamily,
      bold: visible.every((r) => r.bold),
      italic: visible.every((r) => r.italic),
      charStart: starts.length ? Math.min(...starts) : -1,
      charEnd: lastStart >= 0 ? lastStart + last.str.length : -1,
    });
  };

  /**
   * One baseline → one or more lines: runs further apart than about an em —
   * a column gutter, a table cell (pdf.js fills those gaps with a wide
   * synthetic space) — are separate lines. Word spaces, even justified ones,
   * stay well under that.
   */
  const flush = (group: TextRun[]) => {
    if (!group.length) return;
    group.sort((a, b) => along(a, a.origin) - along(a, b.origin));
    let seg: TextRun[] = [];
    let end = -Infinity;
    for (const r of group) {
      const em = Math.max(r.fontSize, 1);
      const start = along(group[0], r.origin);
      const blank = !r.str.trim();
      if (blank && r.width > em * GAP_EM) {
        // A synthetic gap filler: a separator, not text.
        emit(seg);
        seg = [];
        end = -Infinity;
        continue;
      }
      if (seg.length && start - end > em * GAP_EM) {
        emit(seg);
        seg = [];
      }
      seg.push(r);
      end = Math.max(end, start + r.width);
    }
    emit(seg);
  };

  let group: TextRun[] = [];
  for (const r of sorted) {
    if (!group.length) {
      group = [r];
      continue;
    }
    const ref = group[0];
    const sameAngle = Math.abs(normalizeAngle(r.angle - ref.angle)) < 0.05;
    const tol = Math.max(2.2, ref.fontSize * 0.55);
    if (sameAngle && Math.abs(r.origin.y - ref.origin.y) <= tol) group.push(r);
    else {
      flush(group);
      group = [r];
    }
  }
  flush(group);
  return lines;
}

/** Gap (in em) beyond which two runs on one baseline are separate lines. */
const GAP_EM = 1.0;

/** Position of `p` along the writing direction of `ref`. */
function along(ref: TextRun, p: Pt): number {
  return p.x * ref.dir.x + p.y * ref.dir.y;
}

/**
 * Group lines into paragraph-like blocks — what the real text editor edits
 * (editing a whole paragraph is what lets text reflow). Column-aware: a line
 * joins the open block directly above it that it overlaps horizontally, not
 * merely the previous line in top-to-bottom order, so two columns or table
 * columns never interleave. A block ends where the line spacing opens up
 * (paragraph spacing), the size changes, or a bold line follows regular text
 * (a heading followed by its paragraph, or the reverse).
 */
export function groupBlocks(lines: readonly TextLine[]): TextBlock[] {
  interface Open {
    lines: TextLine[];
    leading: number | null;
  }
  const done: Open[] = [];
  let open: Open[] = [];

  const ordered = lines.slice().sort((a, b) => a.origin.y - b.origin.y || a.origin.x - b.origin.x);
  for (const l of ordered) {
    let best: Open | null = null;
    let bestOverlap = 0;
    const still: Open[] = [];
    for (const b of open) {
      const prev = b.lines[b.lines.length - 1];
      const gap = l.origin.y - prev.origin.y;
      // Too far below: this block is finished.
      if (gap > prev.fontSize * 3) {
        done.push(b);
        continue;
      }
      still.push(b);
      const sizeOk = Math.abs(l.fontSize - prev.fontSize) <= Math.max(0.6, prev.fontSize * 0.22);
      const firstGapOk = gap > 0 && gap <= prev.fontSize * 2.1;
      const leadingOk = b.leading === null || gap <= b.leading * 1.3 + 0.5;
      const overlap = Math.min(l.rect.x + l.rect.w, prev.rect.x + prev.rect.w) - Math.max(l.rect.x, prev.rect.x);
      const overlapOk = overlap > Math.min(l.rect.w, prev.rect.w) * 0.35;
      const angleOk = Math.abs(normalizeAngle(l.angle - prev.angle)) < 0.05;
      const styleOk = l.bold === b.lines.every((x) => x.bold) || b.lines.length === 0;
      if (sizeOk && firstGapOk && leadingOk && overlapOk && angleOk && styleOk && overlap > bestOverlap) {
        best = b;
        bestOverlap = overlap;
      }
    }
    open = still;
    if (best) {
      const prev = best.lines[best.lines.length - 1];
      const gap = l.origin.y - prev.origin.y;
      best.leading = best.leading === null ? gap : best.leading;
      best.lines.push(l);
    } else {
      open.push({ lines: [l], leading: null });
    }
  }
  done.push(...open);

  // Reading order: top to bottom, then left to right (the left column first
  // when two blocks start on the same baseline).
  done.sort((a, b) => a.lines[0].origin.y - b.lines[0].origin.y || a.lines[0].origin.x - b.lines[0].origin.x);
  return done.map((b, i) => blockOf(b.lines, `B${i}`));
}

function blockOf(cur: readonly TextLine[], key: string): TextBlock {
  const rect = cur.reduce<Rect | null>((acc, l) => {
    if (!acc) return { ...l.rect };
    const x = Math.min(acc.x, l.rect.x);
    const y = Math.min(acc.y, l.rect.y);
    return {
      x,
      y,
      w: Math.max(acc.x + acc.w, l.rect.x + l.rect.w) - x,
      h: Math.max(acc.y + acc.h, l.rect.y + l.rect.h) - y,
    };
  }, null)!;
  const gaps: number[] = [];
  for (let i = 1; i < cur.length; i++) gaps.push(cur[i].origin.y - cur[i - 1].origin.y);
  const fontSize = median(cur.map((l) => l.fontSize));
  return {
    key,
    lines: cur.slice(),
    rect,
    text: cur.map((l) => l.text).join("\n"),
    fontSize,
    leading: gaps.length ? median(gaps) : fontSize * 1.2,
    align: guessAlign(cur, rect),
    fontFamily: cur[0].fontFamily,
    bold: cur.every((l) => l.bold),
    italic: cur.every((l) => l.italic),
  };
}

function guessAlign(lines: readonly TextLine[], rect: Rect): TextBlock["align"] {
  if (lines.length < 2) return "left";
  const lefts = lines.map((l) => l.rect.x);
  const rights = lines.map((l) => l.rect.x + l.rect.w);
  const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
  const tol = Math.max(2.5, median(lines.map((l) => l.fontSize)) * 0.3);
  const leftTight = spread(lefts) < tol;
  const rightTight = spread(rights) < tol;
  // Justified: every line but the last (which ends where it ends) fills the width.
  const body = rights.slice(0, -1);
  if (leftTight && body.length >= 2 && spread(body) < tol && rights[rights.length - 1] <= Math.max(...body) + tol) {
    return "justify";
  }
  if (leftTight && rightTight) return lines.length > 2 ? "justify" : "left";
  if (rightTight && !leftTight) return "right";
  if (!leftTight && !rightTight) {
    const centers = lines.map((l) => l.rect.x + l.rect.w / 2);
    if (spread(centers) < tol && Math.abs(median(centers) - (rect.x + rect.w / 2)) < tol) return "center";
  }
  return "left";
}

function normalizeAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Character offset of each item inside the string produced by `joinItems`,
 * keyed by item index. Lets a search hit computed on the flat page text be
 * mapped back to concrete runs (and therefore to quads).
 */
export function runOffsets(items: readonly TextItemLike[]): Map<number, number> {
  const map = new Map<number, number>();
  let at = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (typeof it.str !== "string" || !it.str) {
      if (it.hasEOL) at += 1;
      continue;
    }
    map.set(i, at);
    at += it.str.length;
    if (it.hasEOL) at += 1;
  }
  return map;
}

/**
 * Quads covering characters `[start, end)` of the flat page text. Character
 * positions inside a run are interpolated across its advance width — exact for
 * monospaced text and visually indistinguishable for proportional text at the
 * sizes highlights are drawn at.
 */
export function quadsForCharRange(
  runs: readonly TextRun[],
  items: readonly TextItemLike[],
  start: number,
  end: number,
): Quad[] {
  const offsets = runOffsets(items);
  const quads: Quad[] = [];
  for (const run of runs) {
    const at = offsets.get(run.index);
    if (at == null) continue;
    const runEnd = at + run.str.length;
    if (runEnd <= start || at >= end) continue;
    const from = Math.max(0, start - at);
    const to = Math.min(run.str.length, end - at);
    if (to <= from) continue;
    const per = run.width / (run.str.length || 1);
    const x0 = from * per;
    const x1 = to * per;
    const a = ASCENT * run.fontSize;
    const d = DESCENT * run.fontSize;
    const base = { x: run.origin.x + run.dir.x * x0, y: run.origin.y + run.dir.y * x0 };
    const len = x1 - x0;
    const tl: Pt = { x: base.x + run.up.x * a, y: base.y + run.up.y * a };
    const tr: Pt = { x: tl.x + run.dir.x * len, y: tl.y + run.dir.y * len };
    const bl: Pt = { x: base.x - run.up.x * d, y: base.y - run.up.y * d };
    const br: Pt = { x: bl.x + run.dir.x * len, y: bl.y + run.dir.y * len };
    quads.push([tl, tr, br, bl]);
  }
  return mergeQuads(quads);
}

/**
 * Merge quads that sit on the same line and touch, so a highlight over a
 * sentence is one clean band instead of a row of per-item slivers.
 */
export function mergeQuads(quads: readonly Quad[]): Quad[] {
  if (quads.length < 2) return quads.slice();
  const out: Quad[] = [];
  let cur: Quad | null = null;
  for (const q of quads) {
    if (!cur) {
      cur = q;
      continue;
    }
    const a = rectOfPoints(cur);
    const b = rectOfPoints(q);
    const sameLine = Math.abs(a.y - b.y) < Math.max(1.5, a.h * 0.35) && Math.abs(a.h - b.h) < Math.max(2, a.h * 0.5);
    const touching = b.x <= a.x + a.w + Math.max(1.5, a.h * 0.35) && b.x + b.w >= a.x - 1;
    if (sameLine && touching) {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const r: Rect = {
        x,
        y,
        w: Math.max(a.x + a.w, b.x + b.w) - x,
        h: Math.max(a.y + a.h, b.y + b.h) - y,
      };
      cur = quadFromRect(r);
    } else {
      out.push(cur);
      cur = q;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// DOM selection -> page-space quads
// ---------------------------------------------------------------------------

/**
 * Convert the live DOM selection to page-space quads for one page element.
 * Returns an empty array when the selection does not intersect this page — so
 * a selection spanning several pages can simply be run through every visible
 * page in turn.
 */
export function quadsFromSelection(
  selection: Selection | null,
  pageEl: HTMLElement,
  textLayer: HTMLElement,
  scale: number,
  size: Size,
  rotation: Rotation,
): Quad[] {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return [];
  const quads: Quad[] = [];
  const host = pageEl.getBoundingClientRect();
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    if (!range.intersectsNode(textLayer)) continue;
    // Clip the (possibly multi-page) range to this page's text layer.
    const clipped = range.cloneRange();
    try {
      if (!textLayer.contains(range.startContainer)) clipped.setStart(textLayer, 0);
      if (!textLayer.contains(range.endContainer)) clipped.setEnd(textLayer, textLayer.childNodes.length);
    } catch {
      continue;
    }
    quads.push(...quadsFromClientRects(clipped.getClientRects(), host, scale, size, rotation));
  }
  return mergeQuads(quads);
}

/** Client rects (viewport px) → page-space quads. */
export function quadsFromClientRects(
  rects: DOMRectList | DOMRect[],
  host: DOMRect,
  scale: number,
  size: Size,
  rotation: Rotation,
): Quad[] {
  const out: Quad[] = [];
  for (const r of Array.from(rects)) {
    if (r.width < 0.4 || r.height < 0.4) continue;
    const view: Rect = {
      x: (r.left - host.left) / scale,
      y: (r.top - host.top) / scale,
      w: r.width / scale,
      h: r.height / scale,
    };
    out.push(quadFromRect(rectFromView(view, size, rotation)));
  }
  return mergeQuads(out);
}

/** Plain text of the current selection restricted to one text layer. */
export function selectionTextIn(selection: Selection | null, textLayer: HTMLElement): string {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  let out = "";
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    if (!range.intersectsNode(textLayer)) continue;
    const clipped = range.cloneRange();
    try {
      if (!textLayer.contains(range.startContainer)) clipped.setStart(textLayer, 0);
      if (!textLayer.contains(range.endContainer)) clipped.setEnd(textLayer, textLayer.childNodes.length);
    } catch {
      continue;
    }
    out += clipped.toString();
  }
  return out;
}

/**
 * The real fonts of a page's text, by pdf.js font id (see `PdfEngine.fonts`):
 * the operator list is loaded so the fonts reach the main thread.
 */
export async function pageFontFacts(
  page: { getOperatorList(o?: object): Promise<unknown>; commonObjs: unknown },
  tc: TextContentLike,
): Promise<Map<string, FontFacts>> {
  await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE });
  const objs = page.commonObjs as { has(id: string): boolean; get(id: string): unknown };
  const out = new Map<string, FontFacts>();
  for (const it of (tc.items ?? []) as { fontName?: string }[]) {
    const id = it.fontName;
    if (!id || out.has(id) || !objs.has(id)) continue;
    const font = objs.get(id) as { name?: string; bold?: boolean; italic?: boolean; black?: boolean } | null;
    if (!font) continue;
    const name = font.name ?? "";
    out.set(id, {
      name,
      bold: !!font.bold || !!font.black || /bold|black|heavy|semibold|demi/i.test(name),
      italic: !!font.italic || /italic|oblique/i.test(name),
    });
  }
  return out;
}
