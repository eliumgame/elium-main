/**
 * Mémoïsation par document ProseMirror. Un document est immuable : tant que `state.doc` ne change
 * pas, un balayage (renvois, notes, légendes, index) donne le même résultat. Les vues de nœud
 * (une par renvoi, par note, par légende…) le redemandaient chacune à chaque mise à jour, soit
 * autant de parcours complets du document que d'éléments. Avec ce cache, il n'y en a qu'un par
 * transaction, partagé par toutes les vues.
 */
const store = new WeakMap<object, Map<string, unknown>>();

export function memoByDoc<T>(doc: object, key: string, compute: () => T): T {
  let perDoc = store.get(doc);
  if (!perDoc) store.set(doc, (perDoc = new Map()));
  if (perDoc.has(key)) return perDoc.get(key) as T;
  const value = compute();
  perDoc.set(key, value);
  return value;
}
