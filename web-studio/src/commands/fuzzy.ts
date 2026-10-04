/**
 * Correspondance « floue » de la palette de commandes : les lettres de la
 * requête doivent apparaître DANS L'ORDRE dans le libellé (pas forcément
 * collées), insensible à la casse et aux accents. Pur.
 */
import { foldChar } from "../workspace/search/text";

export interface FuzzyMatch {
  score: number;
  /** Indices (dans le texte original) des caractères trouvés, pour les surligner. */
  indices: number[];
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/**
 * Score d'une correspondance (plus haut = meilleur) ou null. Favorise : début
 * de mot, caractères consécutifs, début de texte, correspondance exacte de sous-chaîne.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = [...query].map(foldChar).filter((c) => c.trim() !== "");
  if (q.length === 0) return { score: 0, indices: [] };
  const t = [...text].map(foldChar);
  // 1) sous-chaîne contiguë : meilleur cas
  const joined = q.join("");
  const hay = t.join("");
  const at = hay.indexOf(joined);
  if (at >= 0) {
    const bonus = (at === 0 ? 40 : 0) + (isWordChar(text[at - 1]) ? 0 : 25);
    return { score: 100 + bonus - Math.min(at, 30), indices: Array.from({ length: joined.length }, (_, i) => at + i) };
  }
  // 2) sous-séquence, avec glouton + retour pour préférer les débuts de mots
  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const qc of q) {
    let found = -1;
    // d'abord un début de mot proche, sinon le premier caractère égal
    for (let j = ti; j < t.length; j++) {
      if (t[j] !== qc) continue;
      if (found < 0) found = j;
      if (!isWordChar(text[j - 1])) {
        found = j;
        break;
      }
      if (j - ti > 12) break;
    }
    if (found < 0) return null;
    score += 10 + (found === prev + 1 ? 15 : 0) + (!isWordChar(text[found - 1]) ? 12 : 0);
    indices.push(found);
    prev = found;
    ti = found + 1;
  }
  return { score: score - Math.min(indices[0]!, 20), indices };
}

export interface Rankable {
  id: string;
  label: string;
  /** Mots-clés supplémentaires (synonymes), cherchés après le libellé. */
  keywords?: string;
}

export interface Ranked<T> {
  item: T;
  score: number;
  /** Indices à surligner dans le libellé (vide si trouvé via les mots-clés). */
  indices: number[];
}

/**
 * Filtre et classe. Sans requête : les commandes récentes d'abord (dans leur
 * ordre de récence), puis l'ordre d'origine.
 */
export function rankCommands<T extends Rankable>(items: T[], query: string, recentIds: string[] = []): Ranked<T>[] {
  const q = query.trim();
  if (!q) {
    const rank = (id: string) => {
      const i = recentIds.indexOf(id);
      return i < 0 ? Infinity : i;
    };
    return items
      .map((item, order) => ({ item, score: 0, indices: [] as number[], order }))
      .sort((a, b) => rank(a.item.id) - rank(b.item.id) || a.order - b.order)
      .map(({ item, score, indices }) => ({ item, score, indices }));
  }
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const m = fuzzyMatch(q, item.label);
    if (m) {
      const recent = recentIds.indexOf(item.id);
      out.push({ item, score: m.score + (recent >= 0 ? Math.max(0, 8 - recent) : 0), indices: m.indices });
      continue;
    }
    const k = item.keywords ? fuzzyMatch(q, item.keywords) : null;
    if (k) out.push({ item, score: k.score - 40, indices: [] });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Met `id` en tête des commandes récentes (sans doublon, borné). */
export function pushRecent(recent: string[], id: string, max = 8): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, max);
}
