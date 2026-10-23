/**
 * Remontée différée du document vers l'application. Chaque frappe produisait un `getJSON()`
 * complet puis un re-rendu de `App` ; sur un document de plusieurs centaines de pages, c'est
 * plusieurs dizaines de ms par touche. Ici la remontée est regroupée (délai de calme, avec
 * un délai maximal) et vidée de force avant tout geste qui lit le document : clic, raccourci
 * clavier à modificateur, perte du focus, enregistrement, fermeture.
 */
import type { ProseMirrorNode } from "../format/types";

export interface DocSyncOptions {
  /** Délai de calme avant la remontée (ms). */
  quietMs?: number;
  /** Délai maximal entre deux remontées pendant une frappe continue (ms). */
  maxWaitMs?: number;
}

export interface DocSync {
  /** Programme une remontée (appelé à chaque transaction qui modifie le document). */
  schedule(): void;
  /** Remonte tout de suite si une modification est en attente ; renvoie le document remonté. */
  flush(): ProseMirrorNode | undefined;
  /** Annule sans remonter. */
  cancel(): void;
  /** Vrai si une modification n'est pas encore remontée. */
  pending(): boolean;
}

let active: DocSync | null = null;

/** Vide la remontée de l'éditeur actif et renvoie le document le plus récent (ou `undefined` si rien n'était en attente). */
export function flushPendingDocChange(): ProseMirrorNode | undefined {
  return active?.flush();
}

export function createDocSync(
  read: () => ProseMirrorNode,
  emit: (doc: ProseMirrorNode) => void,
  opts: DocSyncOptions = {},
): DocSync {
  const quietMs = opts.quietMs ?? 150;
  const maxWaitMs = opts.maxWaitMs ?? 500;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let max: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;

  const clear = () => {
    if (quiet !== undefined) clearTimeout(quiet);
    if (max !== undefined) clearTimeout(max);
    quiet = max = undefined;
  };
  const flush = (): ProseMirrorNode | undefined => {
    clear();
    if (!dirty) return undefined;
    dirty = false;
    const doc = read();
    emit(doc);
    return doc;
  };
  const sync: DocSync = {
    schedule() {
      dirty = true;
      if (quiet !== undefined) clearTimeout(quiet);
      quiet = setTimeout(flush, quietMs);
      if (max === undefined) max = setTimeout(flush, maxWaitMs);
    },
    flush,
    cancel() {
      clear();
      dirty = false;
    },
    pending: () => dirty,
  };
  return sync;
}

/** Désigne l'instance dont `flushPendingDocChange` doit vider la file ; renvoie la fonction de retrait. */
export function setActiveDocSync(sync: DocSync): () => void {
  active = sync;
  return () => {
    if (active === sync) active = null;
  };
}
