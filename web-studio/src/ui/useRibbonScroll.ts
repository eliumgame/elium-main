import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Le ruban défile horizontalement quand il ne tient pas — mais rien ne le disait.
 *
 * `overflow-x: auto` sans indicateur, c'est la moitié de l'onglet Accueil
 * invisible et personne pour deviner qu'elle existe. Ce crochet suit la position
 * de défilement et expose de quel côté il reste des commandes, pour afficher un
 * dégradé et un chevron cliquable.
 */
export function useRibbonScroll() {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const sync = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft < max - 2 });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    // Le contenu change d'onglet en onglet et la fenêtre se redimensionne : les
    // deux modifient ce qui dépasse.
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    window.addEventListener("resize", sync);
    return () => {
      el.removeEventListener("scroll", sync);
      ro?.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [sync]);

  const nudge = useCallback((dir: -1 | 1) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.6), behavior: "smooth" });
  }, []);

  return { ref, edges, nudge, sync };
}
