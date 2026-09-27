/**
 * Comparing two PDFs — Acrobat's "Compare files".
 *
 * A word-level diff over the extracted text, aligned page by page so the
 * report says "page 4: this sentence was replaced" rather than dumping one
 * enormous diff. The alignment is itself a diff (over per-page text
 * fingerprints), so an inserted or deleted page does not desynchronise
 * everything after it. A page found elsewhere in the other document is
 * reported as moved, not removed and added.
 *
 * `compareLayouts` goes further on laid-out pages (`extractLayout`): a box for
 * each changed word on both sides, and formatting changes (font, size, bold,
 * italic, colour) of words that stayed. `compare-visual.ts` adds the picture
 * differences (images, drawings, scans) and `compare-report.ts` the PDF report.
 */

import type { Pt, Rect, Size } from "../core/coords";
import type { TextRun } from "../core/text";
import type { PageText } from "./export";

export type ChangeKind = "equal" | "insert" | "delete" | "replace";

export interface WordChange {
  kind: ChangeKind;
  /** Words from the left/original document. */
  left: string[];
  /** Words from the right/revised document. */
  right: string[];
  /** Word offset within the page, for highlighting. */
  leftAt: number;
  rightAt: number;
}

export interface PageComparison {
  /** 1-based page in the left document, or null when the page was added. */
  leftPage: number | null;
  /** 1-based page in the right document, or null when the page was removed. */
  rightPage: number | null;
  status: "unchanged" | "modified" | "added" | "removed";
  changes: WordChange[];
  /** 0..1 — how much of the page is identical. */
  similarity: number;
  /** The page is the other document's page found at another position (« déplacée »). */
  moved?: boolean;
}

