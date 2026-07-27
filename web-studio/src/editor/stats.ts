/**
 * Document statistics — Word's "Statistiques" dialog.
 *
 * Pure functions over plain text plus a few structural counts, so they are
 * unit-testable without TipTap. Word counting is deliberately locale-aware for
 * French: apostrophes bind ("l'État" is one word), hyphenated compounds stay
 * together ("porte-parole"), and ordinals keep their suffix.
 */

export interface DocStats {
  words: number;
  /** Characters including spaces. */
  characters: number;
  /** Characters excluding whitespace. */
  charactersNoSpaces: number;
  paragraphs: number;
  sentences: number;
  /** Estimated reading time in minutes, rounded up (200 wpm). */
  readingMinutes: number;
  /** Estimated speaking time in minutes, rounded up (130 wpm). */
  speakingMinutes: number;
}

export interface StructureCounts {
  headings: number;
  tables: number;
  images: number;
  footnotes: number;
  endnotes: number;
  comments: number;
  links: number;
  pages: number;
}

/**
 * A word is a run of letters/digits that may contain internal apostrophes or
 * hyphens. Leading/trailing punctuation is not part of the word.
 */
const WORD_RE = /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu;

/** Sentence terminators, ignoring the dots inside abbreviations and numbers. */
const SENTENCE_RE = /[.!?…]+(?=\s|$)/g;

export function countWords(text: string): number {
  return (text.match(WORD_RE) ?? []).length;
}

export function textStats(text: string, paragraphCount?: number): DocStats {
  const words = countWords(text);
  const characters = text.length;
  const charactersNoSpaces = text.replace(/\s/g, "").length;
  const paragraphs = paragraphCount ?? text.split(/\n{1,}/).filter((p) => p.trim()).length;
  // A trailing terminator-less fragment still reads as one sentence.
  const terminators = (text.match(SENTENCE_RE) ?? []).length;
  const trailing = /[\p{L}\p{N}][^.!?…]*$/u.test(text.trim()) ? 1 : 0;
  const sentences = Math.max(words > 0 ? 1 : 0, terminators + trailing);

  return {
    words,
    characters,
    charactersNoSpaces,
    paragraphs,
    sentences,
    readingMinutes: words ? Math.max(1, Math.ceil(words / 200)) : 0,
    speakingMinutes: words ? Math.max(1, Math.ceil(words / 130)) : 0,
  };
}

/** Average words per sentence — a plain-language readability signal. */
export function averageSentenceLength(stats: DocStats): number {
  return stats.sentences ? Math.round((stats.words / stats.sentences) * 10) / 10 : 0;
}

/**
 * Kandel & Moles — the French adaptation of Flesch reading ease. Higher is
 * easier; roughly 30 = difficult, 60 = standard, 80 = easy.
 * Needs a syllable estimate, which for French is close enough to vowel groups.
 */
export function readability(text: string): { score: number; label: string } {
  const words = text.match(WORD_RE) ?? [];
  if (words.length < 10) return { score: 0, label: "trop court pour être évalué" };
  const syllables = words.reduce((n, w) => n + countSyllablesFr(w), 0);
  const sentences = Math.max(1, (text.match(SENTENCE_RE) ?? []).length);
  const wordsPerSentence = words.length / sentences;
  const syllablesPer100 = (syllables / words.length) * 100;
  const score = Math.round(207 - 1.015 * wordsPerSentence - 0.736 * syllablesPer100);
  const clamped = Math.max(0, Math.min(100, score));
  const label =
    clamped >= 80 ? "très facile"
      : clamped >= 60 ? "facile"
        : clamped >= 40 ? "standard"
          : clamped >= 20 ? "difficile"
            : "très difficile";
  return { score: clamped, label };
}

/** Vowel groups, minus the silent final "e" French leaves unpronounced. */
export function countSyllablesFr(word: string): number {
  const w = word.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const groups = w.match(/[aeiouy]+/g) ?? [];
  let n = groups.length;
  if (n > 1 && /e$/.test(w) && !/[aeiouy]e$/.test(w)) n -= 1;
  return Math.max(1, n);
}

/** Most frequent words, ignoring the French stop list — a quick keyword view. */
const STOP_WORDS = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "au", "aux", "et", "ou", "où", "à", "en",
  "dans", "par", "pour", "sur", "sous", "avec", "sans", "que", "qui", "quoi", "dont", "ce",
  "cet", "cette", "ces", "se", "sa", "son", "ses", "il", "elle", "ils", "elles", "on", "nous",
  "vous", "je", "tu", "me", "te", "lui", "leur", "leurs", "est", "sont", "été", "être", "a",
  "ont", "avoir", "plus", "moins", "ne", "pas", "ni", "mais", "donc", "or", "car", "si", "y",
  "the", "of", "and", "to", "in", "is", "it", "for", "as", "was", "on", "are", "with", "be",
]);

export function keywords(text: string, limit = 12): { word: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const raw of text.match(WORD_RE) ?? []) {
    const w = raw.toLowerCase();
    if (w.length < 3 || STOP_WORDS.has(w) || /^\d+$/.test(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, limit);
}

/** Format a duration in minutes the way the status bar shows it. */
export function formatMinutes(minutes: number): string {
  if (minutes <= 0) return "—";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
