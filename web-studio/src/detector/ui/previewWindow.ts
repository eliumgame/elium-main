/**
 * Logique pure de fenêtrage pour `DocumentPreview` : sur un document de
 * plusieurs centaines de pages (donc potentiellement des milliers de
 * paragraphes), monter tous les `<p>` d'un coup reste risqué pour la
 * fluidité. On ne rend qu'une fenêtre autour du paragraphe actif, extensible
 * par pas via "charger plus" — jamais de troncature silencieuse : `truncated`
 * dit à l'appelant d'afficher un avis.
 */

export const MAX_INITIAL_WINDOW = 400;
export const EXPAND_STEP = 400;

export interface PreviewWindow {
  start: number;
  end: number; // exclusif
  truncated: boolean;
}

export function windowAround(total: number, centerIndex: number, size = MAX_INITIAL_WINDOW): PreviewWindow {
  if (total <= size) return { start: 0, end: total, truncated: false };
  const half = Math.floor(size / 2);
  const center = Math.min(Math.max(centerIndex, 0), total - 1);
  let start = Math.max(0, center - half);
  const end = Math.min(total, start + size);
  start = Math.max(0, end - size);
  return { start, end, truncated: true };
}

export function expandStart(win: PreviewWindow, total: number, step = EXPAND_STEP): PreviewWindow {
  const start = Math.max(0, win.start - step);
  return { start, end: win.end, truncated: start > 0 || win.end < total };
}

export function expandEnd(win: PreviewWindow, total: number, step = EXPAND_STEP): PreviewWindow {
  const end = Math.min(total, win.end + step);
  return { start: win.start, end, truncated: win.start > 0 || end < total };
}

/** Étend la fenêtre pour couvrir `index` si elle ne le couvre pas déjà — utilisé
 *  quand l'utilisateur clique un finding hors de la fenêtre actuellement montée. */
export function ensureCovers(win: PreviewWindow, total: number, index: number, size = MAX_INITIAL_WINDOW): PreviewWindow {
  if (index >= win.start && index < win.end) return win;
  return windowAround(total, index, Math.max(size, win.end - win.start));
}
