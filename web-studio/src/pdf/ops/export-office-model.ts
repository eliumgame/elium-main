/**
 * « Exporter un PDF » — the document analysis shared by the Word, RTF and
 * PowerPoint exports (see export-office.ts).
 *
 * The layout (`extractLayout`) only knows lines and paragraph-shaped blocks.
 * This module turns it into a neutral, format-agnostic model an office writer
 * can consume directly:
 *
 * - tables recovered with their GEOMETRY (the same detection as `detectTables`,
 *   which only returns strings) so their lines leave the flowing text and the
 *   table lands where it sat on the page;
 * - a column-aware reading order (recursive XY cut: two columns under a
 *   full-width title read column by column, not line by line across);
 * - headings ranked by font size relative to the body text, then bold
 *   stand-alone lines;
 * - lists (« • », « – », « 1. », « a) »…) with their wrapped continuation lines;
 * - inline runs (bold, italic, font, size) with word spaces rebuilt from the
 *   geometry, hyphenation undone across lines, and external links carried by
 *   the Link annotations that cover them;
 * - image placements from the operator list, so the caller may rasterise crops.
 *
 * Everything here is pure except `collectPageMeta`, which reads the engine.
 */

import type { PdfEngine } from "../core/engine";
import type { Rect } from "../core/coords";
import type { TextBlock, TextLine, TextRun } from "../core/text";
import { pdfjs } from "../core/pdfjs";
import type { PageText } from "./export";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type OfficeAlign = TextBlock["align"];

/** An inline run of text sharing one formatting. Sizes are in points. */
export interface OfficeRun {
  text: string;
  bold: boolean;
  italic: boolean;
  fontFamily?: string;
  fontSize: number;
  /** External link target, from a Link annotation covering the run. */
  href?: string;
}

export interface OfficeParagraph {
  kind: "paragraph";
  runs: OfficeRun[];
  align: OfficeAlign;
  rect: Rect;
  fontSize: number;
  /** Left indent relative to the page's text column, in points. */
  indent: number;
  /** First-line offset relative to the following lines, in points (negative: hanging). */
  firstLine: number;
}

export interface OfficeHeading {
  kind: "heading";
  level: 1 | 2 | 3;
  runs: OfficeRun[];
  align: OfficeAlign;
  rect: Rect;
  fontSize: number;
}

export interface OfficeListItem {
  /** The marker as printed (« • », « 1. », « a) »). */
  marker: string;
  runs: OfficeRun[];
}

export interface OfficeList {
  kind: "list";
  ordered: boolean;
  items: OfficeListItem[];
  rect: Rect;
  fontSize: number;
}

export interface OfficeTableCell {
  text: string;
  bold: boolean;
}

export interface OfficeTable {
  kind: "table";
  rows: OfficeTableCell[][];
  /** Left edge of each column, page space. */
  columns: number[];
  rect: Rect;
  fontSize: number;
}

export interface OfficeImage {
  kind: "image";
  rect: Rect;
}

export type OfficeItem = OfficeParagraph | OfficeHeading | OfficeList | OfficeTable | OfficeImage;

export interface OfficePage {
  /** 0-based page index. */
  page: number;
  /** Page size in points (unrotated crop box, the layout's own space). */
  w: number;
  h: number;
  /** Items in reading order. */
  items: OfficeItem[];
}

export interface OfficeDocument {
  pages: OfficePage[];
  /** The body text size in points (most characters set in it). */
  bodySize: number;
}

/** What the engine knows about a page besides its text. */
export interface PageLink {
  rect: Rect;
  url: string;
}

export interface PageMeta {
  page: number;
  w: number;
  h: number;
  links: PageLink[];
  /** Placements of painted images, page space (y down). */
  images: Rect[];
}

// ---------------------------------------------------------------------------
// Engine reads
// ---------------------------------------------------------------------------

type Matrix = [number, number, number, number, number, number];

