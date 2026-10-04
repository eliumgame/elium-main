import { useEffect, type RefObject } from "react";

/**
 * Les panneaux déroulants d'un ruban (bibliothèque de formules, figer les volets,
 * tampons…) sont posés en `position: absolute` dans un ruban qui défile
 * (`overflow-x: auto`, donc aussi rogné en hauteur) : ils étaient coupés net sous
 * le ruban. Ce crochet les sort du flux de défilement : tout panneau qui apparaît
 * sous `host` est placé en `position: fixed`, ancré sous son déclencheur (le parent
 * direct du panneau), puis ramené dans le cadre visible.
 *
 * Le conteneur `.pdfx` / `.sheet-app` déclare `container-type: size`, donc sert de
 * bloc englobant aux éléments fixes : on soustrait sa position pour ne pas dépendre
 * d'un éventuel décalage.
 */
const MENU = ".elx-menu, .pdfx-menu, .pdfx-stampmenu__panel";
const FRAME = ".pdfx, .sheet-app, .elx";
const GAP = 4;
const EDGE = 8;

function place(menu: HTMLElement) {
  const anchor = menu.parentElement;
  if (!anchor) return;
  const frame = menu.closest<HTMLElement>(FRAME);
  const fr = frame?.getBoundingClientRect();
  const originX = fr?.left ?? 0;
  const originY = fr?.top ?? 0;
  const frameW = fr?.width ?? window.innerWidth;
  const frameH = fr?.height ?? window.innerHeight;
  const a = anchor.getBoundingClientRect();

  menu.style.position = "fixed";
  menu.style.right = "auto";
  menu.style.bottom = "auto";
  const top = a.bottom - originY + GAP;
  menu.style.top = `${top}px`;
  menu.style.maxHeight = `${Math.max(120, frameH - top - EDGE)}px`;
  menu.style.maxWidth = `${frameW - 2 * EDGE}px`;

  const w = menu.offsetWidth;
  const alignRight = menu.classList.contains("elx-menu--right") || menu.classList.contains("pdfx-menu--right");
  let left = alignRight ? a.right - originX - w : a.left - originX;
  left = Math.min(left, frameW - w - EDGE);
  left = Math.max(left, EDGE);
  menu.style.left = `${left}px`;
}

export function useFixedPopovers(host: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const sweep = () => root.querySelectorAll<HTMLElement>(MENU).forEach(place);
    const mo = new MutationObserver(sweep);
    mo.observe(root, { childList: true, subtree: true });
    // Le ruban défile et la fenêtre se redimensionne : le panneau suit son déclencheur.
    root.addEventListener("scroll", sweep, { capture: true, passive: true });
    window.addEventListener("resize", sweep);
    return () => {
      mo.disconnect();
      root.removeEventListener("scroll", sweep, { capture: true });
      window.removeEventListener("resize", sweep);
    };
  }, [host]);
}