export interface ComparisonReport {
  pages: PageComparison[];
  wordsAdded: number;
  wordsRemoved: number;
  pagesAdded: number;
  pagesRemoved: number;
  pagesModified: number;
  /** Pages found at another position in the revised document. */
  pagesMoved: number;
  /** 0..1 over the whole document. */
  similarity: number;
  /** Paired pages with no text on either side (scans, drawings): their text says nothing. */
  pagesWithoutText: number;
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;

export function tokenise(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

/**
 * Longest-common-subsequence diff. Falls back to a coarse, linear alignment
 * when the inputs are large enough that the O(n·m) table would be a problem —
 * a 400-page legal comparison must not hang the tab.
 */
export function diffTokens(a: readonly string[], b: readonly string[]): WordChange[] {
  if (a.length * b.length > 4_000_000) return coarseDiff(a, b);

  const n = a.length;
  const m = b.length;
  // Trim the common prefix/suffix first: most pages barely change.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const subA = a.slice(start, endA);
  const subB = b.slice(start, endB);
  const out: WordChange[] = [];
  if (start > 0) out.push({ kind: "equal", left: a.slice(0, start), right: b.slice(0, start), leftAt: 0, rightAt: 0 });

  if (subA.length && subB.length && subA.length * subB.length <= 4_000_000) {
    const table: Uint32Array = new Uint32Array((subA.length + 1) * (subB.length + 1));
    const w = subB.length + 1;
    for (let i = subA.length - 1; i >= 0; i--) {
      for (let j = subB.length - 1; j >= 0; j--) {
        table[i * w + j] =
          subA[i] === subB[j]
            ? table[(i + 1) * w + (j + 1)] + 1
            : Math.max(table[(i + 1) * w + j], table[i * w + (j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    let pending: WordChange | null = null;
    const push = (kind: ChangeKind, left: string[], right: string[], li: number, ri: number) => {
      if (pending && pending.kind === kind) {
        pending.left.push(...left);
        pending.right.push(...right);
        return;
      }
      if (pending) out.push(pending);
      pending = { kind, left: [...left], right: [...right], leftAt: start + li, rightAt: start + ri };
    };
    while (i < subA.length && j < subB.length) {
      if (subA[i] === subB[j]) {
        push("equal", [subA[i]], [subB[j]], i, j);
        i++;
        j++;
      } else if (table[(i + 1) * w + j] >= table[i * w + (j + 1)]) {
        push("delete", [subA[i]], [], i, j);
        i++;
      } else {
        push("insert", [], [subB[j]], i, j);
        j++;
      }
    }
    while (i < subA.length) {
      push("delete", [subA[i]], [], i, j);
      i++;
    }
    while (j < subB.length) {
      push("insert", [], [subB[j]], i, j);
      j++;
    }
    if (pending) out.push(pending);
  } else if (subA.length || subB.length) {
    if (subA.length) out.push({ kind: "delete", left: subA, right: [], leftAt: start, rightAt: start });
    if (subB.length) out.push({ kind: "insert", left: [], right: subB, leftAt: start, rightAt: start });
  }

  if (endA < n || endB < m) {
    out.push({ kind: "equal", left: a.slice(endA), right: b.slice(endB), leftAt: endA, rightAt: endB });
  }
  return mergeAdjacent(out);
}

/** Turn a delete immediately followed by an insert into a single replace. */
function mergeAdjacent(changes: readonly WordChange[]): WordChange[] {
  const out: WordChange[] = [];
  for (const c of changes) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === "delete" && c.kind === "insert") {
      out[out.length - 1] = {
        kind: "replace",
        left: prev.left,
        right: c.right,
        leftAt: prev.leftAt,
        rightAt: c.rightAt,
      };
      continue;
    }
    if (prev && prev.kind === "insert" && c.kind === "delete") {
      out[out.length - 1] = {
        kind: "replace",
        left: c.left,
        right: prev.right,
        leftAt: c.leftAt,
        rightAt: prev.rightAt,
      };
      continue;
    }
    out.push(c);
  }
  return out;
}

function coarseDiff(a: readonly string[], b: readonly string[]): WordChange[] {
  if (a.join(" ") === b.join(" ")) return [{ kind: "equal", left: [...a], right: [...b], leftAt: 0, rightAt: 0 }];
  return [{ kind: "replace", left: [...a], right: [...b], leftAt: 0, rightAt: 0 }];
}

/** Fraction of tokens that are identical. */
export function similarityOf(changes: readonly WordChange[]): number {
  let same = 0;
  let total = 0;
  for (const c of changes) {
    const n = Math.max(c.left.length, c.right.length);
    total += n;
    if (c.kind === "equal") same += n;
  }
  return total ? same / total : 1;
}

// ---------------------------------------------------------------------------
// Page alignment
// ---------------------------------------------------------------------------

/** What the alignment needs of a page: its words, once. */
interface PageSig {
  words: Set<string>;
  /** Cheap fingerprint: the first words, lower-cased. */
  fp: string;
  empty: boolean;
}

function sigOf(tokens: readonly string[]): PageSig {
  const lower = tokens.map((t) => t.toLowerCase());
  return { words: new Set(lower), fp: lower.slice(0, 60).join(" "), empty: !tokens.length };
}

/** 0..1 — Jaccard similarity of the two pages' vocabularies (1 for identical openings). */
function pairScore(a: PageSig, b: PageSig): number {
  if (a.fp === b.fp && a.words.size === b.words.size) return 1;
  if (!a.words.size && !b.words.size) return 1;
  let shared = 0;
  const [small, big] = a.words.size <= b.words.size ? [a.words, b.words] : [b.words, a.words];
  for (const t of small) if (big.has(t)) shared++;
  return shared / Math.max(1, a.words.size + b.words.size - shared);
}

/** Below this, two pages are not "the same page, edited". */
const MATCH = 0.35;
/** Largest page grid the in-order alignment handles exactly; beyond, a greedy window. */
const MAX_GRID = 4_000_000;

type Pair = [number | null, number | null];

/**
 * In-order alignment maximising the total similarity of the matched pages (a
 * sequence alignment, like the word diff but scored), restricted to a band
 * around the diagonal. A page moved far away is left unmatched here and paired
 * afterwards by `pairMoved`.
 */
function alignInOrder(L: readonly PageSig[], R: readonly PageSig[]): Pair[] {
  const n = L.length;
  const m = R.length;
  if ((n + 1) * (m + 1) > MAX_GRID) return alignGreedy(L, R);
  const band = Math.max(12, Math.abs(n - m) + 12);
  const w = m + 1;
  const best = new Float64Array((n + 1) * w);
  const score = new Float64Array((n + 1) * w).fill(-1);
  for (let i = n - 1; i >= 0; i--) {
    const diag = m ? (i * m) / Math.max(1, n) : 0;
    for (let j = m - 1; j >= 0; j--) {
      let v = Math.max(best[(i + 1) * w + j], best[i * w + j + 1]);
      if (Math.abs(j - diag) <= band) {
        const s = pairScore(L[i], R[j]);
        if (s >= MATCH) {
          score[i * w + j] = s;
          v = Math.max(v, s + best[(i + 1) * w + j + 1]);
        }
      }
      best[i * w + j] = v;
    }
  }
  const pairs: Pair[] = [];
  let i = 0;
  let j = 0;
  const EPS = 1e-9;
  while (i < n && j < m) {
    const s = score[i * w + j];
    const here = best[i * w + j];
    if (s >= 0 && s + best[(i + 1) * w + j + 1] >= here - EPS) {
      pairs.push([i++, j++]);
    } else if (best[i * w + j + 1] >= best[(i + 1) * w + j] + EPS) {
      pairs.push([null, j++]);
    } else {
      pairs.push([i++, null]);
    }
  }
  while (i < n) pairs.push([i++, null]);
  while (j < m) pairs.push([null, j++]);
  return pairs;
}

/** The original greedy, windowed pairing — for documents too large for the grid. */
function alignGreedy(L: readonly PageSig[], R: readonly PageSig[]): Pair[] {
  const usedRight = new Set<number>();
  const pairs: Pair[] = [];
  let cursor = 0;
  for (let i = 0; i < L.length; i++) {
    let best = -1;
    let bestScore = 0;
    // Search forward from the cursor: documents mostly stay in order.
    for (let j = cursor; j < Math.min(R.length, cursor + 12); j++) {
      if (usedRight.has(j)) continue;
      const score = pairScore(L[i], R[j]);
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    if (best >= 0 && bestScore >= MATCH) {
      for (let j = cursor; j < best; j++)
        if (!usedRight.has(j)) {
          pairs.push([null, j]);
          usedRight.add(j);
        }
      pairs.push([i, best]);
      usedRight.add(best);
      cursor = best + 1;
    } else {
      pairs.push([i, null]);
    }
  }
  for (let j = 0; j < R.length; j++) if (!usedRight.has(j)) pairs.push([null, j]);
  return pairs;
}

/**
 * Pages left unmatched on both sides that are in fact the same page, moved:
 * paired best-first. The pair takes the place of the added page (the revised
 * document's order) and the removed entry goes. Pages without text are never
 * "moved" by their (absent) words.
 */
function pairMoved(pairs: Pair[], L: readonly PageSig[], R: readonly PageSig[]): { pairs: Pair[]; moved: Set<number> } {
  const lonelyL = pairs.filter((p) => p[1] === null && !L[p[0]!].empty).map((p) => p[0]!);
  const lonelyR = pairs.filter((p) => p[0] === null && !R[p[1]!].empty).map((p) => p[1]!);
  const moved = new Set<number>();
  if (!lonelyL.length || !lonelyR.length || lonelyL.length * lonelyR.length > 250_000) return { pairs, moved };
  const cands: { l: number; r: number; s: number }[] = [];
  for (const l of lonelyL)
    for (const r of lonelyR) {
      const s = pairScore(L[l], R[r]);
      if (s >= MATCH) cands.push({ l, r, s });
    }
  cands.sort((a, b) => b.s - a.s || Math.abs(a.l - a.r) - Math.abs(b.l - b.r));
  const takenL = new Map<number, number>();
  const takenR = new Set<number>();
  for (const c of cands) {
    if (takenL.has(c.l) || takenR.has(c.r)) continue;
    takenL.set(c.l, c.r);
    takenR.add(c.r);
  }
  if (!takenL.size) return { pairs, moved };
  const rToL = new Map([...takenL].map(([l, r]) => [r, l]));
  const out: Pair[] = [];
  for (const p of pairs) {
    if (p[1] === null && takenL.has(p[0]!)) continue;
    if (p[0] === null && rToL.has(p[1]!)) {
      out.push([rToL.get(p[1]!)!, p[1]]);
      moved.add(p[1]!);
      continue;
    }
    out.push(p);
  }
  return { pairs: out, moved };
}

/**
 * Align pages between the two documents, then diff each matched pair.
 * Pages are aligned in order by content similarity (so an inserted or deleted
 * page does not desynchronise the rest), then pages left over on both sides
 * that match are reported as moved rather than removed + added.
 */
export function comparePages(left: readonly string[], right: readonly string[]): ComparisonReport {
  return compareTokenPages(left.map(tokenise), right.map(tokenise));
}

function compareTokenPages(left: readonly string[][], right: readonly string[][]): ComparisonReport {
  const L = left.map(sigOf);
  const R = right.map(sigOf);
  const { pairs, moved } = pairMoved(alignInOrder(L, R), L, R);

  const pages: PageComparison[] = [];
  let wordsAdded = 0;
  let wordsRemoved = 0;
  let pagesAdded = 0;
  let pagesRemoved = 0;
  let pagesModified = 0;
  let totalSim = 0;

  for (const [l, r] of pairs) {
    if (l === null && r !== null) {
      const words = right[r];
      wordsAdded += words.length;
      pagesAdded++;
      pages.push({
        leftPage: null,
        rightPage: r + 1,
        status: "added",
        similarity: 0,
        changes: [{ kind: "insert", left: [], right: [...words], leftAt: 0, rightAt: 0 }],
      });
      continue;
    }
    if (r === null && l !== null) {
      const words = left[l];
      wordsRemoved += words.length;
      pagesRemoved++;
      pages.push({
        leftPage: l + 1,
        rightPage: null,
        status: "removed",
        similarity: 0,
        changes: [{ kind: "delete", left: [...words], right: [], leftAt: 0, rightAt: 0 }],
      });
      continue;
    }
    if (l === null || r === null) continue;
    const changes = diffTokens(left[l], right[r]);
    const sim = similarityOf(changes);
    totalSim += sim;
    const modified = changes.some((c) => c.kind !== "equal");
    if (modified) pagesModified++;
    for (const c of changes) {
      if (c.kind === "insert" || c.kind === "replace") wordsAdded += c.right.length;
      if (c.kind === "delete" || c.kind === "replace") wordsRemoved += c.left.length;
    }
    pages.push({
      leftPage: l + 1,
      rightPage: r + 1,
      status: modified ? "modified" : "unchanged",
      changes,
      similarity: sim,
      ...(moved.has(r) ? { moved: true } : {}),
    });
  }

  const paired = pages.filter((p) => p.status === "modified" || p.status === "unchanged").length;
  const pagesWithoutText = pages.filter(
    (p) => p.status === "unchanged" && !left[p.leftPage! - 1]?.length && !right[p.rightPage! - 1]?.length,
  ).length;
  return {
    pagesWithoutText,
    pages,
    wordsAdded,
    wordsRemoved,
    pagesAdded,
    pagesRemoved,
    pagesModified,
    pagesMoved: moved.size,
    similarity: paired ? totalSim / paired : pages.length ? 0 : 1,
  };
}

// ---------------------------------------------------------------------------
// Detailed comparison: word boxes, formatting, per-change items
// ---------------------------------------------------------------------------

/** One word of a page, as laid out: where it is and how it is set. */
export interface LayoutWord {
  text: string;
  /** Page space: unrotated crop box, points, y down. */
  rect: Rect;
  /** Index of its line in `PageText.lines` (to merge the boxes of a phrase). */
  line: number;
  fontFamily?: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  /** Fill colour « #rrggbb », when known. */
  color?: string;
}

export type DiffCategory = "text" | "format" | "image" | "page";

export type DiffKind = "insert" | "delete" | "replace" | "format" | "image" | "added" | "removed" | "moved";

/** One reportable difference, with what to highlight on each side. */
export interface DiffItem {
  id: string;
  category: DiffCategory;
  kind: DiffKind;
  /** 1-based pages (null on the side that has no such page). */
  leftPage: number | null;
  rightPage: number | null;
  /** Page-space boxes to highlight on the original (left) / revised (right) page. */
  leftRects: Rect[];
  rightRects: Rect[];
  /** Words concerned, on each side (an excerpt for whole pages). */
  left: string;
  right: string;
  /** Human description (French), e.g. « gras ajouté, taille 11 pt → 14 pt ». */
  detail?: string;
}

export interface DetailedPage extends PageComparison {
  items: DiffItem[];
  /** Page sizes in points (unrotated crop box), when known. */
  leftSize?: Size;
  rightSize?: Size;
  /** Boxes of every text line, per side: kept out of the visual comparison (text is compared as text). */
  leftText: Rect[];
  rightText: Rect[];
  /** Paired page with no text on either side (a scan): only the visual comparison says anything. */
  textless: boolean;
}

export interface DetailedReport extends ComparisonReport {
  pages: DetailedPage[];
  /** Formatting changes (groups of consecutive words). */
  formatChanges: number;
  /** Image / drawing regions that differ (filled in by `compareVisual`). */
  imageChanges: number;
  /** True once the pages were also compared as pictures. */
  visual: boolean;
}

const WORDY = /[\p{L}\p{N}]/u;

/**
 * The words of a laid-out page, in reading order, with a box each: the page's
 * runs are joined as `joinItems` does (a line break between lines), tokenised
 * like `tokenise`, and each word's box is its share of its run(s).
 * `colours` (by text item index) is optional — `textItemColours`.
 */
export function layoutWords(page: PageText, colours?: readonly (string | undefined)[]): LayoutWord[] {
  const runs: { run: TextRun; line: number }[] = [];
  page.lines.forEach((l, line) => l.runs.forEach((run) => runs.push({ run, line })));
  runs.sort((a, b) => a.run.index - b.run.index);
  let text = "";
  const owner: number[] = [];
  const offset: number[] = [];
  const gap = (s: string) => {
    for (const ch of s) {
      text += ch;
      owner.push(-1);
      offset.push(0);
    }
  };
  runs.forEach(({ run, line }, k) => {
    const prev = k ? runs[k - 1] : null;
    if (prev && (prev.run.hasEOL || prev.line !== line)) gap("\n");
    else if (prev && run.index - prev.run.index > 1) gap(" ");
    for (let c = 0; c < run.str.length; c++) {
      text += run.str[c];
      owner.push(k);
      offset.push(c);
    }
  });

  const out: LayoutWord[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    let rect: Rect | null = null;
    let first = -1;
    // One box per run the word crosses, united.
    for (let c = start; c < end;) {
      const k = owner[c];
      if (k < 0) {
        c++;
        continue;
      }
      if (first < 0) first = k;
      let e = c;
      while (e < end && owner[e] === k) e++;
      const part = subRect(runs[k].run, offset[c], offset[e - 1] + 1);
      rect = rect ? union(rect, part) : part;
      c = e;
    }
    if (first < 0 || !rect) continue;
    const { run, line } = runs[first];
    out.push({
      text: m[0],
      rect,
      line,
      fontFamily: run.fontFamily,
      fontSize: run.fontSize,
      bold: run.bold,
      italic: run.italic,
      color: colours?.[run.index],
    });
  }
  return out;
}

/** Box of characters [from, to) of a run, proportionally along its quad. */
function subRect(run: TextRun, from: number, to: number): Rect {
  const n = Math.max(1, run.str.length);
  const [tl, tr, br, bl] = run.quad;
  const at = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const t0 = from / n;
  const t1 = to / n;
  const pts = [at(tl, tr, t0), at(tl, tr, t1), at(bl, br, t0), at(bl, br, t1)];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Boxes of consecutive words, one per line they cover. */
export function phraseRects(words: readonly LayoutWord[]): Rect[] {
  const out: Rect[] = [];
  let line = -1;
  for (const w of words) {
    if (w.line === line && out.length) out[out.length - 1] = union(out[out.length - 1], w.rect);
    else out.push({ ...w.rect });
    line = w.line;
  }
  return out;
}

const pt = (n: number) => `${Math.round(n * 10) / 10} pt`.replace(".", ",");

/** What changed in how a word is set, in French — null when nothing did. */
export function formatChange(a: LayoutWord, b: LayoutWord): string | null {
  const parts: string[] = [];
  if (a.fontFamily && b.fontFamily && a.fontFamily.toLowerCase() !== b.fontFamily.toLowerCase())
    parts.push(`police ${a.fontFamily} → ${b.fontFamily}`);
  if (Math.abs(a.fontSize - b.fontSize) > Math.max(0.4, a.fontSize * 0.04))
    parts.push(`taille ${pt(a.fontSize)} → ${pt(b.fontSize)}`);
  if (a.bold !== b.bold) parts.push(b.bold ? "gras ajouté" : "gras retiré");
  if (a.italic !== b.italic) parts.push(b.italic ? "italique ajouté" : "italique retiré");
  if (a.color && b.color && a.color.toLowerCase() !== b.color.toLowerCase())
    parts.push(`couleur ${a.color} → ${b.color}`);
  return parts.length ? parts.join(", ") : null;
}

const excerpt = (words: readonly string[], max = 14) =>
  words.length > max ? `${words.slice(0, max).join(" ")}…` : words.join(" ");

export interface LayoutCompareOptions {
  /** Text colours per page, by text item index (see `textItemColours`). */
  leftColours?: readonly (readonly (string | undefined)[])[];
  rightColours?: readonly (readonly (string | undefined)[])[];
  /** Page sizes (unrotated crop box, points). */
  leftSizes?: readonly Size[];
  rightSizes?: readonly Size[];
}

/**
 * The detailed comparison of two laid-out documents (`extractLayout`): the
 * same alignment and word diff as `comparePages`, plus a box for every changed
 * word on both sides, formatting changes of words that stayed, and moved
 * pages. Visual differences are added afterwards by `compareVisual`.
 */
export function compareLayouts(
  left: readonly PageText[],
  right: readonly PageText[],
  opts: LayoutCompareOptions = {},
): DetailedReport {
  const lw = left.map((p, i) => layoutWords(p, opts.leftColours?.[i]));
  const rw = right.map((p, i) => layoutWords(p, opts.rightColours?.[i]));
  const base = compareTokenPages(
    lw.map((ws) => ws.map((w) => w.text)),
    rw.map((ws) => ws.map((w) => w.text)),
  );
  let formatChanges = 0;
  let pagesModified = 0;
  let seq = 0;
  const id = () => `c${++seq}`;
  const lineRects = (p: PageText | undefined) => (p ? p.lines.map((l) => ({ ...l.rect })) : []);

  const pages: DetailedPage[] = base.pages.map((pg) => {
    const L = pg.leftPage ? lw[pg.leftPage - 1] : [];
    const R = pg.rightPage ? rw[pg.rightPage - 1] : [];
    const items: DiffItem[] = [];
    const common = { leftPage: pg.leftPage, rightPage: pg.rightPage };
    if (pg.status === "added" || pg.status === "removed") {
      const words = (pg.status === "added" ? R : L).map((w) => w.text);
      items.push({
        id: id(),
        category: "page",
        kind: pg.status,
        ...common,
        leftRects: [],
        rightRects: [],
        left: pg.status === "removed" ? excerpt(words) : "",
        right: pg.status === "added" ? excerpt(words) : "",
      });
    } else {
      if (pg.moved)
        items.push({
          id: id(),
          category: "page",
          kind: "moved",
          ...common,
          leftRects: [],
          rightRects: [],
          left: "",
          right: "",
          detail: `Page déplacée de la position ${pg.leftPage} à la position ${pg.rightPage}`,
        });
      for (const c of pg.changes) {
        if (c.kind === "equal") {
          // Same words: did their formatting change? Consecutive words with the same change make one item.
          let run: { detail: string; l: LayoutWord[]; r: LayoutWord[] } | null = null;
          const flush = () => {
            if (!run) return;
            formatChanges++;
            items.push({
              id: id(),
              category: "format",
              kind: "format",
              ...common,
              leftRects: phraseRects(run.l),
              rightRects: phraseRects(run.r),
              left: excerpt(run.l.map((w) => w.text)),
              right: excerpt(run.r.map((w) => w.text)),
              detail: run.detail,
            });
            run = null;
          };
          for (let k = 0; k < c.left.length; k++) {
            const a = L[c.leftAt + k];
            const b = R[c.rightAt + k];
            if (!a || !b) continue;
            const detail = WORDY.test(a.text) ? formatChange(a, b) : null;
            if (!detail) {
              // Punctuation between two words carrying the same change does not break the phrase.
              if (run && !WORDY.test(a.text)) continue;
              flush();
              continue;
            }
            if (run && run.detail === detail) {
              run.l.push(a);
              run.r.push(b);
            } else {
              flush();
              run = { detail, l: [a], r: [b] };
            }
          }
          flush();
          continue;
        }
        const lWords = L.slice(c.leftAt, c.leftAt + c.left.length);
        const rWords = R.slice(c.rightAt, c.rightAt + c.right.length);
        items.push({
          id: id(),
          category: "text",
          kind: c.kind,
          ...common,
          leftRects: phraseRects(lWords),
          rightRects: phraseRects(rWords),
          left: c.left.join(" "),
          right: c.right.join(" "),
        });
      }
    }
    let status = pg.status;
    if (status === "unchanged" && items.some((it) => it.category === "format")) status = "modified";
    if (status === "modified") pagesModified++;
    return {
      ...pg,
      status,
      items,
      leftSize: pg.leftPage ? opts.leftSizes?.[pg.leftPage - 1] : undefined,
      rightSize: pg.rightPage ? opts.rightSizes?.[pg.rightPage - 1] : undefined,
      leftText: lineRects(pg.leftPage ? left[pg.leftPage - 1] : undefined),
      rightText: lineRects(pg.rightPage ? right[pg.rightPage - 1] : undefined),
      textless: pg.leftPage !== null && pg.rightPage !== null && !L.length && !R.length,
    };
  });

  return { ...base, pages, pagesModified, formatChanges, imageChanges: 0, visual: false };
}

/** Every item of a report, in page order. */
export function allItems(report: DetailedReport): DiffItem[] {
  return report.pages.flatMap((p) => p.items);
}

/** What each kind of difference is called (the view, the report). */
export const DIFF_LABEL: Record<DiffKind, string> = {
  insert: "Texte ajouté",
  delete: "Texte supprimé",
  replace: "Texte remplacé",
  format: "Mise en forme",
  image: "Image / dessin modifié",
  added: "Page ajoutée",
  removed: "Page supprimée",
  moved: "Page déplacée",
};

/** One line saying what changed, e.g. « « mille » → « douze cents » » or the formatting detail. */
export function describeItem(it: DiffItem): string {
  switch (it.kind) {
    case "replace":
      return `« ${it.left} » → « ${it.right} »`;
    case "delete":
      return `« ${it.left} »`;
    case "insert":
      return `« ${it.right} »`;
    case "format":
      return `« ${it.right} » : ${it.detail ?? ""}`;
    case "added":
      return it.right ? `Page ${it.rightPage} : « ${it.right} »` : `Page ${it.rightPage}`;
    case "removed":
      return it.left ? `Page ${it.leftPage} : « ${it.left} »` : `Page ${it.leftPage}`;
    default:
      return it.detail ?? "";
  }
}

/** Title of a page pair, e.g. « Page 3 → 4 », « Page 2 ajoutée ». */
export function pageTitle(p: PageComparison): string {
  if (p.status === "added") return `Page ${p.rightPage} ajoutée`;
  if (p.status === "removed") return `Page ${p.leftPage} supprimée`;
  if (p.moved) return `Page ${p.leftPage} déplacée en ${p.rightPage}`;
  return p.leftPage === p.rightPage ? `Page ${p.leftPage}` : `Page ${p.leftPage} → ${p.rightPage}`;
}