/** Page geometry, external links and image placements for every page of the layout. */
export async function collectPageMeta(
  engine: PdfEngine,
  layout: readonly PageText[],
  opts: { images?: boolean; links?: boolean } = {},
): Promise<PageMeta[]> {
  const out: PageMeta[] = [];
  for (const p of layout) {
    const page = await engine.page(p.page);
    // The layout is built at rotation 0: everything here is in that same space.
    const vp = page.getViewport({ scale: 1, rotation: 0 });
    const toPage = vp.transform as unknown as Matrix;
    const links: PageLink[] = [];
    if (opts.links !== false) {
      for (const raw of await engine.annotations(p.page)) {
        const a = raw as { subtype?: string; rect?: number[]; url?: string; unsafeUrl?: string };
        const url = a.url || a.unsafeUrl;
        if (a.subtype !== "Link" || !url || !a.rect || a.rect.length < 4) continue;
        links.push({ rect: transformRect(toPage, a.rect), url });
      }
    }
    let images: Rect[] = [];
    if (opts.images !== false) {
      try {
        const ops = (await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE })) as {
          fnArray: number[];
          argsArray: unknown[][];
        };
        images = imagePlacements(ops.fnArray, ops.argsArray).map((m) => transformRect(toPage, unitRect(m)));
      } catch {
        images = [];
      }
    }
    out.push({ page: p.page, w: vp.width, h: vp.height, links, images });
  }
  return out;
}

