/**
 * Décorations plein-document recalculées seulement là où le texte a changé.
 *
 * Un plugin qui reconstruit son `DecorationSet` à chaque transaction (parcours complet du
 * document + `DecorationSet.create` de toutes les décorations) coûte plusieurs secondes sur un
 * long document comptant des dizaines de milliers de marques. Ici l'ensemble est conservé dans
 * l'état du plugin, ajusté par `map` et ne reconstruit que les blocs de texte touchés.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface BlockRef {
  node: PMNode;
  pos: number;
}

/** Au-delà de ce nombre de blocs touchés, une reconstruction complète est plus simple et aussi rapide. */
export const MAX_INCREMENTAL_BLOCKS = 40;

/**
 * Blocs de texte (feuilles `isTextblock`) touchés par une transaction, dans le document final.
 * `null` quand il y en a trop (changement massif : l'appelant reconstruit tout).
 */
export function touchedTextblocks(tr: Transaction, skip?: (node: PMNode) => boolean): BlockRef[] | null {
  const doc = tr.doc;
  const out = new Map<number, BlockRef>();
  let overflow = false;
  const maps = tr.mapping.maps;
  for (let i = 0; i < maps.length && !overflow; i++) {
    const rest = tr.mapping.slice(i + 1);
    maps[i]!.forEach((_os, _oe, ns, ne) => {
      if (overflow) return;
      const from = Math.max(0, rest.map(ns, -1) - 1);
      const to = Math.min(doc.content.size, rest.map(ne, 1) + 1);
      doc.nodesBetween(from, to, (node, pos) => {
        if (overflow) return false;
        if (skip?.(node)) return false;
        if (node.isTextblock) {
          out.set(pos, { node, pos });
          if (out.size > MAX_INCREMENTAL_BLOCKS) overflow = true;
          return false;
        }
        return true;
      });
    });
  }
  return overflow ? null : [...out.values()];
}

/** Ajuste `set` à la transaction : reporte les décorations, puis remplace celles des blocs touchés. */
export function updateDecorations(
  set: DecorationSet,
  tr: Transaction,
  blocks: BlockRef[],
  decorate: (block: BlockRef) => Decoration[],
): DecorationSet {
  let next = set.map(tr.mapping, tr.doc);
  const stale: Decoration[] = [];
  const fresh: Decoration[] = [];
  for (const b of blocks) {
    stale.push(...next.find(b.pos, b.pos + b.node.nodeSize));
    fresh.push(...decorate(b));
  }
  if (stale.length) next = next.remove(stale);
  if (fresh.length) next = next.add(tr.doc, fresh);
  return next;
}
