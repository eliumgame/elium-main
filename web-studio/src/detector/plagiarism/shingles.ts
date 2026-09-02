/**
 * Passage selection + shingle similarity for the plagiarism scanner.
 *
 * `selectPassages` picks a bounded, spread-out set of excerpts worth checking
 * against the web: enough per document to be useful, few enough that a
 * several-hundred-page report doesn't fire thousands of search queries.
 * `jaccardSimilarity` then compares an excerpt against a search snippet using
 * word n-gram (shingle) overlap — the standard low-cost plagiarism metric.
 */

import type { ParagraphModel } from "../types";

export interface PassageSelectionOptions {
  /** Hard cap on the number of passages returned. Default 60. */
  maxQueries?: number;
}

export interface SelectedPassage {
  paragraphIndex: number;
  text: string;
}

const MIN_WORDS = 8;
const WINDOW_TARGET_WORDS = 25;
const WINDOW_MAX_WORDS = 30;
const WINDOW_STEP_WORDS = 15;

const WORD_RE = /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu;

/** Common French/English function words — low information, so a window full
 * of them scores as unremarkable rather than distinctive. */
const STOP_WORDS = new Set([
  "le",
  "la",
  "les",
  "un",
  "une",
  "des",
  "de",
  "du",
  "au",
  "aux",
  "et",
  "ou",
  "où",
  "à",
  "en",
  "dans",
  "par",
  "pour",
  "sur",
  "sous",
  "avec",
  "sans",
  "que",
  "qui",
  "quoi",
  "dont",
  "ce",
  "cet",
  "cette",
  "ces",
  "se",
  "sa",
  "son",
  "ses",
  "il",
  "elle",
  "ils",
  "elles",
  "on",
  "nous",
  "vous",
  "je",
  "tu",
  "me",
  "te",
  "lui",
  "leur",
  "leurs",
  "est",
  "sont",
  "été",
  "être",
  "a",
  "ont",
  "avoir",
  "plus",
  "moins",
  "ne",
  "pas",
  "ni",
  "mais",
  "donc",
  "or",
  "car",
  "si",
  "y",
  "tout",
  "tous",
  "toute",
  "toutes",
  "comme",
  "aussi",
  "bien",
  "très",
  "peu",
  "fait",
  "faire",
  "cela",
  "ça",
  "ainsi",
  "alors",
  "entre",
  "vers",
  "chez",
  "the",
  "of",
  "and",
  "to",
  "in",
  "is",
  "it",
  "for",
  "as",
  "was",
  "on",
  "are",
  "with",
  "be",
  "this",
  "that",
  "these",
  "those",
  "which",
  "who",
  "whom",
  "from",
  "by",
  "at",
  "or",
  "an",
  "we",
  "you",
  "they",
  "he",
  "she",
  "his",
  "her",
  "its",
  "our",
  "your",
  "their",
  "not",
  "but",
  "have",
  "has",
  "had",
  "will",
  "would",
  "can",
  "could",
  "should",
  "into",
  "out",
  "up",
  "down",
  "over",
  "under",
  "again",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "so",
  "than",
  "too",
  "very",
  "just",
  "also",
]);

interface WordMatch {
  text: string;
  index: number;
}

function wordMatches(text: string): WordMatch[] {
  return [...text.matchAll(WORD_RE)].map((m) => ({ text: m[0], index: m.index ?? 0 }));
}

/** Higher when a window has fewer stopwords and longer content words. */
function windowScore(words: string[]): number {
  if (!words.length) return 0;
  let sum = 0;
  for (const w of words) {
    const lw = w.toLowerCase();
    if (STOP_WORDS.has(lw) || /^\d+$/.test(lw)) continue;
    sum += Math.min(lw.length, 12);
  }
  return sum / words.length;
}

function sliceText(text: string, matches: WordMatch[], start: number, end: number): string {
  const first = matches[start];
  const last = matches[end - 1];
  return text.slice(first.index, last.index + last.text.length);
}

/** Best (most distinctive) ~20-30 word window in a paragraph, or null when the
 * paragraph is too short to be worth checking at all. */
