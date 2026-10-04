/**
 * Compléments d'accessibilité posés depuis l'extérieur des éditeurs « canevas »,
 * sans toucher à leur code : une grille de tableur n'a pas de nœud focalisé par
 * cellule, donc un lecteur d'écran ne perçoit pas un changement de sélection.
 * On observe la référence de la cellule active (barre de formule) et on
 * l'annonce via la région `aria-live` partagée (`announce.ts`).
 */
import { announce } from "./announce";

/** Phrase lue pour une cellule : « Cellule B3, vide » / « Cellule B3 : 42 ». Pure, testée. */
export function describeCell(ref: string, content: string): string {
  const text = content.trim();
  if (!text) return `Cellule ${ref}, vide`;
  const clipped = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  return text.startsWith("=") ? `Cellule ${ref}, formule ${clipped}` : `Cellule ${ref} : ${clipped}`;
}

export function installA11yEnhancers(doc: Document = document): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = "";

  const run = () => {
    const refEl = doc.querySelector(".sheet-formula__ref");
    if (!refEl) {
      last = "";
      return;
    }
    const ref = refEl.textContent?.trim() ?? "";
    const input = doc.querySelector<HTMLInputElement>(".sheet-formula__input");
    if (!ref || ref === last) return;
    last = ref;
    // Ne parle pas par-dessus la saisie : pendant l'édition, la cellule n'a pas changé de sélection.
    announce(describeCell(ref, input?.value ?? ""));
  };

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(run, 150);
  });
  observer.observe(doc.body, { subtree: true, childList: true, characterData: true });
  return () => {
    observer.disconnect();
    clearTimeout(timer);
  };
}
