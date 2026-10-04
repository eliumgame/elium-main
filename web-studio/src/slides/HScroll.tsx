/**
 * Bande d'outils à défilement horizontal avec dégradés de bord et chevrons —
 * même langage que le ruban des autres modules (`.elx-ribbon__scroller` /
 * `.elx-ribbon__nudge`, src/ui/workspace.css) et même crochet
 * (`useRibbonScroll`). Les popovers de la barre sont rendus dans <body>
 * (voir ToolbarPopover), donc `overflow-x: auto` ne les rogne pas.
 */
import { useEffect, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRibbonScroll } from "../ui/useRibbonScroll";

export default function HScroll({
  className = "",
  bodyClassName = "",
  children,
}: {
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const { ref, edges, nudge, sync } = useRibbonScroll();
  // Le contenu change avec la sélection (barre contextuelle) : on resynchronise
  // les chevrons quand le DOM de la bande est modifié.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof MutationObserver !== "function") return;
    let raf = 0;
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(sync);
    });
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
    };
  }, [ref, sync]);

  return (
    <div
      className={`elx-ribbon__scroller sv-hs${edges.left ? " has-left" : ""}${edges.right ? " has-right" : ""} ${className}`}
    >
      {edges.left && (
        <button
          type="button"
          className="elx-ribbon__nudge elx-ribbon__nudge--left"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => nudge(-1)}
          title="Commandes précédentes"
          aria-label="Commandes précédentes"
        >
          <ChevronLeft size={15} />
        </button>
      )}
      {edges.right && (
        <button
          type="button"
          className="elx-ribbon__nudge elx-ribbon__nudge--right"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => nudge(1)}
          title="Commandes suivantes"
          aria-label="Commandes suivantes"
        >
          <ChevronRight size={15} />
        </button>
      )}
      <div className={`sv-hs__body ${bodyClassName}`} ref={ref}>
        {children}
      </div>
    </div>
  );
}
