/**
 * Le contenu des cellules du tableur en CRDT **par caractère**.
 *
 * Jusqu'ici chaque cellule était une chaîne dans un `Y.Map` : toute écriture
 * remplaçait la valeur entière, donc deux personnes tapant dans la **même**
 * cellule s'écrasaient l'une l'autre — le dernier à écrire gagnait, et la frappe
 * de l'autre disparaissait sans trace. Chaque cellule est maintenant un `Y.Text`,
 * si bien que deux insertions à des endroits différents de la même formule
 * fusionnent, et que seul un vrai conflit sur le même caractère est arbitré par
 * Yjs.
 *
 * **Migration** : les documents déjà partagés contiennent des chaînes. La lecture
 * accepte donc les deux formes, et la première écriture convertit la cellule en
 * `Y.Text`. Sans cela, ouvrir un tableur existant l'aurait vidé.
 */
import * as Y from "yjs";
import { syncYText } from "./collab-slides-crdt";

/** La carte des cellules : valeurs `Y.Text` (nouveau) ou `string` (ancien). */
export type YCells = Y.Map<Y.Text | string>;

/** Vrai si la valeur est un `Y.Text` partagé. */
function isYText(v: unknown): v is Y.Text {
  return v instanceof Y.Text;
}

/**
 * Le texte d'une cellule, quelle que soit la forme stockée.
 *
 * C'est le point de passage unique de la lecture : un second chemin qui
 * n'accepterait qu'une des deux formes ferait apparaître des cellules vides
 * suivant l'ancienneté du document.
 */
export function cellText(cells: YCells | null | undefined, ref: string): string {
  const v = cells?.get(ref);
  if (v == null) return "";
  return isYText(v) ? v.toString() : String(v);
}

/** Toutes les cellules non vides, en objet simple. */
export function cellsSnapshot(cells: YCells | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cells) return out;
  for (const [ref, v] of cells.entries()) {
    const text = isYText(v) ? v.toString() : String(v ?? "");
    if (text !== "") out[ref] = text;
  }
  return out;
}

/**
 * Écrit le contenu d'une cellule en fusionnant caractère par caractère.
 *
 * `syncYText` (partagé avec les présentations) réduit le changement au plus petit
 * remplacement possible : taper au milieu n'émet pas une suppression totale suivie
 * d'une réinsertion, donc la frappe simultanée d'un pair survit.
 *
 * Doit être appelé dans un `ydoc.transact`.
 */
export function setCellText(cells: YCells, ref: string, raw: string): void {
  const next = String(raw ?? "");
  const existing = cells.get(ref);

  // Une cellule vidée disparaît de la carte : la garder ferait grossir le
  // document indéfiniment au fil des effacements.
  if (next.trim() === "") {
    if (existing != null) cells.delete(ref);
    return;
  }

  if (isYText(existing)) {
    syncYText(existing, next);
    return;
  }

  // Première écriture sur une cellule héritée (ou nouvelle) : elle devient un
  // Y.Text. Le texte est posé après insertion dans la carte, car un Y.Text n'est
  // modifiable qu'une fois rattaché au document.
  const yt = new Y.Text();
  cells.set(ref, yt);
  if (next) yt.insert(0, next);
}

/**
 * Convertit d'un coup toutes les cellules héritées en `Y.Text`.
 *
 * Appelé une fois à l'ouverture par le pair qui a le droit d'écrire : sans cette
 * passe, une cellule jamais rééditée resterait en dernier-écrivain-gagne pour
 * toujours. Rend le nombre de cellules converties.
 */
export function migrateCells(ydoc: Y.Doc, cells: YCells): number {
  const legacy: [string, string][] = [];
  for (const [ref, v] of cells.entries()) {
    if (!isYText(v)) legacy.push([ref, String(v ?? "")]);
  }
  if (!legacy.length) return 0;
  ydoc.transact(() => {
    for (const [ref, text] of legacy) {
      if (text.trim() === "") {
        cells.delete(ref);
        continue;
      }
      const yt = new Y.Text();
      cells.set(ref, yt);
      yt.insert(0, text);
    }
  });
  return legacy.length;
}

/**
 * S'abonne aux changements de contenu des cellules, `Y.Text` compris.
 *
 * `Y.Map.observe` ne signale que les ajouts et suppressions de clés : la frappe
 * DANS un `Y.Text` ne le déclenche pas. Il faut `observeDeep`, sans quoi
 * l'affichage resterait figé pendant que le pair tape.
 */
export function observeCells(cells: YCells, fn: () => void): () => void {
  const handler = () => fn();
  cells.observeDeep(handler);
  return () => cells.unobserveDeep(handler);
}