function bestWindow(text: string): { text: string; score: number } | null {
  const matches = wordMatches(text);
  if (matches.length < MIN_WORDS) return null;

  const ranges: [number, number][] = [];
  if (matches.length <= WINDOW_MAX_WORDS) {
    ranges.push([0, matches.length]);
  } else {
    for (let start = 0; start < matches.length; start += WINDOW_STEP_WORDS) {
      const end = Math.min(matches.length, start + WINDOW_TARGET_WORDS);
      ranges.push([start, end]);
      if (end === matches.length) break;
    }
  }

  let best: { text: string; score: number } | null = null;
  for (const [start, end] of ranges) {
    const words = matches.slice(start, end).map((m) => m.text);
    const score = windowScore(words);
    if (!best || score > best.score) {
      best = { text: sliceText(text, matches, start, end), score };
    }
  }
  return best;
}

interface Candidate {
  paragraphIndex: number;
  text: string;
  score: number;
}

/**
 * Picks representative, distinctive passages across a document, capped at
 * `opts.maxQueries`. When more paragraphs qualify than the cap allows, the
 * document's index range is bucketed into `maxQueries` slices and the most
 * distinctive candidate in each slice is kept first — so long documents get
 * checked throughout instead of only in their opening pages.
 */
export function selectPassages(paragraphs: ParagraphModel[], opts: PassageSelectionOptions = {}): SelectedPassage[] {
  const maxQueries = opts.maxQueries ?? 60;
  if (maxQueries <= 0) return [];

  const candidates: Candidate[] = [];
  for (const p of paragraphs) {
    const window = bestWindow(p.text);
    if (!window) continue;
    const text = window.text.trim();
    if (!text) continue;
    candidates.push({ paragraphIndex: p.index, text, score: window.score });
  }
  if (!candidates.length) return [];

  const toResult = (c: Candidate): SelectedPassage => ({ paragraphIndex: c.paragraphIndex, text: c.text });

  if (candidates.length <= maxQueries) {
    return candidates
      .slice()
      .sort((a, b) => a.paragraphIndex - b.paragraphIndex)
      .map(toResult);
  }

  const indices = candidates.map((c) => c.paragraphIndex);
  const minIndex = Math.min(...indices);
  const maxIndex = Math.max(...indices);
  const span = Math.max(1, maxIndex - minIndex + 1);
  const bucketSize = span / maxQueries;

  const buckets = new Map<number, Candidate>();
  for (const c of candidates) {
    const bucket = Math.min(maxQueries - 1, Math.floor((c.paragraphIndex - minIndex) / bucketSize));
    const existing = buckets.get(bucket);
    if (!existing || c.score > existing.score) buckets.set(bucket, c);
  }

  const picked = new Set(buckets.values());
  const remaining = candidates.filter((c) => !picked.has(c)).sort((a, b) => b.score - a.score);

  const selected = [...picked];
  for (const c of remaining) {
    if (selected.length >= maxQueries) break;
    selected.push(c);
  }

  return selected.sort((a, b) => a.paragraphIndex - b.paragraphIndex).map(toResult);
}

function normalizedWords(text: string): string[] {
  return text.toLowerCase().match(WORD_RE) ?? [];
}

function shingleSet(text: string, n: number): Set<string> {
  const words = normalizedWords(text);
  if (words.length === 0) return new Set();
  if (words.length < n) return new Set([words.join(" ")]);
  const set = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    set.add(words.slice(i, i + n).join(" "));
  }
  return set;
}

/**
 * Word n-gram (shingle) Jaccard similarity between two strings, case- and
 * punctuation-normalized. 0 when either string yields no words, 1 for
 * identical (post-normalization) text.
 */
export function jaccardSimilarity(a: string, b: string, n = 5): number {
  const setA = shingleSet(a, n);
  const setB = shingleSet(b, n);
  if (!setA.size || !setB.size) return 0;

  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let intersection = 0;
  for (const shingle of smaller) {
    if (larger.has(shingle)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union ? intersection / union : 0;
}
