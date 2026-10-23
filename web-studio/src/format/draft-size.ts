import type { ProseMirrorNode } from "./types";

/**
 * Taille approximative d'un document (octets de texte + longueur des images embarquées), obtenue
 * en un parcours sans sérialiser : sert à l'affichage dans la liste des brouillons, là où l'on
 * faisait un JSON.stringify (ou un .docx entier) uniquement pour en mesurer la longueur.
 */
export function draftSizeEstimate(doc: ProseMirrorNode): number {
  let total = 0;
  const stack: ProseMirrorNode[] = [doc];
  while (stack.length) {
    const n = stack.pop()!;
    if (typeof n.text === "string") total += n.text.length;
    const src = n.attrs?.src;
    if (typeof src === "string") total += src.length;
    if (n.content) for (const c of n.content) stack.push(c);
  }
  return total;
}
