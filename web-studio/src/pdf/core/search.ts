/**
 * Full-document search: Acrobat's "Find" bar *and* its "Advanced search" panel.
 *
 * Pure functions over already-extracted page text, so the whole thing is unit
 * testable without pdf.js or a DOM. The view turns a `SearchHit`'s character
 * range into quads via `core/text.quadsForCharRange`.
 */

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Treat "é" and "e" as the same character (on by default — French corpora). */
  ignoreDiacritics: boolean;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  ignoreDiacritics: true,
};

export interface SearchHit {
  /** 0-based index into the page array that was searched. */
  page: number;
  /** Character offsets into that page's text. */
  start: number;
  end: number;
  /** Snippet with the match in the middle, for the results list. */
  context: string;
  /** Offsets of the match inside `context`. */
  ctxStart: number;
  ctxEnd: number;
}

/**
 * Characters that are visually identical but encoded differently in real PDFs.
 * Normalising them means searching "oeuvre" finds "œuvre" and "don't" finds
 * "don’t" — the two complaints every PDF reader gets.
 */
const FOLD: Record<string, string> = {
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  "‘": "'",
  "’": "'",
  "‚": "'",
  "′": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "″": '"',
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "–": "-",
  "—": "-",
  "―": "-",
  "−": "-",
  "­": "", // soft hyphen
};

/**
 * Fold one character to its searchable form. Returns a string because ligatures
 * expand to several characters — the caller keeps an offset map so hits still
 * point at the right place in the ORIGINAL text.
 */
function foldChar(ch: string, ignoreDiacritics: boolean): string {
  const direct = FOLD[ch];
  if (direct !== undefined) return direct;
  if (ch === "ﬀ") return "ff";
  if (ch === "ﬁ") return "fi";
  if (ch === "ﬂ") return "fl";
  if (ch === "ﬃ") return "ffi";
  if (ch === "ﬄ") return "ffl";
  if (ch === "œ") return "oe";
  if (ch === "Œ") return "OE";
  if (ch === "æ") return "ae";
  if (ch === "Æ") return "AE";
  if (!ignoreDiacritics) return ch;
  const d = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return d || ch;
}

/**
 * A page's text folded for matching, plus a map from folded offset back to the
 * original offset (so highlights land on the real characters).
 */
export interface FoldedText {
  folded: string;
  /** `map[i]` = original index of folded character i. Length = folded.length + 1. */
  map: number[];
  original: string;
}

/**
 * Fold a string for matching. Case is deliberately *preserved*: insensitivity
 * is the regex `i` flag's job, so a regex query like `[A-Z]-\d{4}` still means
 * what the user wrote instead of running against a lower-cased haystack.
 */
export function foldText(text: string, ignoreDiacritics: boolean): FoldedText {
  const out: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    // A word cut at the end of a line: "exam-\nple" reads "example".
    if (HYPHENS.has(ch) && text[i + 1] === "\n" && isLetter(text[i - 1]) && isLetter(text[i + 2])) {
      i++;
      continue;
    }
    // A letter written as base + combining accents (NFD, common in PDFs from Macs).
    let j = i + 1;
    while (j < text.length && COMBINING.test(text[j])) j++;
    let rep: string;
    if (COMBINING.test(ch)) rep = ignoreDiacritics ? "" : ch;
    else if (j > i + 1) rep = ignoreDiacritics ? foldChar(ch, true) : text.slice(i, j).normalize("NFC");
    else rep = foldChar(ch, ignoreDiacritics);
    for (let k = 0; k < rep.length; k++) {
      out.push(rep[k]);
      map.push(i);
    }
    i = j - 1;
  }
  map.push(text.length);
  return { folded: out.join(""), map, original: text };
}

const COMBINING = /[\u0300-\u036f]/;
const HYPHENS = new Set(["-", "\u00ad", "\u2010", "\u2011"]);
const isLetter = (ch: string | undefined) => !!ch && /\p{L}/u.test(ch);

/** Folded pages, per page-text array and diacritics mode: page text does not change, folding it again on every keystroke did. */
const foldCache = new WeakMap<readonly string[], Map<boolean, FoldedText[]>>();
function foldedPages(pageTexts: readonly string[], ignoreDiacritics: boolean): FoldedText[] {
  let modes = foldCache.get(pageTexts);
  if (!modes) foldCache.set(pageTexts, (modes = new Map()));
  let list = modes.get(ignoreDiacritics);
  if (!list) modes.set(ignoreDiacritics, (list = []));
  return list;
}

