/**
 * Index de recherche plein texte EN MÉMOIRE : titres + texte extrait de chaque
 * élément. Recherche « tous les mots » (ET), insensible à la casse et aux
 * accents, préfixes inclus, classement par pertinence, extrait avec les mots
 * trouvés à surligner. Pur — la persistance est dans indexer.ts.
 */
import { foldText, queryTerms } from "./text";

export interface IndexEntry {
  id: string;
  /** Empreinte du contenu indexé (change quand l'élément est modifié ou renommé). */
  rev: string;
  title: string;
  text: string;
}

export interface Snippet {
  text: string;
  /** Plages [début, fin[ à surligner DANS `text`. */
  ranges: [number, number][];
}

export interface SearchHit {
  id: string;
  score: number;
  titleMatch: boolean;
  /** Nombre d'occurrences dans le contenu. */
  matches: number;
  snippet: Snippet | null;
  /** Plages à surligner dans le TITRE. */
  titleRanges: [number, number][];
}

interface Folded {
  entry: IndexEntry;
  title: string;
  text: string;
}

const SNIPPET_RADIUS = 70;
const MAX_RANGES = 12;

function occurrences(hay: string, needle: string, limit = Infinity): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i >= 0 && out.length < limit) {
    out.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

function isWordStart(s: string, i: number): boolean {
  return i === 0 || !/[\p{L}\p{N}]/u.test(s[i - 1]!);
}

/** Fusionne des plages qui se touchent ou se chevauchent. */
export function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

export class SearchIndex {
  private entries = new Map<string, Folded>();

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): IndexEntry | undefined {
    return this.entries.get(id)?.entry;
  }

  revOf(id: string): string | undefined {
    return this.entries.get(id)?.entry.rev;
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  set(entry: IndexEntry): void {
    this.entries.set(entry.id, { entry, title: foldText(entry.title), text: foldText(entry.text) });
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * Éléments contenant TOUS les mots de `query`, du plus pertinent au moins
   * pertinent. `allowed` restreint aux éléments permis (filtres appliqués par l'appelant).
   */
  search(query: string, allowed?: Set<string>, limit = 200): SearchHit[] {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const phrase =
      terms.length > 1
        ? foldText(query)
            .replace(/[^\p{L}\p{N}]+/gu, " ")
            .trim()
        : "";
    const hits: SearchHit[] = [];
    for (const f of this.entries.values()) {
      if (allowed && !allowed.has(f.entry.id)) continue;
      let score = 0;
      let matches = 0;
      let titleMatch = false;
      let ok = true;
      const titleRanges: [number, number][] = [];
      const textRanges: [number, number][] = [];
      for (const term of terms) {
        const inTitle = occurrences(f.title, term);
        const inText = occurrences(f.text, term, 500);
        if (inTitle.length === 0 && inText.length === 0) {
          ok = false;
          break;
        }
        if (inTitle.length) {
          titleMatch = true;
          score += 10 + (inTitle.some((i) => isWordStart(f.title, i)) ? 6 : 0);
          for (const i of inTitle) titleRanges.push([i, i + term.length]);
        }
        if (inText.length) {
          matches += inText.length;
          score += Math.min(inText.length, 10) + (inText.some((i) => isWordStart(f.text, i)) ? 2 : 0);
          for (const i of inText.slice(0, MAX_RANGES * 4)) textRanges.push([i, i + term.length]);
        }
      }
      if (!ok) continue;
      if (phrase && (f.title.includes(phrase) || f.text.includes(phrase))) score += 8;
      hits.push({
        id: f.entry.id,
        score,
        titleMatch,
        matches,
        titleRanges: mergeRanges(titleRanges),
        snippet: textRanges.length ? makeSnippet(f.entry.text, textRanges) : null,
      });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, limit);
  }
}

/** Fenêtre de texte autour de la première occurrence, avec toutes les plages incluses à surligner. */
export function makeSnippet(text: string, ranges: [number, number][]): Snippet {
  const first = [...ranges].sort((a, b) => a[0] - b[0])[0]!;
  let start = Math.max(0, first[0] - SNIPPET_RADIUS);
  let end = Math.min(text.length, first[1] + SNIPPET_RADIUS);
  // Ne coupe pas un mot en deux quand c'est évitable.
  if (start > 0) {
    const sp = text.indexOf(" ", start);
    if (sp >= 0 && sp < first[0]) start = sp + 1;
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(" ", end);
    if (sp > first[1]) end = sp;
  }
  // 1 caractère remplacé par 1 caractère : les décalages des plages restent exacts.
  const slice = text.slice(start, end).replace(/[\r\n\t]/g, " ");
  const prefix = start > 0 ? "… " : "";
  const suffix = end < text.length ? " …" : "";
  const shift = prefix.length - start;
  const inside = ranges
    .filter(([a, b]) => a >= start && b <= end)
    .slice(0, MAX_RANGES)
    .map(([a, b]) => [a + shift, b + shift] as [number, number]);
  return { text: prefix + slice + suffix, ranges: mergeRanges(inside) };
}

/** Découpe `text` en segments surlignés / non surlignés pour l'affichage. */
export function splitHighlight(text: string, ranges: [number, number][]): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = [];
  let pos = 0;
  for (const [a, b] of mergeRanges(ranges)) {
    const s = Math.max(a, pos);
    if (s > pos) out.push({ text: text.slice(pos, s), mark: false });
    if (b > s) out.push({ text: text.slice(s, b), mark: true });
    pos = Math.max(pos, b);
  }
  if (pos < text.length) out.push({ text: text.slice(pos), mark: false });
  return out;
}