const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/** The unit square an image is painted into, through its CTM, as [x1, y1, x2, y2]. */
function unitRect(m: Matrix): number[] {
  const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** A PDF-space [x1, y1, x2, y2] rectangle into page space (y down). */
function transformRect(m: Matrix, r: readonly number[]): Rect {
  const a = apply(m, r[0], r[1]);
  const b = apply(m, r[2], r[3]);
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return { x, y, w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

/**
 * Walk an operator list and return the CTM of every painted image (PDF user
 * space). Forms push their own matrix; everything else is save / restore /
 * transform bookkeeping.
 */
export function imagePlacements(fnArray: readonly number[], argsArray: readonly unknown[][]): Matrix[] {
  const OPS = pdfjs.OPS;
  const out: Matrix[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] ?? [];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args as unknown as Matrix);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args[0] as Matrix | null | undefined;
      if (Array.isArray(m) && m.length === 6) ctm = mul(ctm, m);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      out.push(ctm);
    } else if (fn === OPS.paintImageXObjectRepeat) {
      const [, sx, sy, positions] = args as [unknown, number, number, number[]];
      for (let k = 0; k + 1 < (positions?.length ?? 0); k += 2) {
        out.push(mul(ctm, [sx, 0, 0, sy, positions[k], positions[k + 1]]));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tables with geometry
// ---------------------------------------------------------------------------

/** A visual row: the lines of one baseline, merged (a table row is all of them). */
export interface VisualRow {
  line: TextLine;
  parts: TextLine[];
}

export interface TableRegion {
  page: number;
  rows: OfficeTableCell[][];
  columns: number[];
  rect: Rect;
  /** Keys of the layout lines the table consumed. */
  lineKeys: Set<string>;
  fontSize: number;
}

/**
 * Page lines rejoined into visual rows — the same grouping `detectTables`
 * uses, keeping the source lines so a table can take them out of the flow.
 */
export function visualRows(lines: readonly TextLine[]): VisualRow[] {
  const horizontal = lines.filter((l) => Math.abs(l.angle) < 1);
  const sorted = [...horizontal].sort((a, b) => a.origin.y - b.origin.y || a.origin.x - b.origin.x);
  const rows: TextLine[][] = [];
  for (const l of sorted) {
    const row = rows[rows.length - 1];
    const ref = row?.[0];
    if (ref && Math.abs(l.origin.y - ref.origin.y) < Math.max(ref.fontSize, l.fontSize) * 0.4) row.push(l);
    else rows.push([l]);
  }
  return rows.map((row) => {
    if (row.length === 1) return { line: row[0], parts: row };
    const parts = [...row].sort((a, b) => a.origin.x - b.origin.x);
    return {
      line: {
        ...parts[0],
        runs: parts.flatMap((p) => p.runs),
        text: parts.map((p) => p.text).join(" "),
        fontSize: Math.max(...parts.map((p) => p.fontSize)),
        rect: unionRects(parts.map((p) => p.rect)),
      },
      parts,
    };
  });
}

function countGaps(line: TextLine): number {
  let gaps = 0;
  for (let i = 1; i < line.runs.length; i++) {
    const prev = line.runs[i - 1];
    const cur = line.runs[i];
    if (cur.rect.x - (prev.rect.x + prev.rect.w) > prev.fontSize * 1.4) gaps++;
  }
  return gaps;
}

function columnEdges(lines: readonly TextLine[]): number[] {
  const marks: number[] = [];
  for (const l of lines) {
    for (let i = 0; i < l.runs.length; i++) {
      const prev = l.runs[i - 1];
      if (!prev || l.runs[i].rect.x - (prev.rect.x + prev.rect.w) > prev.fontSize * 1.2) marks.push(l.runs[i].rect.x);
    }
  }
  marks.sort((a, b) => a - b);
  const merged: number[] = [];
  for (const m of marks) {
    if (!merged.length || m - merged[merged.length - 1] > 6) merged.push(m);
  }
  return merged.filter(
    (edge) => lines.filter((l) => l.runs.some((r) => Math.abs(r.rect.x - edge) < 6)).length >= lines.length * 0.5,
  );
}

function splitCells(line: TextLine, columns: readonly number[]): OfficeTableCell[] {
  const cells = columns.map(() => ({ text: "", runs: [] as TextRun[] }));
  for (const run of line.runs) {
    let col = 0;
    for (let i = columns.length - 1; i >= 0; i--) {
      if (run.rect.x + 3 >= columns[i]) {
        col = i;
        break;
      }
    }
    cells[col].text += run.str;
    if (run.str.trim()) cells[col].runs.push(run);
  }
  return cells.map((c) => ({ text: c.text.trim(), bold: c.runs.length > 0 && c.runs.every((r) => r.bold) }));
}

/**
 * `detectTables` with geometry: identical rows (the same heuristics, kept in
 * step on purpose), plus each table's rectangle, column edges and source lines.
 */
export function detectTableRegions(pages: readonly PageText[], minRows = 3): TableRegion[] {
  const out: TableRegion[] = [];
  for (const p of pages) {
    let group: VisualRow[] = [];
    const flush = () => {
      if (group.length >= minRows) {
        const lines = group.map((g) => g.line);
        const columns = columnEdges(lines);
        if (columns.length >= 2) {
          const rows = lines.map((l) => splitCells(l, columns));
          const cells = rows.flat().filter((c) => c.text);
          const mean = cells.reduce((n, c) => n + c.text.length, 0) / Math.max(1, cells.length);
          if (mean <= 28) {
            const parts = group.flatMap((g) => g.parts);
            out.push({
              page: p.page,
              rows,
              columns,
              rect: unionRects(parts.map((l) => l.rect)),
              lineKeys: new Set(parts.map((l) => l.key)),
              fontSize: median(lines.map((l) => l.fontSize)),
            });
          }
        }
      }
      group = [];
    };
    for (const row of visualRows(p.lines)) {
      if (countGaps(row.line) >= 1) {
        const prev = group[group.length - 1];
        if (!prev || Math.abs(row.line.origin.y - prev.line.origin.y) < prev.line.fontSize * 3) group.push(row);
        else {
          flush();
          group = [row];
        }
      } else {
        flush();
      }
    }
    flush();
  }
  return out;
}

/** A line split on its wide gaps (column gutters), each cell's text rebuilt with word spaces. */
export function splitOnGaps(line: TextLine): string[] {
  const cells: TextRun[][] = [];
  for (const run of line.runs) {
    const cur = cells[cells.length - 1];
    const prev = cur?.[cur.length - 1];
    if (!cur || !prev || run.rect.x - (prev.rect.x + prev.rect.w) > prev.fontSize * 1.2) cells.push([run]);
    else cur.push(run);
  }
  return cells.map((runs) => normalizeSpaces(joinRunTexts(runs))).filter((c) => c !== "");
}

// ---------------------------------------------------------------------------
// Inline runs
// ---------------------------------------------------------------------------

const SPACE_EM = 0.18;

/** Plain text of runs with word spaces rebuilt from the gaps between them. */
function joinRunTexts(runs: readonly TextRun[]): string {
  let out = "";
  let prev: TextRun | null = null;
  for (const r of runs) {
    if (prev && needsSpace(prev, r, out)) out += " ";
    out += r.str;
    if (r.str.trim()) prev = r;
  }
  return out;
}

function needsSpace(prev: TextRun, cur: TextRun, sofar: string): boolean {
  if (/\s$/.test(sofar) || /^\s/.test(cur.str)) return false;
  const gap = cur.rect.x - (prev.rect.x + prev.rect.w);
  return gap > Math.max(prev.fontSize, cur.fontSize) * SPACE_EM;
}

const normalizeSpaces = (s: string) => s.replace(/[\s ]+/g, " ").trim();

const roundSize = (n: number) => Math.round(n * 2) / 2;

const sameStyle = (a: OfficeRun, b: OfficeRun) =>
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.fontFamily === b.fontFamily &&
  a.fontSize === b.fontSize &&
  a.href === b.href;

/** The link covering a point, if any (a little slack: link boxes are drawn tight). */
function linkAt(links: readonly PageLink[], x: number, y: number): string | undefined {
  for (const l of links) {
    if (x >= l.rect.x - 1 && x <= l.rect.x + l.rect.w + 1 && y >= l.rect.y - 2 && y <= l.rect.y + l.rect.h + 2) {
      return l.url;
    }
  }
  return undefined;
}

/** Rough relative advance of a character (Helvetica-like): enough to place glyphs along a run. */
function charWeight(ch: string): number {
  if (/[\s.,;:!'|iljtfI]/.test(ch)) return 0.28;
  if (/[r()\-/]/.test(ch)) return 0.36;
  if (/[mwMW@%]/.test(ch)) return 0.85;
  if (/[A-Z&]/.test(ch)) return 0.68;
  return 0.55;
}

/**
 * One text run → formatted pieces, split where a link starts or ends. Glyph
 * positions are estimated along the run's advance width (pdf.js does not
 * give them), then snapped to whole words: a word takes the link most of its
 * characters fall in, and a space is linked only between two linked words.
 */
function runPieces(r: TextRun, links: readonly PageLink[]): OfficeRun[] {
  const base: Omit<OfficeRun, "text"> = {
    bold: r.bold,
    italic: r.italic,
    fontFamily: r.fontFamily,
    fontSize: roundSize(r.fontSize),
  };
  if (!links.length) return [{ ...base, text: r.str }];
  const cy = r.rect.y + r.rect.h / 2;
  const chars = [...r.str];
  const weights = chars.map(charWeight);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  const hrefs = chars.map((_, i) => {
    const mid = r.rect.x + (r.rect.w * (acc + weights[i] / 2)) / total;
    acc += weights[i];
    return linkAt(links, mid, cy);
  });
  const blank = (i: number) => /\s/.test(chars[i]);
  for (let i = 0; i < chars.length;) {
    if (blank(i)) {
      i++;
      continue;
    }
    let j = i;
    const votes = new Map<string | undefined, number>();
    while (j < chars.length && !blank(j)) {
      votes.set(hrefs[j], (votes.get(hrefs[j]) ?? 0) + 1);
      j++;
    }
    const winner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    for (let k = i; k < j; k++) hrefs[k] = winner;
    i = j;
  }
  for (let i = 0; i < chars.length; i++) {
    if (!blank(i)) continue;
    let a = i - 1;
    while (a >= 0 && blank(a)) a--;
    let b = i + 1;
    while (b < chars.length && blank(b)) b++;
    hrefs[i] = a >= 0 && b < chars.length && hrefs[a] === hrefs[b] ? hrefs[a] : undefined;
  }
  const out: OfficeRun[] = [];
  chars.forEach((ch, i) => {
    const href = hrefs[i];
    const last = out[out.length - 1];
    if (last && last.href === href) last.text += ch;
    else out.push({ ...base, text: ch, ...(href ? { href } : {}) });
  });
  return out;
}

/** The formatted runs of a sequence of lines, joined as one paragraph. */
export function linesToRuns(lines: readonly TextLine[], links: readonly PageLink[]): OfficeRun[] {
  const out: OfficeRun[] = [];
  const push = (piece: OfficeRun) => {
    if (!piece.text) return;
    const last = out[out.length - 1];
    if (last && sameStyle(last, piece)) last.text += piece.text;
    else out.push({ ...piece });
  };
  const tail = () => out[out.length - 1]?.text ?? "";
  lines.forEach((line, li) => {
    if (li > 0 && out.length) {
      // Across a line break: undo hyphenation, else a word space.
      const last = out[out.length - 1];
      const next = line.text.trimStart();
      if (/\u00ad\s*$/.test(last.text)) last.text = last.text.replace(/\u00ad\s*$/, "");
      else if (/\p{L}-\s*$/u.test(last.text)) {
        if (/^\p{Ll}/u.test(next)) last.text = last.text.replace(/-\s*$/, "");
        else last.text = last.text.replace(/\s+$/, "");
      } else if (!/\s$/.test(last.text)) push({ ...last, text: " ", href: undefined });
    }
    let prev: TextRun | null = null;
    for (const r of line.runs) {
      const pieces = runPieces(r, links);
      const last = out[out.length - 1];
      if (prev && last && needsSpace(prev, r, tail())) {
        // The space belongs to a link only when the link goes on after it.
        const href = last.href && pieces[0]?.href === last.href ? last.href : undefined;
        push({ ...last, text: " ", href });
      }
      for (const piece of pieces) push(piece);
      if (r.str.trim()) prev = r;
    }
  });
  // Collapse whitespace across run boundaries and trim the ends.
  let prevSpace = true;
  for (const r of out) {
    let t = r.text.replace(/[\s ]+/g, " ");
    if (prevSpace) t = t.replace(/^ /, "");
    if (t) prevSpace = t.endsWith(" ");
    r.text = t;
  }
  const kept = out.filter((r) => r.text);
  if (kept.length) kept[kept.length - 1].text = kept[kept.length - 1].text.replace(/ $/, "");
  // A space between a bold (italic, linked) word and plain text belongs to the plain side.
  const styled = (r: OfficeRun) => (r.bold ? 1 : 0) + (r.italic ? 1 : 0) + (r.href ? 1 : 0);
  for (let i = 0; i + 1 < kept.length; i++) {
    const a = kept[i];
    const b = kept[i + 1];
    if (a.text.endsWith(" ") && styled(a) > styled(b) && !b.text.startsWith(" ")) {
      a.text = a.text.slice(0, -1);
      b.text = ` ${b.text}`;
    } else if (b.text.startsWith(" ") && styled(b) > styled(a) && !a.text.endsWith(" ")) {
      b.text = b.text.slice(1);
      a.text = `${a.text} `;
    }
  }
  return kept.filter((r) => r.text);
}

export const runsText = (runs: readonly OfficeRun[]) => runs.map((r) => r.text).join("");

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

const BULLET_RE = /^([•◦▪▫‣⁃●○■□►▸➢✓✔·*]\s*|[-–—]\s+)(?=\S)/u;
const ORDERED_RE = /^((?:\d{1,3}|[a-zA-Z]|[ivxlcdm]{1,5}|[IVXLCDM]{1,5})[.)]|\((?:\d{1,3}|[a-zA-Z])\))\s+(?=\S)/;

/** The list marker a line starts with, if any. */
export function listMarker(text: string): { marker: string; ordered: boolean; length: number } | null {
  const t = text.trimStart();
  const lead = text.length - t.length;
  const b = BULLET_RE.exec(t);
  if (b) return { marker: b[1].trim(), ordered: false, length: lead + b[0].length };
  const o = ORDERED_RE.exec(t);
  if (o) return { marker: o[1], ordered: true, length: lead + o[0].length };
  return null;
}

/** Drop the first `count` characters of a run list (the list marker). */
function dropChars(runs: OfficeRun[], count: number): OfficeRun[] {
  let left = count;
  const out: OfficeRun[] = [];
  for (const r of runs) {
    if (left <= 0) out.push(r);
    else if (r.text.length <= left) left -= r.text.length;
    else {
      out.push({ ...r, text: r.text.slice(left) });
      left = 0;
    }
  }
  if (out.length) out[0] = { ...out[0], text: out[0].text.trimStart() };
  return out.filter((r) => r.text);
}

// ---------------------------------------------------------------------------
// Reading order (recursive XY cut)
// ---------------------------------------------------------------------------

interface Placed {
  rect: Rect;
}

/**
 * Columns: groups separated by a vertical gutter running through the whole
 * region, each at least a fifth of its width (a narrow label next to its value
 * is not a column).
 */
function xCut<T extends Placed>(units: readonly T[]): T[][] | null {
  if (units.length < 2) return null;
  const sorted = [...units].sort((a, b) => a.rect.x - b.rect.x);
  const groups: T[][] = [];
  let end = -Infinity;
  for (const u of sorted) {
    if (groups.length && u.rect.x > end + 4) groups.push([u]);
    else if (groups.length) groups[groups.length - 1].push(u);
    else groups.push([u]);
    end = Math.max(end, u.rect.x + u.rect.w);
  }
  if (groups.length < 2) return null;
  const whole = unionRects(units.map((u) => u.rect));
  const wideEnough = groups.every((g) => unionRects(g.map((u) => u.rect)).w >= whole.w * 0.2);
  return wideEnough ? groups : null;
}

/** Horizontal bands separated by a vertical gap no unit spans. */
function yBands<T extends Placed>(units: readonly T[]): T[][] {
  const sorted = [...units].sort((a, b) => a.rect.y - b.rect.y);
  const bands: T[][] = [];
  let end = -Infinity;
  for (const u of sorted) {
    if (bands.length && u.rect.y > end - 0.5) bands.push([u]);
    else if (bands.length) bands[bands.length - 1].push(u);
    else bands.push([u]);
    end = Math.max(end, u.rect.y + u.rect.h);
  }
  return bands;
}

/**
 * Reading order: columns first, else bands top to bottom — where consecutive
 * bands sharing one column gutter are merged back so a two-column body whose
 * paragraph gaps happen to line up is still read column by column.
 */
export function readingOrder<T extends Placed>(units: readonly T[]): T[] {
  return orderWithColumns(units, units.length ? Math.min(...units.map((u) => u.rect.x)) : 0).map((o) => o.unit);
}

/** `readingOrder`, telling for each unit the left edge of the column it was read in. */
export function orderWithColumns<T extends Placed>(units: readonly T[], left: number): { unit: T; left: number }[] {
  if (units.length <= 1) return units.map((unit) => ({ unit, left }));
  const cols = xCut(units);
  if (cols) return cols.flatMap((c) => orderWithColumns(c, Math.min(...c.map((u) => u.rect.x))));
  const bands = yBands(units);
  if (bands.length > 1) {
    const merged: T[][] = [];
    for (const band of bands) {
      const last = merged[merged.length - 1];
      if (last && xCut(last) && xCut([...last, ...band])) last.push(...band);
      else merged.push([...band]);
    }
    if (merged.length > 1) return merged.flatMap((m) => orderWithColumns(m, left));
  }
  return [...units].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x).map((unit) => ({ unit, left }));
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** A run of consecutive lines of one block, before classification. */
interface Segment {
  kind: "text" | "item";
  lines: TextLine[];
  marker?: { marker: string; ordered: boolean; length: number };
}

export interface AnalyseOptions {
  /** Keep image placements as items (only useful when the caller can rasterise them). */
  images?: boolean;
}

/**
 * Build the office model from the layout and the per-page metadata
 * (`collectPageMeta`; pages without metadata fall back to the text extent).
 */
export function analyseLayout(
  layout: readonly PageText[],
  meta: readonly PageMeta[] = [],
  opts: AnalyseOptions = {},
): OfficeDocument {
  const bodySize = dominantSize(layout);
  const tables = detectTableRegions(layout);

  // Pass 1: segments per page (tables out of the flow, lists split out).
  interface Unit {
    rect: Rect;
    seg?: Segment;
    table?: TableRegion;
    image?: Rect;
  }
  const perPage = layout.map((p) => {
    const m = meta.find((x) => x.page === p.page);
    const pageTables = tables.filter((t) => t.page === p.page);
    const taken = new Set<string>();
    for (const t of pageTables) for (const k of t.lineKeys) taken.add(k);
    const units: Unit[] = pageTables.map((t) => ({ rect: t.rect, table: t }));
    for (const block of p.blocks) {
      // A table may take some of a block's lines: the rest splits into contiguous chunks.
      let chunk: TextLine[] = [];
      const chunks: TextLine[][] = [];
      for (const l of block.lines) {
        if (taken.has(l.key)) {
          if (chunk.length) chunks.push(chunk);
          chunk = [];
        } else chunk.push(l);
      }
      if (chunk.length) chunks.push(chunk);
      for (const c of chunks) for (const seg of segmentLines(c)) units.push({ rect: linesRect(seg.lines), seg });
    }
    const textArea = p.lines.reduce((n, l) => n + l.rect.w * l.rect.h, 0);
    const w = m?.w ?? Math.max(595, ...p.lines.map((l) => l.rect.x + l.rect.w));
    const h = m?.h ?? Math.max(842, ...p.lines.map((l) => l.rect.y + l.rect.h));
    if (opts.images) {
      for (const r of dedupeRects(m?.images ?? [])) {
        if (r.w < 12 || r.h < 12) continue;
        // A picture under the whole page is a background (or a scan with OCR text).
        if (textArea > 0 && r.w * r.h >= w * h * 0.85) continue;
        const clipped = clipRect(r, { x: 0, y: 0, w, h });
        if (clipped) units.push({ rect: clipped, image: clipped });
      }
    }
    const left = Math.min(...p.lines.filter((l) => !taken.has(l.key)).map((l) => l.rect.x), w);
    return { p, m, w, h, units, left: Number.isFinite(left) ? left : 0 };
  });

  // Heading sizes, ranked over the whole document.
  const headingSizes = new Set<number>();
  for (const pg of perPage) {
    for (const u of pg.units) {
      if (u.seg?.kind !== "text") continue;
      const size = roundSize(median(u.seg.lines.map((l) => l.fontSize)));
      if (isHeadingBySize(u.seg, size, bodySize)) headingSizes.add(size);
    }
  }
  const ranked = [...headingSizes].sort((a, b) => b - a);
  const levelOf = (size: number): 1 | 2 | 3 => Math.min(3, ranked.indexOf(size) + 1) as 1 | 2 | 3;
  const boldLevel = Math.min(3, ranked.length + 1) as 1 | 2 | 3;

  // Pass 2: items in reading order.
  const pages: OfficePage[] = perPage.map((pg) => {
    const links = pg.m?.links ?? [];
    const items: OfficeItem[] = [];
    for (const { unit: u, left: columnLeft } of orderWithColumns(pg.units, pg.left)) {
      if (u.table) {
        items.push({
          kind: "table",
          rows: u.table.rows,
          columns: u.table.columns,
          rect: u.table.rect,
          fontSize: roundSize(u.table.fontSize),
        });
        continue;
      }
      if (u.image) {
        items.push({ kind: "image", rect: u.image });
        continue;
      }
      const seg = u.seg!;
      const size = roundSize(median(seg.lines.map((l) => l.fontSize)));
      if (seg.kind === "item") {
        const runs = dropChars(linesToRuns(seg.lines, links), seg.marker!.length);
        if (!runs.length) continue;
        const item: OfficeListItem = { marker: seg.marker!.marker, runs };
        const prev = items[items.length - 1];
        // Consecutive items of one kind, stacked in one column, make one list.
        if (
          prev?.kind === "list" &&
          prev.ordered === seg.marker!.ordered &&
          u.rect.y - (prev.rect.y + prev.rect.h) < Math.max(size, prev.fontSize) * 2.5 &&
          overlapX(prev.rect, u.rect) > 0
        ) {
          prev.items.push(item);
          prev.rect = unionRects([prev.rect, u.rect]);
        } else {
          items.push({ kind: "list", ordered: seg.marker!.ordered, items: [item], rect: u.rect, fontSize: size });
        }
        continue;
      }
      const runs = linesToRuns(seg.lines, links);
      if (!runs.length) continue;
      const align = alignOf(seg.lines, u.rect);
      if (isHeadingBySize(seg, size, bodySize)) {
        items.push({ kind: "heading", level: levelOf(size), runs, align, rect: u.rect, fontSize: size });
      } else if (isBoldHeading(seg, runs, size, bodySize)) {
        items.push({ kind: "heading", level: boldLevel, runs, align, rect: u.rect, fontSize: size });
      } else {
        const lines = seg.lines;
        const firstLine = lines.length >= 2 ? lines[0].rect.x - lines[1].rect.x : 0;
        items.push({
          kind: "paragraph",
          runs,
          align,
          rect: u.rect,
          fontSize: size,
          indent: Math.max(0, Math.min(...lines.slice(lines.length >= 2 ? 1 : 0).map((l) => l.rect.x)) - columnLeft),
          firstLine: Math.abs(firstLine) > size * 0.5 ? firstLine : 0,
        });
      }
    }
    return { page: pg.p.page, w: pg.w, h: pg.h, items };
  });
  return { pages, bodySize };
}

/** Split a block's lines into plain text and list items (a marker line opens an item; the lines after it continue it). */
function segmentLines(lines: readonly TextLine[]): Segment[] {
  const out: Segment[] = [];
  for (const l of lines) {
    const marker = listMarker(l.text);
    const last = out[out.length - 1];
    if (marker) out.push({ kind: "item", lines: [l], marker });
    else if (last) last.lines.push(l);
    else out.push({ kind: "text", lines: [l] });
  }
  return out;
}

function isHeadingBySize(seg: Segment, size: number, body: number): boolean {
  if (size < body * 1.15) return false;
  const text = seg.lines.map((l) => l.text).join(" ");
  return seg.lines.length <= 4 && text.trim().length <= 200;
}

/** A stand-alone bold line in the body size that does not read as a sentence. */
function isBoldHeading(seg: Segment, runs: readonly OfficeRun[], size: number, body: number): boolean {
  if (seg.lines.length !== 1 || size < body * 0.95) return false;
  const text = runsText(runs).trim();
  if (!text || text.length > 90 || /[.,;:]$/.test(text)) return false;
  return runs.every((r) => r.bold || !r.text.trim());
}

/** The size most characters are set in: the body text. */
function dominantSize(layout: readonly PageText[]): number {
  const weight = new Map<number, number>();
  for (const p of layout) {
    for (const l of p.lines) {
      const s = roundSize(l.fontSize);
      weight.set(s, (weight.get(s) ?? 0) + l.text.length);
    }
  }
  let best = 11;
  let bestW = -1;
  for (const [s, w] of weight) {
    if (w > bestW || (w === bestW && s < best)) {
      best = s;
      bestW = w;
    }
  }
  return best;
}

function alignOf(lines: readonly TextLine[], rect: Rect): OfficeAlign {
  if (lines.length < 2) return "left";
  const lefts = lines.map((l) => l.rect.x);
  const rights = lines.map((l) => l.rect.x + l.rect.w);
  const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
  const tol = Math.max(2.5, median(lines.map((l) => l.fontSize)) * 0.3);
  const leftTight = spread(lefts.slice(1)) < tol;
  const body = rights.slice(0, -1);
  if (leftTight && body.length >= 2 && spread(body) < tol) return "justify";
  if (spread(rights) < tol && spread(lefts) >= tol) return "right";
  const centers = lines.map((l) => l.rect.x + l.rect.w / 2);
  if (spread(lefts) >= tol && spread(centers) < tol && Math.abs(median(centers) - (rect.x + rect.w / 2)) < tol) {
    return "center";
  }
  return "left";
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

export function unionRects(rects: readonly Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y,
  };
}

const linesRect = (lines: readonly TextLine[]) => unionRects(lines.map((l) => l.rect));

const overlapX = (a: Rect, b: Rect) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);

function clipRect(r: Rect, to: Rect): Rect | null {
  const x = Math.max(r.x, to.x);
  const y = Math.max(r.y, to.y);
  const w = Math.min(r.x + r.w, to.x + to.w) - x;
  const h = Math.min(r.y + r.h, to.y + to.h) - y;
  return w > 1 && h > 1 ? { x, y, w, h } : null;
}

function dedupeRects(rects: readonly Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of rects) {
    if (!out.some((o) => Math.abs(o.x - r.x) < 1 && Math.abs(o.y - r.y) < 1 && Math.abs(o.w - r.w) < 1)) out.push(r);
  }
  return out.slice(0, 50);
}

function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The margins the text keeps on a page, in points — what the reflowed
 * document's page setup should reproduce. Pages without text get 2 cm.
 */
export function textMargins(page: OfficePage): { top: number; right: number; bottom: number; left: number } {
  const rects = page.items.map((i) => i.rect);
  const fallback = 56.7;
  if (!rects.length) return { top: fallback, right: fallback, bottom: fallback, left: fallback };
  const u = unionRects(rects);
  const clamp = (v: number) => Math.min(113, Math.max(14, v));
  return {
    top: clamp(u.y),
    left: clamp(u.x),
    right: clamp(page.w - (u.x + u.w)),
    bottom: clamp(page.h - (u.y + u.h)),
  };
}