/** Whether `text` (a comment, a bookmark title…) contains the query, with the same options as the pages. */
export function textMatches(text: string, query: string, opts: SearchOptions): boolean {
  const re = compileQuery(query, opts);
  if (!re || !text) return false;
  const { folded } = foldText(text, opts.ignoreDiacritics);
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(folded)) !== null) {
    if (!m[0].length) {
      re.lastIndex++;
      continue;
    }
    const a = m.index;
    const b = a + m[0].length;
    if (!opts.wholeWord || (!isWordChar(folded[a - 1]) && !isWordChar(folded[b]))) return true;
  }
  return false;
}

const WORD_RE = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return !!ch && WORD_RE.test(ch);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile the query once; returns null for an empty or invalid pattern. */
export function compileQuery(query: string, opts: SearchOptions): RegExp | null {
  const q = opts.regex ? query : query.trim();
  if (!q) return null;
  let source: string;
  if (opts.regex) {
    source = q;
  } else {
    // Fold the query the same way as the haystack, and let any run of
    // whitespace in the query match a line break in the PDF.
    const folded = foldText(q, opts.ignoreDiacritics).folded;
    source = escapeRegExp(folded).replace(/(\\?\s)+/g, "\\s+");
  }
  const flags = opts.caseSensitive ? "gu" : "giu";
  try {
    return new RegExp(source, flags);
  } catch {
    try {
      return new RegExp(escapeRegExp(q), flags);
    } catch {
      return null;
    }
  }
}

const CONTEXT = 46;

function makeContext(text: string, start: number, end: number): Pick<SearchHit, "context" | "ctxStart" | "ctxEnd"> {
  const from = Math.max(0, start - CONTEXT);
  const to = Math.min(text.length, end + CONTEXT);
  const head = from > 0 ? "…" : "";
  const tail = to < text.length ? "…" : "";
  const slice = text.slice(from, to).replace(/\s+/g, " ");
  // Recompute the offsets after whitespace collapsing by measuring the prefix.
  const prefix = text.slice(from, start).replace(/\s+/g, " ");
  const body = text.slice(start, end).replace(/\s+/g, " ");
  return {
    context: head + slice + tail,
    ctxStart: head.length + prefix.length,
    ctxEnd: head.length + prefix.length + body.length,
  };
}

/** All hits across every page, in reading order. */
export function search(pageTexts: readonly string[], query: string, opts: SearchOptions): SearchHit[] {
  const re = compileQuery(query, opts);
  if (!re) return [];
  const out: SearchHit[] = [];
  const cache = foldedPages(pageTexts, opts.ignoreDiacritics);
  for (let page = 0; page < pageTexts.length; page++) {
    const text = pageTexts[page] ?? "";
    if (!text) continue;
    const { folded, map } = (cache[page] ??= foldText(text, opts.ignoreDiacritics));
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(folded)) !== null) {
      if (guard++ > 50_000) break;
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const fStart = m.index;
      const fEnd = m.index + m[0].length;
      if (opts.wholeWord && (isWordChar(folded[fStart - 1]) || isWordChar(folded[fEnd]))) continue;
      const start = map[fStart] ?? 0;
      const end = map[fEnd] ?? text.length;
      out.push({ page, start, end, ...makeContext(text, start, end) });
    }
  }
  return out;
}

/** Hit count per page plus the total — drives the sidebar's per-page badges. */
export function countByPage(hits: readonly SearchHit[], pageCount: number): { counts: number[]; total: number } {
  const counts = new Array<number>(pageCount).fill(0);
  for (const h of hits) if (h.page >= 0 && h.page < pageCount) counts[h.page]++;
  return { counts, total: hits.length };
}

/** Index of the first hit at or after `page`, for "search from the current page". */
export function firstHitFromPage(hits: readonly SearchHit[], page: number): number {
  const i = hits.findIndex((h) => h.page >= page);
  return i < 0 ? (hits.length ? 0 : -1) : i;
}

/** Step through hits with wraparound. */
export function stepHit(index: number, delta: number, total: number): number {
  if (total <= 0) return -1;
  return (((index + delta) % total) + total) % total;
}
