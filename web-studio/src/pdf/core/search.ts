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
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const rep = foldChar(text[i], ignoreDiacritics);
    for (let k = 0; k < rep.length; k++) {
      folded += rep[k];
      map.push(i);
    }
  }
  map.push(text.length);
  return { folded, map, original: text };
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
  for (let page = 0; page < pageTexts.length; page++) {
    const text = pageTexts[page] ?? "";
    if (!text) continue;
    const { folded, map } = foldText(text, opts.ignoreDiacritics);
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
