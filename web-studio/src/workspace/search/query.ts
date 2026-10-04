/**
 * Recherche dans tout l'espace : filtres du catalogue (type, dossier, étiquette,
 * date) + texte via l'index. Un élément pas encore indexé reste trouvable par
 * son titre et ses étiquettes (la recherche ne attend jamais la fin de l'indexation).
 */
import { filterItems, type ItemFilter } from "../model";
import type { WorkItem } from "../types";
import type { SearchHit, SearchIndex } from "./index";
import { foldText, queryTerms } from "./text";

export interface SearchFilters extends Omit<ItemFilter, "query" | "trashed"> {
  /** Inclure les sous-dossiers du dossier choisi. */
  includeSubfolders?: boolean;
}

export interface SearchResult {
  item: WorkItem;
  hit: SearchHit;
}

const NO_HIT: SearchHit = { id: "", score: 0, titleMatch: false, matches: 0, snippet: null, titleRanges: [] };

export function runSearch(
  index: SearchIndex,
  items: WorkItem[],
  query: string,
  filters: SearchFilters,
  /** Identifiants des dossiers à inclure (dossier choisi + descendants), si `includeSubfolders`. */
  folderScope?: Set<string>,
): SearchResult[] {
  const { includeSubfolders, folderId, ...rest } = filters;
  const scoped = filterItems(
    items,
    includeSubfolders && folderId ? rest : { ...rest, folderId },
  ).filter((i) => !i.locked && (!(includeSubfolders && folderId) || (i.folderId !== null && !!folderScope?.has(i.folderId))));
  const byId = new Map(scoped.map((i) => [i.id, i]));
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return scoped
      .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1))
      .map((item) => ({ item, hit: { ...NO_HIT, id: item.id } }));
  }
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const hit of index.search(query, new Set(byId.keys()))) {
    out.push({ item: byId.get(hit.id)!, hit });
    seen.add(hit.id);
  }
  // Pas encore indexés : titre ou étiquettes, tous les mots.
  for (const item of scoped) {
    if (seen.has(item.id) || index.has(item.id)) continue;
    const hay = foldText(`${item.title} ${item.tags.join(" ")}`);
    if (terms.every((t) => hay.includes(t))) out.push({ item, hit: { ...NO_HIT, id: item.id, score: 1, titleMatch: true } });
  }
  return out;
}
