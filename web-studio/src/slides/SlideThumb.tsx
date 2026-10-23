/**
 * Miniature de diapositive pour la rampe et le trieur.
 *
 * Anti-gel : (1) `memo` — une diapositive inchangée (même référence) n'est pas re-rendue quand une
 * autre change ; (2) rendu par fenêtre — le canevas n'est monté que lorsque la miniature est proche
 * de la zone visible (IntersectionObserver avec marge), sinon un cadre vide de même taille garde la
 * mise en page. Sans IntersectionObserver (tests jsdom), la miniature est montée directement.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import SlideCanvas from "./canvas";
import { elementsOf, type Slide, type SlideTheme } from "./model";

/** Marge autour de la zone visible dans laquelle les miniatures sont déjà montées (px). */
export const THUMB_ROOT_MARGIN = "400px 300px";

export interface SlideThumbProps {
  slide: Slide;
  theme: SlideTheme;
  scale: number;
  slideNumber: number;
}

/**
 * File de montage : une ouverture de panneau ou un défilement rapide rend visibles des dizaines de
 * miniatures d'un coup ; les monter toutes dans la même tâche figerait l'interface. Elles sont montées
 * par petites tranches (~8 ms), la main étant rendue au navigateur entre deux.
 */
const mountQueue: Array<() => void> = [];
let draining = false;
function drainQueue() {
  const start = performance.now();
  while (mountQueue.length && performance.now() - start < 8) mountQueue.shift()!();
  if (mountQueue.length) setTimeout(drainQueue, 0);
  else draining = false;
}
function scheduleMount(fn: () => void): () => void {
  mountQueue.push(fn);
  if (!draining) {
    draining = true;
    setTimeout(drainQueue, 0);
  }
  return () => {
    const i = mountQueue.indexOf(fn);
    if (i >= 0) mountQueue.splice(i, 1);
  };
}

function SlideThumbImpl({ slide, theme, scale, slideNumber }: SlideThumbProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    let cancel: (() => void) | null = null;
    const io = new IntersectionObserver(
      (entries) => {
        cancel?.();
        cancel = null;
        if (entries[entries.length - 1].isIntersecting) cancel = scheduleMount(() => setNear(true));
        else setNear(false);
      },
      { rootMargin: THUMB_ROOT_MARGIN },
    );
    io.observe(node);
    return () => {
      cancel?.();
      io.disconnect();
    };
  }, []);
  const elements = useMemo(() => slide.elements ?? elementsOf(slide), [slide]);
  return (
    <span ref={ref} className="lazy-thumb">
      {near && <SlideCanvas slide={slide} elements={elements} theme={theme} scale={scale} slideNumber={slideNumber} />}
    </span>
  );
}

const SlideThumb = memo(SlideThumbImpl);
export default SlideThumb;
