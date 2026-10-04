/**
 * Annonces pour lecteurs d'écran : une région `aria-live` unique, créée à la
 * demande et masquée visuellement. Sert aux éditeurs « canevas » (grille du
 * Tableur, diapositives, visionneuse PDF) dont les changements de sélection
 * n'ont pas de nœud DOM focalisé à annoncer. Sans effet hors navigateur.
 */

let polite: HTMLElement | null = null;
let assertive: HTMLElement | null = null;
const pending = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function region(kind: "polite" | "assertive"): HTMLElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  const current = kind === "polite" ? polite : assertive;
  if (current && current.isConnected) return current;
  const el = document.createElement("div");
  el.className = "sr-only elx-announcer";
  el.setAttribute("aria-live", kind);
  el.setAttribute("aria-atomic", "true");
  el.setAttribute("role", kind === "assertive" ? "alert" : "status");
  // Même contenu masqué que `.sr-only`, en ligne pour ne dépendre d'aucune feuille de style.
  el.style.cssText =
    "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0";
  document.body.appendChild(el);
  if (kind === "polite") polite = el;
  else assertive = el;
  return el;
}

/** Annonce `message`. Deux appels identiques d'affilée sont tous deux lus (le contenu est vidé puis réécrit). */
export function announce(message: string, priority: "polite" | "assertive" = "polite"): void {
  const el = region(priority);
  if (!el) return;
  const prev = pending.get(el);
  if (prev) clearTimeout(prev);
  el.textContent = "";
  pending.set(
    el,
    setTimeout(() => {
      el.textContent = message;
    }, 30),
  );
}
